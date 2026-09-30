// PostgreSQL/WASM smoke test of the actual Go query (no Docker required).
// npm install --prefix <scratch-dir> @electric-sql/pglite@0.3.14
// node scripts/tests/sheet-search-sql.mjs <scratch-dir>/node_modules/@electric-sql/pglite/dist/index.js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const provider = process.argv[2] ? pathToFileURL(process.argv[2]).href : '@electric-sql/pglite'
const { PGlite } = await import(provider)
const db = new PGlite()
const source = await readFile(new URL('../../backend/internal/repo/sheet_search_repo.go', import.meta.url), 'utf8')
const sql = source.match(/const searchSheetContentSQL = `([\s\S]*?)`/)[1]
await db.exec(`CREATE TABLE workbooks(id bigint PRIMARY KEY, deleted_at timestamptz);
CREATE TABLE sheets(id bigint PRIMARY KEY, workbook_id bigint, config jsonb);
CREATE TABLE rows(sheet_id bigint, row_index integer, data jsonb, UNIQUE(sheet_id,row_index));
INSERT INTO workbooks(id) VALUES(1); INSERT INTO sheets VALUES(1,1,'{}');`)
const escape = (text) => text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
const search = async (words, { start = 0, limit = 80, all = false, columns = [] } = {}) =>
  (await db.query(sql, [1, ['name', 'qty', 'amount'], start, words.map((word) => `%${escape(word)}%`), all, columns, limit])).rows
const snapshot = async (cells) => db.query('UPDATE sheets SET config = $1 WHERE id=1', [JSON.stringify({ univerSheetData: { cellData: cells } })])
await db.exec(`INSERT INTO rows VALUES(1,0,'{"name":"old","qty":60}'),(1,1,'{"name":"legacy-only","qty":88}'),(1,2,'{"name":"50%_discount","qty":92}');`)
await snapshot({ 0: { 0: { v: 'header' } }, 1: { 0: { v: '最新网页编辑' } }, 4: { 0: { v: 'snapshot-only' }, 2: { f: 'SUM(B5:C5)' } } })
let rows = await search(['最新'])
assert.equal(rows.length, 1); assert.equal(rows[0].row_num, 0); assert.equal(rows[0].data.qty, 60)
assert.equal((await search(['old'])).length, 0, 'snapshot must override stale stored cell')
assert.equal((await search(['legacy-only'])).length, 1, 'partial snapshot must not hide other rows')
assert.equal((await search(['snapshot-only'])).length, 1)
assert.equal((await search(['=SUM(B5:C5)'])).length, 1, 'uncached formulas are retained')
assert.equal((await search(['header'])).length, 0, 'header is not a data row')
assert.equal((await search(['50%_'])).length, 1, 'LIKE wildcards are literal')
assert.equal((await search(['最新', '60'], { all: true })).length, 1)
assert.equal((await search(['最新', 'missing'], { all: true })).length, 0)
assert.equal((await search(['最新'], { columns: ['qty'] })).length, 0)
assert.equal((await search(['legacy-only'], { start: 2 })).length, 0)
assert.equal((await search(['o'], { limit: 1 })).length, 1)
await snapshot({ 1: { 0: { v: '' } } })
assert.equal((await search(['old'])).length, 0, 'explicit clear suppresses stale value')
await snapshot({ 1: { 0: { s: 'style-only' } } })
assert.equal((await search(['old'])).length, 1, 'style-only cells do not override values')
await db.exec('DELETE FROM rows')
await db.exec(`INSERT INTO rows VALUES(1,5,'{"name":"stored-first"}'),(1,6,'{"name":"stored-next"}');`)
await snapshot({ 6: { 0: { v: 'snapshot-first' } }, bad: 'invalid', 7: null, 8: { bad: 'ignored', 999: { v: 'ignored' } } })
rows = await search(['snapshot-first']); assert.equal(rows[0].row_num, 0); assert.equal(rows[0].source_row, 5)
assert.equal((await search(['stored-next'])).length, 1)
await snapshot({ 6: { 0: { v: 'line1\nline2' }, 1: { v: false }, 2: { v: 0, f: '=1-1' } } })
assert.equal((await search(['line1\nline2'])).length, 1, 'decoded text, not raw JSON substrings')
assert.equal((await search(['false'])).length, 1); assert.equal((await search(['0'])).length, 1)
await db.exec('UPDATE workbooks SET deleted_at=now()')
assert.equal((await search(['line1'])).length, 0, 'deleted workbooks cannot be searched')
await db.close()
console.log('PASS: 22 snapshot-overlay SQL checks (latest edits, partials, formulas, clears, cursors, permissions narrowing, literals, malformed data, recycle bin)')
