// Summarize go test JSON without concealing failures or flooding the console.
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const result = spawnSync('go', ['test', '-json', './...'], {
  cwd: path.resolve(__dirname, '../../backend'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
})
if (result.stderr) process.stderr.write(result.stderr)
const events = (result.stdout || '').split('\n').flatMap((line) => {
  try { return [JSON.parse(line)] } catch { return [] }
})
const tests = events.filter((event) => event.Test && ['pass', 'fail', 'skip'].includes(event.Action))
const failed = tests.filter((event) => event.Action === 'fail')
console.log(`Go tests: ${tests.filter((event) => event.Action === 'pass').length} passed, ${failed.length} failed, ${tests.filter((event) => event.Action === 'skip').length} skipped`)
for (const failure of failed) {
  console.log(`FAIL ${failure.Package}/${failure.Test}`)
  for (const event of events) if (event.Package === failure.Package && event.Test === failure.Test && event.Output) process.stdout.write(event.Output)
}
if (result.status !== 0 && failed.length === 0) process.stdout.write(result.stdout || String(result.error || 'go test failed'))
process.exitCode = result.status ?? 1
