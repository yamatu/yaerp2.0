// Headless React/gesture contract tests; temporary test dependencies only.
// npm install --prefix <scratch> react@18.3.1 react-test-renderer@18.3.1
// node scripts/tests/frontend-interactions.cjs <scratch>/node_modules
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '../..')
const frontRequire = createRequire(path.join(root, 'frontend/package.json'))
const runtime = createRequire(path.join(path.resolve(process.argv[2]), '_test.cjs'))
const ts = frontRequire('typescript')
const React = runtime('react')
const { create, act } = runtime('react-test-renderer')
const storage = new Map()
const localStorage = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }
let now = 0, timerId = 0
const timers = new Map()
const clock = {
  setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, due: now + ms }); return id },
  clearTimeout(id) { timers.delete(id) },
  setInterval(fn, ms) { const id = ++timerId; timers.set(id, { fn, due: now + ms, interval: ms }); return id },
  clearInterval(id) { timers.delete(id) },
}
const listeners = new Map()
const sessionStore = new Map()
const sessionStorage = { getItem: (key) => sessionStore.get(key) ?? null, setItem: (key, value) => sessionStore.set(key, String(value)) }
const windowStub = { ...clock, sessionStorage, innerWidth: 600, innerHeight: 400,
  addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
  removeEventListener(name, fn) { listeners.get(name)?.delete(fn) } }
