// Run against PostgreSQL/WASM without adding production frontend dependencies.
// node scripts/tests/ai-conversations-sql.mjs <scratch>/node_modules/@electric-sql/pglite/dist/index.js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { PGlite } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : '@electric-sql/pglite')
const db = new PGlite()
const migration = await readFile(new URL('../../backend/migrations/052_ai_conversations.sql', import.meta.url), 'utf8')
const source = await readFile(new URL('../../backend/internal/service/ai_conversations.go', import.meta.url), 'utf8')
const literal = (needle) => [...source.matchAll(/`([^`]+)`/g)].find((match) => match[1].includes(needle))?.[1]
await db.exec('CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(1),(2);')
await db.exec(migration); await db.exec(migration)
const conversation = (await db.query('INSERT INTO ai_conversations(user_id) VALUES(1) RETURNING id')).rows[0].id
const ownerLookup = literal('SELECT assistant_id,title')
assert.equal((await db.query(ownerLookup, [conversation, 2])).rows.length, 0, 'another account cannot start a turn')
await db.query(literal('UPDATE ai_conversations SET assistant_id'), [conversation, null, 'history', JSON.stringify({ workbook_id: 101, sheet_ids: [5] })])
assert.equal((await db.query(ownerLookup, [conversation, 1])).rows[0].context.workbook_id, 101, 'conversation context survives device changes')
const msg = { id: 'assistant-1', role: 'assistant', content: '', createdAt: 1, pendingOperations: [{ sheet_id: 5 }], applyState: 'idle' }
await db.query(literal('INSERT INTO ai_conversation_messages('), ['user-1', conversation, 'user', JSON.stringify({ id: 'user-1', role: 'user', content: 'hello', createdAt: 1 })])
await db.query(literal('INSERT INTO ai_conversation_messages('), [msg.id, conversation, 'assistant', JSON.stringify(msg)])
const insertRun = literal('INSERT INTO ai_conversation_runs(')
const run = (await db.query(insertRun, [conversation, 'request-unique', msg.id])).rows[0].id
await assert.rejects(db.query(insertRun, [conversation, 'request-unique', msg.id]), (error) => error.code === '23505', 'idempotency constraint')
await assert.rejects(db.query(insertRun, [conversation, 'second-request', msg.id]), (error) => error.code === '23505', 'one active run per conversation')
const stopLookup = literal('SELECT r.status FROM ai_conversation_runs')
assert.equal((await db.query(stopLookup, [run, conversation, 2])).rows.length, 0, 'another account cannot stop the run')
await db.query(literal("UPDATE ai_conversation_runs SET status='running'"), [run])
msg.content = 'progress survives observation disconnect'
await db.query(literal('UPDATE ai_conversation_messages SET payload='), [msg.id, JSON.stringify(msg)])
await db.query(literal('UPDATE ai_conversation_runs SET activity='), [run, '正在搜索'])
assert.equal((await db.query(literal('SELECT payload FROM ai_conversation_messages WHERE conversation_id=$1 ORDER BY seq'), [conversation])).rows[1].payload.content, msg.content)
await db.query(literal('UPDATE ai_conversation_runs SET status=$2'), [run, 'completed', '', JSON.stringify({ reply: 'done', changed_sheet_ids: [5] })])
const claimBase = literal("AND m.id=$3 AND m.role='assistant'") + literal("AND CASE WHEN jsonb_typeof(m.payload->'pendingOperations')")
assert.ok(source.includes("`','idle') = 'idle'"))
assert.ok(source.includes("claimField + `'=$5"), 'finish must require the same device claim')
const claimSQL = claimBase + " AND COALESCE(m.payload->>'applyState','idle') = 'idle' AND $5::text <> ''"
const claim = (owner, token) => db.query(claimSQL, [conversation, owner, msg.id, JSON.stringify({ applyState: 'applying', applyStateClaim: token }), token])
assert.equal((await claim(2, 'foreign-device')).affectedRows, 0, 'another account cannot claim writes')
await db.query("UPDATE ai_conversation_messages SET payload=payload - 'pendingOperations' WHERE id=$1", [msg.id])
assert.equal((await claim(1, 'no-plan-claim')).affectedRows, 0, 'text-only imported history cannot become an executable plan')
await db.query("UPDATE ai_conversation_messages SET payload=$2 WHERE id=$1", [msg.id, JSON.stringify(msg)])
assert.equal((await claim(1, 'phone-claim')).affectedRows, 1)
assert.equal((await claim(1, 'desktop-claim')).affectedRows, 0, 'a second device cannot duplicate the same plan')
const finishSQL = claimBase + " AND m.payload->>'applyStateClaim'=$5 AND m.payload->>'applyState'='applying'"
const finish = (token) => db.query(finishSQL, [conversation, 1, msg.id, JSON.stringify({ applyState: 'applied', applyStateClaim: token }), token])
assert.equal((await finish('desktop-claim')).affectedRows, 0, 'a losing device cannot release another device claim')
assert.equal((await finish('phone-claim')).affectedRows, 1)
assert.equal((await claim(1, 'third-device')).affectedRows, 0, 'history reload cannot replay applied writes')
await db.query(insertRun, [conversation, 'restart-test', msg.id])
await db.query("UPDATE ai_conversation_messages SET payload=payload || $2::jsonb WHERE id=$1", [msg.id, JSON.stringify({ applyState: 'applying', applyStateClaim: 'restart-claim' })])
await db.exec(literal("UPDATE ai_conversation_runs SET status='interrupted'"))
await db.exec(literal('UPDATE ai_conversation_messages m SET payload=payload\n'))
const runs = (await db.query('SELECT status,result FROM ai_conversation_runs ORDER BY id')).rows
assert.deepEqual(runs.map((item) => item.status), ['completed', 'interrupted'])
assert.equal(runs[0].result.reply, 'done')
assert.equal((await db.query('SELECT payload FROM ai_conversation_messages WHERE id=$1', [msg.id])).rows[0].payload.applyState, 'failed', 'a restart cannot leave a false running write indicator')
assert.equal((await claim(1, 'restart-replay')).affectedRows, 0, 'interrupted writes must not replay')
assert.equal((await db.query('SELECT count(*)::int AS count FROM ai_conversation_messages')).rows[0].count, 2, 'restart must not replay or create another prompt')
await db.query(literal('DELETE FROM ai_conversations WHERE id=$1 AND user_id=$2'), [conversation, 2])
assert.equal((await db.query('SELECT count(*)::int AS count FROM ai_conversations')).rows[0].count, 1)
await db.query(literal('DELETE FROM ai_conversations WHERE id=$1 AND user_id=$2'), [conversation, 1])
assert.equal((await db.query('SELECT count(*)::int AS count FROM ai_conversation_runs')).rows[0].count, 0, 'explicit deletion cleans up stopped history')
await db.close()
console.log('PASS: conversation migration, ownership, durable progress/results, request deduplication, active-run uniqueness, cross-device action claims, restart without replay, and owned deletion')
