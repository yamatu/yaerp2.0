# YaERP test-environment memory diagnosis

The repository now contains two kinds of protection:

* WebSocket queues, browser reconnect queues, request bodies, AI responses,
  PDF renderer concurrency, and backup exports are bounded.
* Optional Go runtime diagnostics expose heap and goroutine data. They are
  disabled by default.

## 1. Enable diagnostics in the test environment

Add these values to the test `.env` (use a random value, never a production
secret):

```dotenv
PPROF_ENABLED=true
PPROF_TOKEN=replace-with-a-long-random-test-token
```

Recreate only the application containers:

```bash
docker compose up -d --build backend frontend nginx
docker compose ps
```

The diagnostics endpoint is available through nginx at port `5555`:

```bash
curl -H 'X-Pprof-Token: replace-with-a-long-random-test-token' \
  http://127.0.0.1:5555/debug/metrics
```

Do not put the token in a query string: URLs can be copied to access logs and
browser history.

## 2. Establish a baseline and run a repeatable workload

Record each application container independently. `docker stats` is RSS-like
container memory (Go heap is only one part of it):

```bash
docker compose ps -q backend frontend | xargs -r docker stats --no-stream
```

PowerShell equivalent:

```powershell
docker compose ps -q backend frontend | ForEach-Object { docker stats --no-stream $_ }
```

Check whether Docker has already killed or restarted a container:

```bash
docker inspect -f '{{.Name}} restart={{.RestartCount}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}}' \
  $(docker compose ps -q backend frontend)
docker events --since 1h --filter type=container
```

`OOMKilled=true` indicates the container exceeded its cgroup limit; it does
not by itself prove an application leak. The compose file intentionally has
no hard memory limit, so a restart with `OOMKilled=false` should be checked
against process-level profiles and logs as well.

Run the same workflow 20-50 times in the test UI or with your API client:

* open and close the same workbook;
* switch sheets repeatedly;
* send a burst of cell updates;
* export XLSX/PDF a few times;
* upload/import a representative file;
* leave the browser idle for 5-10 minutes.

After every cycle, save `/debug/metrics` and the container RSS. A leak is
more likely when `heap_objects`, `heap_alloc_bytes`, or `goroutines` continue
to climb after the workload stops and a GC cycle has occurred. If Go heap is
flat but RSS remains high, inspect Chromium, Node, native allocations, or the
database/Redis/MinIO containers instead; that is not proof of a Go object leak.

## 3. Capture heap and goroutine profiles

```bash
curl -H 'X-Pprof-Token: replace-with-a-long-random-test-token' \
  -o heap-after.pb.gz \
  http://127.0.0.1:5555/debug/pprof/heap
curl -H 'X-Pprof-Token: replace-with-a-long-random-test-token' \
  -o goroutines.txt \
  http://127.0.0.1:5555/debug/pprof/goroutine?debug=2

go tool pprof -top heap-after.pb.gz
```

Capture a second heap profile after the idle period and compare the retained
objects (not `TotalAlloc`, which is expected to grow):

```bash
go tool pprof -top heap-before.pb.gz
go tool pprof -top heap-after.pb.gz
```

For a short CPU/allocation window:

```bash
curl -H 'X-Pprof-Token: replace-with-a-long-random-test-token' \
  -o profile.pb.gz \
  'http://127.0.0.1:5555/debug/pprof/profile?seconds=30'
go tool pprof -top profile.pb.gz
```

## 4. Useful signals

| Signal | What it usually means |
| --- | --- |
| `websocket_clients` stays above the number of open tabs | disconnected clients are not being removed, or the client is reconnecting unexpectedly |
| `websocket_slow_clients` rises quickly | a consumer cannot drain its outbound queue; inspect the client/network and message rate |
| `websocket_dropped_broadcasts` rises | the hub is under a burst; updates are deliberately dropped instead of accumulating unbounded memory |
| `goroutines` rises with each connect/disconnect cycle | a pump, timer, or reconnect callback is being retained |
| Go heap returns near baseline but RSS does not | allocator high-water mark or native child process; compare pprof and `docker stats` |

The test compose file does not impose an arbitrary memory limit. Add a limit
only after measuring a safe value; otherwise an OOM restart can hide the root
cause.