const documentStub = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
async function tick(ms) {
  now += ms
  for (const [id, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
    if (timer.due > now || !timers.has(id)) continue
    timers.delete(id)
    if (timer.interval) timers.set(id, { ...timer, due: now + timer.interval })
    await act(async () => { await timer.fn() })
  }
}
function compile(code, mocks = {}, extras = {}) {
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  const env = { ...clock, localStorage, window: windowStub, document: documentStub, ...extras }
  const requireMock = (name) => mocks[name] || runtime(name)
  new Function('require', 'module', 'exports', ...Object.keys(env), output)(requireMock, module, module.exports, ...Object.values(env))
  return module.exports
}
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const apiState = { items: [{ id: 1, title: 'History', assistant_id: null, updated_at: new Date().toISOString() }], messages: [], run: null, version: 1, stops: 0, requests: new Map(), posts: [], loseNextReceipt: false }
const success = (data) => ({ code: 0, data })
const api = {
  async get(url) {
    if (url === '/ai/conversations') return success(structuredClone(apiState.items))
    const id = Number(url.match(/conversations\/(\d+)/)[1])
    const version = new URLSearchParams(url.split('?')[1]).get('version')
    return success(version === String(apiState.version) ? { id, unchanged: true } : { id, version: String(apiState.version), messages: structuredClone(apiState.messages), last_run: structuredClone(apiState.run) })
  },
  async post(url, body) {
    if (url.endsWith('/stop')) { apiState.stops++; apiState.run.status = 'cancelled'; apiState.version++; return success(null) }
    if (url === '/ai/conversations') {
      const id = apiState.items.length + 1
      const item = { id, title: body.title, assistant_id: body.assistant_id, updated_at: new Date().toISOString() }
      apiState.items.unshift(item); apiState.messages = structuredClone(body.messages); apiState.run = null; apiState.version++
      return success(item)
    }
    apiState.posts.push(body.request_id)
    if (!apiState.requests.has(body.request_id)) {
      const id = Number(url.match(/conversations\/(\d+)/)[1])
      const run = { id: apiState.requests.size + 1, message_id: `assistant-${apiState.requests.size}`, status: 'running', activity: '正在检索' }
      apiState.messages.push({ id: `user-${run.id}`, role: 'user', content: body.prompt, createdAt: Date.now() }, { id: run.message_id, role: 'assistant', content: '', createdAt: Date.now() })
      apiState.requests.set(body.request_id, run); apiState.run = run; apiState.version++
      assert.equal(id, 1)
    }
    if (apiState.loseNextReceipt) { apiState.loseNextReceipt = false; throw new Error('lost receipt after server accepted') }
    return success(structuredClone(apiState.requests.get(body.request_id)))
  },
}
const { useAIConversations } = compile(source('frontend/src/hooks/useAIConversations.ts'), { '@/lib/api': api, '@/lib/dataEvents': { notifyDataChanged() {} } })
let one, two, reopened
function HookView({ device, open = true }) {
  const value = useAIConversations(1, open)
  if (device === 'one') one = value
  else if (device === 'two') two = value
  else reopened = value
  return null
}
async function testCloudObservation() {
  let first, second
  await act(async () => { first = create(React.createElement(HookView, { device: 'one' })); second = create(React.createElement(HookView, { device: 'two' })) })
  assert.equal(one.ready, true); assert.equal(two.ready, true)
  await act(async () => { await one.start('find latest data', null) })
  await tick(1000)
  assert.equal(two.messages[0].content, 'find latest data'); assert.equal(two.loading, true)
  await act(async () => { first.unmount(); second.update(React.createElement(HookView, { device: 'two', open: false })) })
  assert.equal(apiState.stops, 0); assert.equal(apiState.run.status, 'running', 'closing observers must not stop the run')
  apiState.messages[1].content = 'server finished after browser closed'
  apiState.run.status = 'completed'; apiState.version++
  let third
  await act(async () => { third = create(React.createElement(HookView, { device: 'reopened' })) })
  assert.equal(reopened.messages[1].content, 'server finished after browser closed'); assert.equal(reopened.loading, false)
  apiState.loseNextReceipt = true
  await act(async () => { await reopened.start('retry safely', null).catch(() => {}) })
  await act(async () => { await reopened.start('retry safely', null) })
  assert.equal(apiState.posts.at(-1), apiState.posts.at(-2), 'a lost receipt must reuse the same request ID')
  assert.equal(apiState.requests.size, 2, 'a retry must not add a duplicate backend turn')
  await act(async () => { await reopened.stop() })
  assert.equal(apiState.stops, 1); assert.equal(reopened.loading, false)
  await act(async () => { second.unmount(); third.unmount() })
  console.log('PASS: cloud history synchronization, observer close/reopen, submission deduplication, explicit cancellation')
}
async function testMobileControls() {
  const icons = new Proxy({}, { get: (_, name) => (props) => React.createElement('icon', { ...props, name }) })
  const mobileModule = compile(source('frontend/src/components/spreadsheet/SheetMobileControls.tsx'), { 'lucide-react': icons, '@/lib/spreadsheet': { columnIndexToLetter: (index) => String.fromCharCode(65 + index) } })
  const Mobile = mobileModule.default
  assert.equal(mobileModule.mobileCellValue('100.5', 'number'), 100.5)
  assert.equal(mobileModule.mobileCellValue('12%', 'percentage'), 0.12)
  assert.equal(mobileModule.mobileCellValue('00100', 'text'), '00100')
  assert.equal(mobileModule.mobileCellValue('false', 'checkbox'), false)
  const reads = [], focused = [], writes = [], moves = []
  let position = { row: 1, column: 0, value: 'old' }
  const props = { sheetId: 1, ready: true, editable: true, selectionEditable: true, selectionLabel: 'A2', changeToken: 'initial',
    readCells: async (commit) => { reads.push(commit); return [{ row: 1, column: 0, text: 'latest' }, { row: 9, column: 1, text: 'latest record' }] },
    focusCell: (row, column) => focused.push([row, column]),
    moveCell: async (row, column) => { moves.push([row, column]); position = { row: position.row + row, column: position.column + column, value: 'next' } },
    undo: async () => {}, redo: async () => {}, readSelected: () => ({ ...position }),
    writeSelected: async (value, expected) => { assert.equal(expected.row, position.row); assert.equal(expected.column, position.column); writes.push([value, expected.row, expected.column]) },
  }
  let renderer
  await act(async () => { renderer = create(React.createElement(Mobile, props)) })
  const button = (label) => renderer.root.findByProps({ 'aria-label': label })
  await act(async () => { button('搜索当前表内容').props.onClick() })
  await act(async () => { renderer.root.findByProps({ type: 'search' }).props.onChange({ target: { value: 'latest' } }) })
  await tick(180)
  assert.deepEqual(focused.at(-1), [1, 0])
  await act(async () => { button('下一个搜索结果').props.onClick() })
  assert.deepEqual(focused.at(-1), [9, 1])
  await act(async () => { renderer.update(React.createElement(Mobile, { ...props, changeToken: 'saved' })) })
  assert.deepEqual(reads, [true, false], 'automatic refresh must not commit an unfinished cell editor')
  await tick(180)
  assert.equal(focused.length, 2, 'a background refresh must not move the selection back to the first result')
  assert.match(renderer.root.findByProps({ 'aria-live': 'polite' }).children.join(''), /^2 \/ 2/, 'a background refresh keeps the current result')
  let reopened
  await act(async () => { reopened = create(React.createElement(Mobile, props)) })
  await tick(180)
  assert.equal(reopened.root.findByProps({ type: 'search' }).props.value, 'latest', 'reopening a sheet restores its search box and query')
  assert.equal(focused.length, 2, 'restoring the search must not move the selection')
  await act(async () => { reopened.root.findByProps({ 'aria-label': '下一个搜索结果' }).props.onClick() })
  assert.deepEqual(focused.at(-1), [9, 1], 'the remembered result is selected first after reopening')
  await act(async () => { reopened.unmount() })
  await act(async () => { button('关闭搜索').props.onClick(); button('虚拟方向键').props.onClick() })
  await act(async () => { button('编辑选中单元格').props.onClick() })
  await act(async () => { renderer.root.findByType('input').props.onChange({ target: { value: 'new value' } }) })
  await act(async () => { button('右一个单元格').props.onClick() })
  assert.deepEqual(writes[0], ['new value', 1, 0], 'editing must be saved to the old cell before navigation')
  assert.deepEqual(moves[0], [0, 1]); assert.equal(renderer.root.findByType('input').props.value, 'next')
  assert.equal(renderer.root.findByProps({ 'data-sheet-mobile-controls': true }).props.style.bottom, 112, 'editing controls must not be hidden behind the edit form')
  await act(async () => { renderer.unmount() })
  console.log('PASS: current-sheet content search/navigation, safe index refresh, save-before-arrow continuous editing, compact controls, numeric/percentage/checkbox input types')
}
function testTouchPanScope() {
  const file = ts.createSourceFile('editor.tsx', source('frontend/src/components/spreadsheet/UniverSheetEditor.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const fn = file.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === 'attachUniverTouchPanning')
  const handlers = new Map(), events = [], frames = new Set()
  class ElementStub { constructor(canvas) { this.canvas = canvas } closest() { return this.canvas ? this : null } }
  class EventStub { constructor(type, args) { this.type = type; Object.assign(this, args) } }
  const canvas = new ElementStub(true); canvas.dispatchEvent = (event) => events.push(event)
  const rootStub = { addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: (name) => handlers.delete(name) }
  const attach = compile(`${fn.getText(file)}\nmodule.exports = attachUniverTouchPanning`, {}, { Element: ElementStub, WheelEvent: EventStub, PointerEvent: EventStub, getLargestVisibleElement: () => canvas, requestAnimationFrame: () => { const id = frames.size + 1; frames.add(id); return id }, cancelAnimationFrame: (id) => frames.delete(id) })
  const dispose = attach(rootStub)
  const start = (target) => handlers.get('touchstart')({ target, touches: [{ clientX: 100, clientY: 100 }] })
  const move = () => handlers.get('touchmove')({ touches: [{ clientX: 90, clientY: 75 }], preventDefault() {} })
  start(new ElementStub(false)); move(); assert.equal(events.length, 0, 'menus/inputs must not start sheet panning')
  handlers.get('pointerdown')({ pointerId: 4, pointerType: 'touch' }); start(canvas); move()
  assert.equal(events[0].type, 'pointerup'); assert.equal(events[0].pointerId, 4)
  assert.equal(events[1].type, 'wheel'); assert.equal(events[1].deltaY, 25)
  handlers.get('touchend')(); assert.equal(frames.size, 1)
  handlers.get('yaerp-stop-touch-pan')(); assert.equal(frames.size, 0)
  dispose(); assert.equal(handlers.size, 0)
  console.log('PASS: canvas-only touch panning, selection termination, navigation stopping momentum, listener cleanup')
}
async function testDragCapture() {
  const { useFloatingDrag } = compile(source('frontend/src/hooks/useFloatingDrag.ts'))
  let captured = false, releases = 0, prevented = 0, hook
  const handle = { setPointerCapture() { captured = true }, hasPointerCapture() { return captured }, releasePointerCapture() { releases++; captured = false } }
  const elementRef = { current: { offsetWidth: 100, offsetHeight: 50, getBoundingClientRect: () => ({ left: 50, top: 60 }) } }
  function DragView() { hook = useFloatingDrag({ elementRef, ignoreInteractive: false }); return null }
  let renderer
  await act(async () => { renderer = create(React.createElement(DragView)) })
  await act(async () => { hook.handleProps.onPointerDown({ button: 0, pointerId: 1, clientX: 50, clientY: 60, currentTarget: handle, stopPropagation() {} }) })
  assert.equal(captured, true)
  await act(async () => { for (const fn of listeners.get('pointermove')) fn({ pointerId: 1, clientX: 150, clientY: 170, cancelable: true, preventDefault() { prevented++ } }) })
  assert.deepEqual(hook.position, { x: 150, y: 170 }); assert.equal(prevented, 1)
  await act(async () => { for (const fn of listeners.get('pointerup')) fn({ pointerId: 1 }) })
  assert.equal(releases, 1)
  let swallowed = 0
  hook.handleProps.onClickCapture({ preventDefault() { swallowed++ }, stopPropagation() {} })
  assert.equal(swallowed, 1)
  await act(async () => { renderer.unmount() })
  assert.equal(listeners.get('pointermove').size, 0)
  console.log('PASS: stable drag-handle capture, full movement, pointer release and trailing-click suppression')
}
function testSupplierQuoteImport() {
  const { parseSupplierQuoteText } = compile(source('frontend/src/lib/supplierQuoteImport.ts'))
  const items = [
    { id: 11, line_no: 1, sku: 'A-001', product_name: 'Cable' },
    { id: 12, line_no: 2, sku: 'A-002', product_name: 'Plug' },
    { id: 13, line_no: 3, sku: '', product_name: 'Adapter' },
  ]
  const suppliers = [{ id: 7, name: '华强电子', company_name: '深圳华强电子有限公司', default_currency: 'CNY' }]
  const pasted = [
    '备注\t供应商\tSKU\t单价\t交期\t有效期',
    '含税\t华强电子\ta-001\t¥1,250.5\t5-7天\t2026/12/1',
    '\t新厂家\tAdapter\tUSD 3\t\t',
    '\t\tA-002\t缺货',
    '\t华强电子\tZZZ\t9',
    '\t\tA-001\t8',
  ].join('\n')
  const { rows, headerDetected } = parseSupplierQuoteText(pasted, items, suppliers)
  assert.equal(headerDetected, true, 'a header row is recognised in any column order')
  assert.equal(rows.length, 5)
  assert.deepEqual([rows[0].item.id, rows[0].supplierID, rows[0].unitPrice, rows[0].currency, rows[0].leadTime, rows[0].validUntil, rows[0].notes, rows[0].error],
    [11, 7, '1250.5', 'CNY', '7', '2026-12-01', '含税', undefined], 'SKU match is case-insensitive, prices and dates are normalised')
  assert.deepEqual([rows[1].item.id, rows[1].supplierID, rows[1].supplierName, rows[1].supplierIsNew, rows[1].currency], [13, 0, '新厂家', true, 'USD'], 'unknown suppliers are kept by name; product names match too')
  assert.deepEqual([rows[2].item.id, rows[2].unavailable, rows[2].reason, rows[2].error], [12, true, '缺货', undefined], 'an out-of-stock price marks the item unavailable')
  assert.match(rows[3].error, /找不到产品/)
  assert.match(rows[4].error, /缺少供应商/)
  const plain = parseSupplierQuoteText('A-002, 深圳华强电子有限公司, 4.2, CNY, 500, 10', items, suppliers)
  assert.deepEqual([plain.headerDetected, plain.rows[0].item.id, plain.rows[0].supplierID, plain.rows[0].moq, plain.rows[0].leadTime], [false, 12, 7, '500', '10'], 'comma text uses the default column order and matches company names')

  const icons = new Proxy({}, { get: (_, name) => (props) => React.createElement('icon', { ...props, name }) })
  const { groupProfitWarnings } = compile(source('frontend/src/components/trade/ProfitWarnings.tsx'), { 'lucide-react': icons })
  const grouped = groupProfitWarnings(['缺少 USD 兑人民币的报价汇率', '第 1 行尚未录入对客报价', '第 2 行尚未录入对客报价', '第 3 行尚未录入对客报价', '第 5 行尚未录入对客报价', '第 4 行尚未录入采购价'])
  assert.deepEqual(grouped, ['缺少 USD 兑人民币的报价汇率', '尚未录入对客报价：第 1–3、5 行（共 4 行）', '尚未录入采购价：第 4 行（共 1 行）'])
  console.log('PASS: supplier quote paste import (header detection, SKU/name/line matching, new suppliers, unavailable items), grouped profit warnings')
}
;(async () => { await testCloudObservation(); await testMobileControls(); testTouchPanScope(); await testDragCapture(); testSupplierQuoteImport() })().catch((error) => { console.error(error); process.exitCode = 1 })
