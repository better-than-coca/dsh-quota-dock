'use strict'
/*
 * Offline acceptance harness for E:\dsh\dsh-quota-dock\client.js.
 * No DOM, no browser, no real network: it stubs window.__ModuleLoader__ and
 * require('react') just far enough to call the factory, then drives the exported
 * contract, the pure formatting helpers, the fill-bar maths, and real renders of
 * all three components through a mini hook runtime.
 *
 * v2.1 shape under test:
 *   - the row still lives on `conversation.input.dock` and still carries the
 *     three percentages plus the DeepSeek rate clock;
 *   - clicking the row opens a money-only sheet registered on `shell.overlay`,
 *     which renders nothing while closed and contains no credential field;
 *   - platform configuration lives on a `settings.section` page (order 23),
 *     which is the only surface that talks to the platforms endpoint.
 *
 * Run:  node test/smoke.cjs   (or: npm test)
 */
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const assert = require('node:assert/strict')

const CLIENT = path.join(__dirname, '..', 'client.js')
const NS = 'quotaDock'
const ROW_SLOT = 'conversation.input.dock'
const OVERLAY_SLOT = 'shell.overlay'
const SETTINGS_SLOT = 'settings.section'

/* ---- 1. capture the module registration ---------------------------------- */
let captured = null
const focusListeners = []
const keyListeners = []
const intervals = []
globalThis.window = {
  __ModuleLoader__: {
    load(config) { captured = config },
  },
  // Timers are recorded, never scheduled: no DOM is needed, and the harness can
  // prove that nothing polls upstream on a 5-minute cadence any more.
  setInterval: (fn, ms) => { intervals.push(ms); return 0 },
  clearInterval: () => {},
  addEventListener: (type, fn) => { (type === 'keydown' ? keyListeners : focusListeners).push(fn) },
  removeEventListener: () => {},
}

const source = fs.readFileSync(CLIENT, 'utf8')
const lineCount = source.split('\n').length - (source.endsWith('\n') ? 1 : 0)
vm.runInThisContext(source, { filename: CLIENT })

assert.ok(captured, 'window.__ModuleLoader__.load was never called')
assert.equal(captured.id, 'dsh-quota-dock', 'module id mismatch')
assert.equal(typeof captured.factory, 'function', 'factory missing')

/* ---- 2. minimal react, with just enough hooks to render ------------------ */
const textOf = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children ?? [])
}
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  findAll(node.children ?? [], predicate, out)
  return out
}
const find = (node, className) => findAll(node, n => n.props?.className === className)[0] ?? null
const stripOf = tree => find(tree, 'dsh-quota-dock-strip')
const stripText = tree => textOf(stripOf(tree))
const barsOf = tree => findAll(tree, n => n.props?.['data-quota-bar'] !== undefined)
const collect = (tree, className) => findAll(tree, n => n.props?.className === className)
const textIn = tree => textOf(tree)

const hooks = { slots: [], cleanups: [], cursor: 0 }
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('react.fragment'),
  useRef: initial => {
    const index = hooks.cursor++
    if (hooks.slots[index] === undefined) hooks.slots[index] = { current: initial }
    return hooks.slots[index]
  },
  useState: initial => {
    const index = hooks.cursor++
    if (hooks.slots[index] === undefined) hooks.slots[index] = initial
    return [hooks.slots[index], next => {
      hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next
    }]
  },
  // The store subscription's bump: the real hook would re-render, the harness
  // simply records it and re-renders by hand.
  useReducer: (reducer, initial) => {
    const index = hooks.cursor++
    if (hooks.slots[index] === undefined) hooks.slots[index] = initial
    return [hooks.slots[index], next => {
      hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : reducer(hooks.slots[index])
    }]
  },
  // A render-once effect is enough: the harness re-renders explicitly.
  useEffect: fn => {
    const index = hooks.cursor++
    if (hooks.slots[index] !== undefined) return
    hooks.slots[index] = true
    const cleanup = fn()
    if (typeof cleanup === 'function') hooks.cleanups.push(cleanup)
  },
}
const requireStub = name => {
  if (name === 'react') return ReactStub
  if (name === 'react-dom') return { createPortal: element => element }
  throw new Error(`unexpected require(${name})`)
}
const mod = captured.factory(requireStub)
assert.equal(typeof mod.apply, 'function', 'apply missing')
assert.deepEqual(mod.inject, ['slots', 'locale'], 'service injection list mismatch')

/* ---- 3. fake ctx: three slots, one dictionary, a live locale bind -------- */
const injected = []
const slots = []
const locales = []
const effects = []
const dictionaries = {}
const boundNamespaces = []
const ctx = {
  effect(fn, label) {
    effects.push(label)
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register(namespace, dictionary) {
      dictionaries[namespace] = dictionary
      locales.push({ namespace, dictionary })
      return () => {}
    },
    bind(namespace) {
      boundNamespaces.push(namespace)
      // Re-read on every call, exactly like the real bound lookup.
      return key => dictionaries[namespace]?.['zh']?.[key]
    },
  },
  get() { return undefined },
  slots: {
    inject(name, factory) {
      injected.push(name)
      const before = slots.length
      const result = factory()
      for (let index = before; index < slots.length; index += 1) slots[index].slotName = name
      return result
    },
    register(config, component) { slots.push({ config, component }); return () => {} },
  },
}
mod.apply(ctx)

assert.deepEqual(injected, [ROW_SLOT, OVERLAY_SLOT, SETTINGS_SLOT], 'slots.inject targets mismatch')
assert.equal(slots.length, 3, `expected exactly three registered slots, got ${slots.length}`)
const rowSlot = slots.find(entry => entry.slotName === ROW_SLOT)
const overlaySlot = slots.find(entry => entry.slotName === OVERLAY_SLOT)
const settingsSlot = slots.find(entry => entry.slotName === SETTINGS_SLOT)

assert.equal(rowSlot.config.name, ROW_SLOT, 'row slot name mismatch')
assert.equal(rowSlot.config.order, -1, 'row order must be -1 (the input dock list first entry)')
assert.equal(rowSlot.config.id, 'quota-dock', 'row slot id mismatch')
assert.equal(rowSlot.config.locale, NS, 'row slot locale namespace mismatch')
assert.equal(typeof rowSlot.component, 'function', 'row component must be a function')
const injectedProps = rowSlot.config.inject()
assert.equal(typeof injectedProps.load, 'function', 'inject() must expose load()')

assert.equal(overlaySlot.config.id, 'quota-dock-sheet', 'overlay slot id mismatch')
assert.equal(typeof overlaySlot.config.label, 'function', 'the overlay label must be a thunk')
assert.equal(overlaySlot.config.label(), '额度与余额', 'the overlay label must read the current language')
assert.equal(typeof overlaySlot.component, 'function', 'sheet component must be a function')

assert.equal(settingsSlot.config.id, 'quota-dock', 'settings slot id mismatch')
assert.equal(settingsSlot.config.order, 23, 'settings order must sit next to claude-style (22)')
assert.equal(typeof settingsSlot.config.label, 'function', 'the settings label must be a thunk')
assert.equal(settingsSlot.config.label(), '额度与平台', 'the settings label must read the current language')
assert.equal(typeof settingsSlot.component, 'function', 'settings component must be a function')
assert.deepEqual(boundNamespaces, [NS], 'the label thunks must come from ctx.locale.bind(NS)')

assert.equal(locales.length, 1, 'expected exactly one locale registration')
assert.equal(locales[0].namespace, NS, 'locale namespace mismatch')
for (const key of ['en', 'zh']) {
  assert.ok(locales[0].dictionary[key], `locale dictionary missing "${key}"`)
  for (const field of ['fiveHour', 'weekly', 'monthly', 'deepseek', 'used', 'loading', 'noKey',
    'sheetTitle', 'settingsTitle', 'settingsHint', 'platformsInSettings', 'refresh',
    'monthTotal', 'monthUsed', 'monthRemaining', 'periodEnd', 'plan', 'close', 'add', 'remove']) {
    assert.ok(locales[0].dictionary[key][field], `locale ${key} missing key "${field}"`)
  }
  assert.equal('remaining' in locales[0].dictionary[key], false, `locale ${key} must not keep a remaining key`)
}

/* ---- 4. the live figure shape the row must carry ------------------------ */
const fixture = {
  ok: true,
  fetchedAt: 1760000000000,
  ageMs: 12345,
  stale: false,
  fetching: false,
  error: null,
  cc: {
    ok: true,
    error: null,
    windows: [
      { id: 'fiveHour', used: 0.8178950338, cap: 14, resetAt: '2026-10-18T03:00:00.000Z', error: null },
      { id: 'weekly', used: 4.2, cap: 30, resetAt: '2026-10-21T00:00:00.000Z', error: null },
      { id: 'monthly', used: 8.1966043919, cap: 69.9687830847, resetAt: '2026-11-01T00:00:00.000Z', error: null },
    ],
    // The Host still sends it; the row deliberately does not print it.
    remainingMonthlyCredits: 61.7721786928,
    usedMonthlyCredits: 8.1966043919,
    monthlyCap: 69.9687830847,
    credits: {
      monthlyCredits: 61.7721786928,
      purchasedCredits: 0,
      freeCredits: 0,
      belowThreshold: false,
      creditThreshold: 0,
    },
    subscription: {
      status: 'active',
      planId: 'individual-goat',
      currentPeriodStart: '2026-10-14T02:59:38.000Z',
      currentPeriodEnd: '2026-11-14T02:59:38.000Z',
    },
  },
  deepseek: {
    ok: true,
    error: null,
    isAvailable: true,
    balances: [
      { currency: 'CNY', totalBalance: '39.62', grantedBalance: '0.00', toppedUpBalance: '39.62' },
    ],
  },
  platforms: [
    { id: 'p1', name: 'OpenRouter', kind: 'openrouter', hasKey: true, ok: true, fetchedAt: 1760000000000,
      fields: [{ label: '余额', value: '12.5' }] },
  ],
}

const zh = key => mod.LOCALES.zh[key]
const PEAK_AT = new Date(2026, 9, 19, 9, 0, 0) // Mon 09:00 → 30 min into the 16h 峰
const OFF_AT = new Date(2026, 9, 19, 2, 0, 0) // Mon 02:00 → 90 min into the 8h 谷
const strip = mod.formatStrip(fixture, zh, PEAK_AT)
assert.equal(strip, '5h 6% 周 14% 月 12% 峰时 · 距谷 15h30m', 'strip shape drifted')
assert.equal(mod.formatStrip(fixture, zh, OFF_AT), '5h 6% 周 14% 月 12% 谷时 · 距峰 6h30m', 'the countdown must follow the clock')
assert.equal(mod.formatStrip(fixture, zh, new Date(2026, 9, 17, 12, 0, 0)), '5h 6% 周 14% 月 12% 谷时 · 全天谷价', 'a weekend must read 谷 all day')
assert.equal(strip.includes('余'), false, `the row must not print a 余 column: ${strip}`)
assert.ok(/5h \d+% 周 \d+% 月 \d+% (峰时|谷时)/.test(strip), `cells must be space-separated: ${strip}`)
assert.equal(strip.includes('/'), false, `the row shows percentages, not used/cap: ${strip}`)
for (const needle of ['6%', '14%', '12%', '峰时']) {
  assert.ok(strip.includes(needle), `strip is missing "${needle}": ${strip}`)
}
for (const label of ['5h', '周', '月']) {
  assert.ok(strip.includes(label), `strip is missing the "${label}" label: ${strip}`)
}
assert.equal(strip.includes('DS'), false, `the row drops the DS prefix on purpose: ${strip}`)
assert.equal(mod.formatStrip(fixture, undefined, PEAK_AT), strip, 'default locale fallback must be the zh dictionary')
assert.equal(mod.hasNumbers(fixture), true, 'fixture must count as having numbers')

/* ---- 5. the no-crash contract: null / NaN / missing -> — ---------------- */
const broken = {
  ok: true,
  fetchedAt: 1,
  stale: true,
  fetching: false,
  error: 'boom',
  cc: {
    ok: false,
    error: 'COMMANDCODE_API_KEY 未配置',
    windows: [
      { id: 'fiveHour', used: null, cap: NaN, resetAt: null, error: null },
      { id: 'weekly', used: undefined, cap: 'nope', resetAt: null, error: null },
    ],
    remainingMonthlyCredits: null,
  },
  deepseek: { ok: false, error: 'DEEPSEEK_API_KEY 未配置', balances: [] },
}
const brokenStrip = mod.formatStrip(broken, zh, PEAK_AT)
for (const bad of ['undefined', 'NaN', 'null', '[object']) {
  assert.ok(!brokenStrip.includes(bad), `broken strip leaked "${bad}": ${brokenStrip}`)
}
assert.equal(brokenStrip, '5h — 周 — 月 — 峰时 · 距谷 15h30m', 'missing-key wording drifted')
assert.equal(mod.hasNumbers(broken), false, 'broken snapshot must not count as having numbers')

const partial = {
  ok: true,
  fetchedAt: 1,
  cc: { ok: false, error: 'timeout', windows: [] },
  deepseek: { ok: true, balances: [{ currency: 'USD', totalBalance: '1.5' }] },
}
const partialStrip = mod.formatStrip(partial, zh, PEAK_AT)
assert.equal(partialStrip, '5h — 周 — 月 — 峰时 · 距谷 15h30m', 'partial strip drifted')
for (const bad of ['undefined', 'NaN', '余']) assert.ok(!partialStrip.includes(bad), `partial strip leaked "${bad}"`)

assert.equal(mod.formatStrip(null, zh), '查询中…', 'no snapshot must read 查询中…')
assert.equal(mod.formatStrip(null, key => mod.LOCALES.en[key]), 'Checking…', 'en loading text drifted')

/* ---- 5b. the fill maths: clamp(used / cap * 100, 0, 100), tiers 80/95 --- */
const near = (value, expected, label) => {
  assert.ok(Math.abs(value - expected) < 1e-6, `${label}: ${value} !== ${expected}`)
}
near(mod.barPercent(0.8178950338, 14), 5.842107384285714, 'fiveHour fill')
near(mod.barPercent(4.2, 30), 14, 'weekly fill')
near(mod.barPercent(8.1966043919, 69.9687830847), 11.714659067283883, 'monthly fill')
near(mod.barPercent(61.7721786928, 61.7721786928), 100, 'at cap is full')
near(mod.barPercent(80, 50), 100, 'over cap clamps to 100')
near(mod.barPercent(-3, 50), 0, 'negative clamps to 0')
assert.equal(mod.barPercent(null, 10), null, 'missing used has no fill')
assert.equal(mod.barPercent(5, null), null, 'missing cap has no fill')
assert.equal(mod.barPercent(5, 0), null, 'zero cap has no fill')
assert.equal(mod.barPercent('', 'nope'), null, 'unparsable sides have no fill')
assert.deepEqual(
  [mod.barLevel(mod.barPercent(10, 100)), mod.barLevel(mod.barPercent(80, 100)),
    mod.barLevel(mod.barPercent(94.99, 100)), mod.barLevel(mod.barPercent(95, 100)),
    mod.barLevel(mod.barPercent(150, 100)), mod.barLevel(null)],
  ['ok', 'warn', 'warn', 'high', 'high', 'unknown'],
  'fill tiers must step at 80% and 95%')

/* ---- 5c. the reset instants arrive as ISO strings ----------------------- */
const SHEET_NOW = new Date('2026-10-18T01:30:00.000Z')
assert.equal(mod.toMs('2026-10-18T03:00:00.000Z'), Date.parse('2026-10-18T03:00:00.000Z'), 'an ISO resetAt must parse')
assert.equal(mod.toMs(1760000000000), 1760000000000, 'epoch ms must pass through')
assert.equal(mod.toMs(null), null, 'a missing instant stays null')
assert.equal(mod.fmtCountdown('2026-10-18T03:00:00.000Z', SHEET_NOW), '1h30m', 'an ISO resetAt must yield a countdown')
assert.equal(mod.fmtCountdown('2026-01-01T00:00:00.000Z', SHEET_NOW), null, 'a past instant has no countdown')
assert.match(mod.fmtClock('2026-11-14T02:59:38.000Z'), /^\d{2}-\d{2} \d{2}:\d{2}$/, 'an ISO period end must format')

/* ---- 6. render the row through the mini hook runtime -------------------- */
const tick = () => new Promise(resolve => { setTimeout(resolve, 0) })
const render = props => { hooks.cursor = 0; return rowSlot.component(props) }
// Same discipline for the other two slots: every render restarts the hook cursor.
const renderSlot = (component, props) => { hooks.cursor = 0; return component(props) }
const resetInstance = () => {
  hooks.slots = []
  hooks.cleanups = []
  hooks.cursor = 0
  mod.store.listeners.clear()
}
const settleStore = patch => {
  mod.store.listeners.clear()
  mod.publish({ snapshot: null, phase: 'loading', panelOpen: false, now: Date.now(), ...patch })
}
const mount = async (snapshot, patch = {}) => {
  resetInstance()
  settleStore(patch)
  render({ load: async () => snapshot, t: zh })
  await tick()
  return render({ load: async () => snapshot, t: zh })
}

// The rendered row reads the live clock, so its DeepSeek tail is asserted by shape.
const CYCLE_TAIL = /(峰时|谷时) · (距[峰谷] (?:\d+h)?\d+m|全天谷价)$/

async function main() {
  // 6a: a pending load paints 查询中…, and the row is never blank.
  resetInstance()
  settleStore()
  const loadingTree = render({ load: () => new Promise(() => {}), t: zh })
  assert.equal(stripText(loadingTree), '查询中…', 'pending load must read 查询中…')

  // 6b: numbers land — three bars AND the concrete percentages for all three
  //     windows plus the rate clock, with no 余 column.
  const readyTree = await mount(fixture)
  const renderedText = stripText(readyTree)
  assert.match(renderedText, new RegExp('^5h 6% 周 14% 月 12% ' + CYCLE_TAIL.source), 'rendered row must read as formatStrip does')
  assert.equal(renderedText.includes('余'), false, `rendered row must not show a 余 column: ${renderedText}`)
  for (const needle of ['6%', '14%', '12%']) {
    assert.ok(renderedText.includes(needle), `rendered row is missing "${needle}": ${renderedText}`)
  }
  for (const label of ['5h', '周', '月']) {
    assert.ok(renderedText.includes(label), `rendered row is missing the "${label}" label: ${renderedText}`)
  }
  assert.equal(renderedText.includes('DS'), false, `the row drops the DS prefix on purpose: ${renderedText}`)
  const readyBars = barsOf(readyTree)
  assert.equal(readyBars.length, 3, `expected three progress bars, got ${readyBars.length}`)
  assert.deepEqual(readyBars.map(bar => bar.props['data-quota-fill']), ['5.84', '14', '11.71'], 'bar fill ratio drifted')
  assert.deepEqual(readyBars.map(bar => bar.props['data-level']), ['ok', 'ok', 'ok'], 'bar tier drifted')
  assert.deepEqual(readyBars.map(bar => bar.children[0].props.style.width), ['5.84%', '14%', '11.71%'], 'bar width drifted')
  assert.deepEqual(
    readyBars.map(bar => bar.props['aria-label']),
    ['5h 已用 6%', '周 已用 14%', '月 已用 12%'],
    'bar aria-label drifted')
  assert.equal(find(readyTree, 'dsh-quota-dock-warn'), null, 'a clean snapshot must not show the warning marker')
  const readyTitle = find(readyTree, 'dsh-quota-dock-root').props.title
  // CYCLE_TAIL is anchored; drop its `$` so the age suffix can follow it.
  const tail = CYCLE_TAIL.source.replace(/\$$/, '')
  assert.match(readyTitle, new RegExp('^5h 6% 周 14% 月 12% ' + tail
    + '(?: · 更新于 \\d{2}-\\d{2} \\d{2}:\\d{2}(?: · 数据较旧)?)?$'),
    `tooltip must carry the same line, then only an age suffix: ${readyTitle}`)
  assert.equal(readyTitle.includes('数据可能过期'), false, 'the old staleness copy is retired')

  // 6b2: the age suffix tracks the real age instead of a fixed "possibly stale".
  const fresh = JSON.parse(JSON.stringify(fixture))
  fresh.fetchedAt = Date.now()
  const freshTitle = find(await mount(fresh), 'dsh-quota-dock-root').props.title
  assert.ok(freshTitle.includes('更新于'), `a fresh snapshot still says when it was read: ${freshTitle}`)
  assert.equal(freshTitle.includes('数据较旧'), false, `a fresh snapshot must not be called old: ${freshTitle}`)

  // 6c: the tier colours show up on the bars, not instead of the percentages.
  const hot = JSON.parse(JSON.stringify(fixture))
  hot.cc.windows[0].used = 8.5
  hot.cc.windows[0].cap = 10
  hot.cc.windows[2].used = 9.7
  hot.cc.windows[2].cap = 10
  const hotTree = await mount(hot)
  assert.deepEqual(barsOf(hotTree).map(bar => bar.props['data-level']), ['warn', 'ok', 'high'], 'tier levels drifted')
  assert.ok(stripText(hotTree).includes('85%'), `percentages must survive the warning tiers: ${stripText(hotTree)}`)
  assert.ok(stripText(hotTree).includes('97%'), `percentages must survive the alert tier: ${stripText(hotTree)}`)

  // 6d: a window the Host could not report keeps its (empty) bar and prints —.
  const gappy = {
    ok: true,
    fetchedAt: 1,
    cc: { ok: true, error: null, windows: [{ id: 'fiveHour', used: null, cap: null }], remainingMonthlyCredits: null },
    deepseek: { ok: true, balances: [{ currency: 'CNY', totalBalance: '39.62' }] },
  }
  const gappyTree = await mount(gappy)
  assert.deepEqual(barsOf(gappyTree).map(bar => bar.props['data-level']), ['unknown', 'unknown', 'unknown'], 'unreported windows must not fake a fill')
  assert.deepEqual(barsOf(gappyTree).map(bar => bar.props['data-quota-fill']), ['—', '—', '—'], 'unreported windows must not fake a ratio')
  assert.match(stripText(gappyTree), new RegExp('^5h — 周 — 月 — ' + CYCLE_TAIL.source), 'unreported windows must still print')

  // 6e: total transport failure keeps the row and marks it, never throws.
  const failedTree = await mount(null)
  assert.equal(stripText(failedTree), '取数失败', 'failed load must read 取数失败')
  assert.equal(barsOf(failedTree).length, 0, 'no data means no bars')
  assert.ok(find(failedTree, 'dsh-quota-dock-warn') !== null, 'a failed load must carry the warning marker')

  // 6f: a missing credential stays a plain line, not three empty tracks.
  const staleRendered = await mount(broken)
  assert.match(stripText(staleRendered), new RegExp('^5h — 周 — 月 — ' + CYCLE_TAIL.source), 'stale render drifted')
  assert.equal(barsOf(staleRendered).length, 0, 'a missing key must not paint empty bars')
  assert.ok(find(staleRendered, 'dsh-quota-dock-warn') !== null, 'stale data must carry the warning marker')
  assert.equal(mod.hasNumbers(gappy), true, 'a single reported window still counts as numbers')

  // 6g: the row is a button whose aria-expanded tracks the sheet (NEW).
  const closedRow = find(readyTree, 'dsh-quota-dock-row')
  assert.ok(closedRow !== null, 'the row must be a clickable button')
  assert.equal(closedRow.props['aria-expanded'], 'false', 'the sheet starts closed')
  assert.equal(closedRow.props['aria-haspopup'], 'dialog', 'the row must announce the sheet it opens')
  assert.equal(collect(readyTree, 'dsh-quota-dock-sheet').length, 0, 'the row must not embed the sheet any more')
  // Re-arm the fixture so this only measures the effect of opening the sheet.
  mod.publish({ panelOpen: true, snapshot: fixture, phase: 'ready' })
  const openRowTree = render({ load: async () => fixture, t: zh })
  assert.equal(find(openRowTree, 'dsh-quota-dock-row').props['aria-expanded'], 'true',
    'aria-expanded must reflect an open sheet')
  assert.equal(find(openRowTree, 'dsh-quota-dock-root').props['data-open'], '', 'the open row must be marked')
  assert.equal(stripText(openRowTree), renderedText, 'opening the sheet must not disturb the row reading')

  // 6h: unmount runs the effect cleanups without throwing.
  for (const cleanup of hooks.cleanups) cleanup()

  /* ---- 7. the money sheet on shell.overlay ------------------------------ */
  // 7a: closed means nothing at all — no invisible layer swallowing clicks.
  settleStore({ phase: 'ready' })
  resetInstance()
  const closedSheet = renderSlot(mod.QuotaSheet, { t: zh })
  assert.equal(closedSheet, null, 'a closed sheet must render nothing')

  // 7b: open renders the layer, the backdrop and the three money cards.
  settleStore({ snapshot: fixture, phase: 'ready', panelOpen: true, now: SHEET_NOW.getTime() })
  resetInstance()
  const sheet = renderSlot(mod.QuotaSheet, { t: zh })
  assert.ok(sheet !== null, 'an open sheet must render')
  assert.equal(sheet.props['data-quota-sheet'], '', 'the sheet root must be marked')
  assert.equal(sheet.props.style.pointerEvents, 'auto', 'the click-through overlay layer needs pointer-events: auto')
  assert.equal(find(sheet, 'dsh-quota-dock-backdrop'), null, 'the frame must not be dimmed by a backdrop')
  const closeButton = find(sheet, 'dsh-quota-dock-sheet-close')
  assert.equal(closeButton.props['aria-label'], '关闭', 'the close button needs an accessible name')
  assert.equal(typeof closeButton.props.onClick, 'function', 'the close button must close the sheet')
  assert.ok(find(sheet, 'dsh-quota-dock-sheet').props.role === 'dialog', 'the sheet must be a dialog')
  assert.ok(keyListeners.length >= 1, 'an open sheet must listen for Escape')
  const cards = findAll(sheet, n => n.props?.['data-quota-card'] !== undefined)
  assert.deepEqual(cards.map(card => card.props['data-quota-card']),
    ['overview', 'cc', 'deepseek', 'platforms'],
    'the sheet must carry the overview card ahead of the three money cards')
  const overviewText = textIn(cards[0])
  assert.ok(overviewText.includes('本月剩余'), `the overview must lead with the month left: ${overviewText}`)
  assert.ok(overviewText.includes('$61.77'), `the overview must state the credits left: ${overviewText}`)
  assert.ok(overviewText.includes('本月已用') && overviewText.includes('$8.2'),
    `the overview must state the credits used: ${overviewText}`)
  const elapsedDays = (SHEET_NOW.getTime() - Date.parse(fixture.cc.subscription.currentPeriodStart)) / 86400000
  const expectedDays = String(Math.round(
    (fixture.cc.remainingMonthlyCredits / (fixture.cc.usedMonthlyCredits / elapsedDays)) * 10) / 10)
  assert.equal(mod.daysText(mod.daysLeft(fixture.cc, SHEET_NOW)), expectedDays,
    'the runway must be remaining / (used / elapsed days)')
  assert.ok(overviewText.includes('还能用') && overviewText.includes(`${expectedDays} 天`),
    `the overview must state the runway in days: ${overviewText}`)
  assert.equal(mod.daysText(null), '—', 'a missing runway is an em dash')
  assert.equal(mod.daysText(0.04), '<0.1', 'a runway under a tenth of a day reads <0.1')
  assert.equal(mod.daysLeft({ remainingMonthlyCredits: 5, usedMonthlyCredits: 0 }, SHEET_NOW), null,
    'no burn rate means no runway estimate')
  assert.equal(mod.daysText(mod.daysLeft({ remainingMonthlyCredits: 150, usedMonthlyCredits: 5 }, SHEET_NOW)), '900',
    'a missing period start must fall back to a 30-day window')
  const sheetText = textIn(sheet)
  for (const needle of ['额度与余额', 'Command Code', 'DeepSeek', '其他平台',
    '0.82/14', '4.2/30', '8.2/69.97', '61.77', '8.2', '69.97', '39.62', '12.5',
    '月度剩余', '月度已用', '订阅', 'individual-goat', 'OpenRouter',
    '平台接入在 设置 → 额度与平台']) {
    assert.ok(sheetText.includes(needle), `the sheet is missing "${needle}": ${sheetText}`)
  }
  assert.ok(sheetText.includes('1h30m 后重置'), `the 5h reset countdown is missing: ${sheetText}`)
  assert.equal(sheetText.includes('—'), false, `a complete snapshot must not print an em dash: ${sheetText}`)
  // Money only: no form, no add button, and above all no credential field.
  assert.equal(findAll(sheet, n => n.type === 'input').length, 0, 'the sheet must carry no input at all')
  assert.equal(findAll(sheet, n => n.props?.type === 'password').length, 0, 'the sheet must never ask for an API key')
  assert.equal(findAll(sheet, n => n.props?.placeholder === 'API key').length, 0, 'the sheet must never show an API key field')
  assert.equal(findAll(sheet, n => n.type === 'button' && textOf(n.children) === '添加').length, 0,
    'the sheet must carry no add button')

  // 7c: the sheet's data layer is assertable without a tree.
  const sheetData = mod.sheetCards(fixture, zh, SHEET_NOW)
  assert.deepEqual(sheetData.windows.map(window => window.value),
    ['$0.82/14', '$4.2/30', '$8.2/69.97'], 'window rows drifted')
  assert.equal(sheetData.windows[0].reset, '1h30m 后重置', 'the reset countdown drifted')
  assert.equal(sheetData.windows[1].reset, '70h30m 后重置', 'the weekly countdown drifted')
  assert.equal(sheetData.detail.find(row => row.label === '月度已用').value, '$8.2', 'month used drifted')
  assert.equal(sheetData.detail.find(row => row.label === '月度剩余').value, '$61.77', 'month left drifted')
  assert.match(sheetData.windows[2].reset, /^\d{2}-\d{2} \d{2}:\d{2}$/,
    'the month row carries the period end as a date, not a month-away countdown')
  assert.equal(sheetData.detail.some(row => row.label === '周期结束'), false,
    'the detail line must not repeat the period end the month row already shows')
  assert.equal(sheetData.detail.find(row => row.label === '订阅').value, 'individual-goat · active', 'plan row drifted')
  assert.equal(sheetData.detail.some(row => row.label === '月度总额'), false,
    'the month total already rides on the month row; the detail line must not repeat it')
  assert.equal(sheetData.wallets[0].currency, 'CNY', 'the wallet keeps its currency')
  assert.deepEqual(sheetData.wallets[0].money.map(row => row.value), ['¥39.62', '¥0', '¥39.62'],
    'wallet figures must carry their currency mark')
  const availability = sheetData.extras.find(row => row.label === '可用')
  assert.equal(availability.value, '正常', 'availability must be spelled out beside the mark')
  assert.equal(availability.state, 'ok', 'availability must carry its state so the dot can be drawn')
  assert.equal(sheetData.platforms[0].label, 'OpenRouter', 'a platform row must carry its name')
  assert.equal(sheetData.platforms[0].value, '$12.5', 'an OpenRouter balance is USD and must be marked')

  // 7d: a platform that reports a bare `balance` uses it; a failed one shows why.
  assert.equal(mod.platformMoney({ name: 'X', balance: 3.5, fields: [] }, zh), '3.5', 'a bare balance must be used')
  assert.equal(mod.platformMoney({ name: 'X', ok: false, error: 'timeout', fields: [] }, zh), 'timeout', 'a failed platform must say why')
  assert.equal(mod.platformMoney({ name: 'X', fields: [] }, zh), '暂无', 'an empty platform falls back to 暂无')

  // 7e: an empty snapshot still renders the sheet, with em dashes instead of a crash.
  const emptySheet = mod.sheetTree({
    t: zh, now: SHEET_NOW, snapshot: null, busy: false, onClose() {}, onRefresh() {},
  })
  const emptyText = textIn(emptySheet)
  for (const bad of ['undefined', 'NaN', '[object']) {
    assert.ok(!emptyText.includes(bad), `an empty sheet leaked "${bad}": ${emptyText}`)
  }
  assert.ok(emptyText.includes('本月剩余') && emptyText.includes('—'),
    `an empty snapshot must still state the month left: ${emptyText}`)
  assert.ok(emptyText.includes('还能用') && emptyText.includes('— 天'),
    `an empty snapshot must still state the runway: ${emptyText}`)

  // 7f: the old 5-minute background poll is gone — the only timer left is the
  // clock ticker that keeps the 峰/谷 countdown honest.
  assert.ok(intervals.length >= 1, 'the row must still tick so the countdown stays honest')
  assert.ok(intervals.every(ms => ms === 30000),
    `no timer may poll upstream again: ${JSON.stringify(intervals)}`)

  /* ---- 8. the settings page on settings.section ------------------------- */
  let platformCalls = 0
  globalThis.fetch = async (url, options) => {
    platformCalls += 1
    const body = options !== undefined && options.method === 'POST'
      ? { ok: true, platforms: [], refreshMs: 60000, storePath: 'X/platforms.json' }
      : { ok: true, platforms: fixture.platforms, refreshMs: 60000, storePath: 'X/platforms.json' }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  settleStore()
  resetInstance()
  renderSlot(settingsSlot.component, { t: zh })
  await tick()
  const mountedSettings = renderSlot(settingsSlot.component, { t: zh })
  assert.equal(mountedSettings.props['data-quota-settings'], '', 'the settings page must be marked')
  assert.equal(platformCalls, 1, 'the settings page must load the platform document exactly once on mount')

  // 8a: the four sections read in order, and the old 说明 paragraph is gone.
  const settingsSnapshot = {
    cc: { ok: true, monthlyCap: 69.97, usedMonthlyCredits: 8.2, windows: [] },
    deepseek: { ok: true, balances: [{ totalBalance: 39.62, currency: 'CNY' }] },
  }
  const pureSettings = {
    t: zh, snapshot: settingsSnapshot, platforms: fixture.platforms, refreshMs: 60000,
    storePath: 'C:\\Users\\x\\.dsh\\dsh-quota-dock\\platforms.json',
    busy: false, message: null,
    form: { preset: 'openrouter', name: '', kind: 'openrouter', baseUrl: '', apiKey: '' },
    onForm() {}, onAdd() {}, onRemove() {}, onRefresh() {}, onInterval() {},
  }
  const settingsTree = mod.settingsTree(pureSettings)
  const settingsText = textIn(settingsTree)
  for (const needle of ['额度与平台', '刷新', '这里只管配置', '内置平台', 'key 从环境变量读',
    '已接入平台', '接入新平台', '选预设可省掉填地址', '数据与刷新', '刷新间隔', '最近刷新',
    '配置文件', '立即刷新', 'OpenRouter', '自定义', '正常', '12.5', '删除',
    'API key 只存在本机 platforms.json']) {
    assert.ok(settingsText.includes(needle), `the settings page is missing "${needle}": ${settingsText}`)
  }
  assert.ok(!settingsText.includes('说明'), 'the old 说明 block must be gone')
  const sections = findAll(settingsTree, n => n.props?.['data-quota-section'] !== undefined)
  assert.deepEqual(sections.map(section => section.props['data-quota-section']),
    ['builtin', 'platforms', 'add', 'data'],
    'the settings page must carry the four sections in order')

  // 8b: the built-in rows read the snapshot; the platform row keeps its dot.
  const dots = findAll(settingsTree, n => n.props?.['data-quota-dot'] !== undefined)
  assert.deepEqual(dots.map(dot => dot.props['data-quota-dot']), ['ok', 'ok', 'ok'],
    'two built-in rows and one platform row, all healthy here')
  assert.ok(settingsText.includes('正常'), 'the status dot must be spelled out in words, never colour alone')
  assert.ok(settingsText.includes('月 12%'), `the built-in row must state the month share: ${settingsText}`)
  assert.ok(settingsText.includes('¥39.62'), 'the built-in row must state the wallet total')
  assert.equal(findAll(settingsTree, n => n.props?.type === 'password').length, 1,
    'the API key field must be a password input')

  // 8c: six presets, the chosen one active, and an OpenRouter address that cannot
  // be edited because the Host fixes it.
  const pills = findAll(settingsTree, n => n.props?.['data-quota-preset'] !== undefined)
  assert.deepEqual(pills.map(pill => pill.props['data-quota-preset']),
    ['openrouter', 'litellm', 'newapi', 'siliconflow', 'kimi', 'custom'],
    'the preset list drifted')
  assert.deepEqual(pills.filter(pill => pill.props['data-active'] !== undefined)
    .map(pill => pill.props['data-quota-preset']), ['openrouter'], 'the chosen preset must read as active')
  assert.equal(findAll(settingsTree, n => n.props?.placeholder === 'https://…').length, 0,
    'a fixed address needs no endpoint input')
  assert.ok(settingsText.includes('这一家的地址由插件固定'), 'a fixed address must say why it cannot be edited')
  assert.equal(findAll(settingsTree, n => n.type === 'label').length, 1,
    'OpenRouter shows exactly one labelled field')
  assert.equal(findAll(settingsTree, n => n.type === 'input').length, 1,
    'OpenRouter needs only the API key field')

  // 8d: a preset with an address fills it; a custom one asks for name and address.
  const presetSettings = {
    ...pureSettings,
    form: { preset: 'kimi', name: 'Kimi', kind: 'custom', baseUrl: 'https://api.moonshot.cn/v1/users/me/balance', apiKey: '' },
  }
  const presetTree = mod.settingsTree(presetSettings)
  assert.equal(findAll(presetTree, n => n.props?.placeholder === 'https://…').length, 1,
    'a preset with an address still lets the address be edited')
  assert.equal(findAll(presetTree, n => n.type === 'label').length, 3,
    'a custom platform shows name, address and key')
  const customSettings = {
    ...pureSettings,
    form: { preset: 'custom', name: '', kind: 'custom', baseUrl: '', apiKey: '' },
  }
  const customTree = mod.settingsTree(customSettings)
  assert.equal(findAll(customTree, n => n.type === 'input').length, 3,
    'a custom platform needs a name, an address and the key')
  assert.equal(findAll(customTree, n => n.props?.placeholder === 'LiteLLM').length, 1,
    'the name field must carry an example, not a label')

  // 8e: the cadence is a select over the offered choices, and it echoes the document.
  const select = find(settingsTree, 'dsh-quota-dock-select')
  assert.ok(select !== null && select !== undefined, 'the cadence must be a control on this page')
  assert.equal(String(select.props.value), '60000', 'the select must show the stored cadence')
  const options = findAll(settingsTree, n => n.type === 'option')
  assert.deepEqual(options.map(option => option.props.value),
    ['30000', '60000', '120000', '300000', '600000'], 'the cadence choices drifted')
  assert.ok(settingsText.includes('30 秒') && settingsText.includes('10 分钟'),
    `the cadence must be spelled out in units: ${settingsText}`)
  assert.ok(settingsText.includes('platforms.json'), 'the store path must be shown')
  assert.equal(find(settingsTree, 'dsh-quota-dock-pmsg'), null, 'a clean load must not show an error message')

  // 8f: an empty list says so and points at the add section.
  const emptyListText = textIn(mod.settingsTree({ ...pureSettings, platforms: [] }))
  assert.ok(emptyListText.includes('还没有接入任何平台') && emptyListText.includes('下面添加一个即可'),
    `an empty platform list must say so and point at the add form: ${emptyListText}`)
  assert.ok(emptyListText.includes('去添加'), 'the empty state must offer the way to the form')

  /* ---- report ----------------------------------------------------------- */
  console.log(JSON.stringify({
    ok: true,
    clientFile: CLIENT,
    clientLines: lineCount,
    moduleId: captured.id,
    injectedServices: mod.inject,
    registeredSlots: slots.map(entry => ({
      slot: entry.slotName,
      id: entry.config.id,
      name: entry.config.name,
      order: entry.config.order,
      label: typeof entry.config.label === 'function' ? entry.config.label() : undefined,
      locale: entry.config.locale,
    })),
    localeKeys: Object.keys(locales[0].dictionary.zh),
    effects: effects.length,
    timers: intervals,
    strip,
    brokenStrip,
    partialStrip,
    ariaExpanded: {
      closed: closedRow.props['aria-expanded'],
      open: find(openRowTree, 'dsh-quota-dock-row').props['aria-expanded'],
    },
    bars: readyBars.map(bar => ({
      fill: bar.props['data-quota-fill'],
      level: bar.props['data-level'],
      width: bar.children[0].props.style.width,
      aria: bar.props['aria-label'],
    })),
    sheet: {
      closedRenders: String(closedSheet),
      pointerEvents: sheet.props.style.pointerEvents,
      cards: cards.map(card => card.props['data-quota-card']),
      overview: overviewText,
      overviewDays: expectedDays,
      inputs: findAll(sheet, n => n.type === 'input').length,
      passwordInputs: findAll(sheet, n => n.props?.type === 'password').length,
      windowRows: sheetData.windows.map(window => `${window.label} ${window.value} ${window.reset}`),
      detail: sheetData.detail.map(row => `${row.label} ${row.value}`),
      wallets: sheetData.wallets.map(wallet => `${wallet.currency} ${wallet.money.map(row => row.value).join('/')}`),
      text: sheetText,
    },
    settings: {
      fetchedOnce: platformCalls,
      kinds: pills.map(pill => pill.props['data-quota-kind']),
      sections: sections.map(section => section.props['data-quota-section']),
      dotState: dots.map(dot => dot.props['data-quota-dot']),
      inputs: findAll(settingsTree, n => n.type === 'input').length,
      text: settingsText,
    },
    rendered: {
      loading: stripText(loadingTree),
      ready: renderedText,
      warnHigh: stripText(hotTree),
      gappy: stripText(gappyTree),
      failed: stripText(failedTree),
      stale: stripText(staleRendered),
    },
    visual: 'The row is unchanged (centred wrapping cells of label + 48x7px bar + percentage, then the hairline divider and the DS cycle track); it reads on mount and on a session switch, refreshes from the buttons, and no longer polls on any timer. Clicking it centres an 820px-max, 78vh-max money panel over the frame with no page-wide backdrop, so the rest of the frame keeps its hover and clicks: a header (额度与余额 + 更新于 + 刷新 + ×), then a hero row that sets 本月剩余 above a 30px number with 本月已用 and 还能用 beside it, a full-bleed hairline, then two-column cards with Command Code spanning both columns (three five-column window rows: label, used/cap, 5px bar, percentage, reset; plus one detail line under the month row — 已用 · 剩余 · 周期结束 · 订阅 — so 月 is named once), DeepSeek (its currency as the card note over 总额/赠送/充值, then 可用 as a dot plus its word, then the 峰/谷 line as a ruled footnote) and 其他平台 (one explanatory line when nothing is connected), and a tinted footer with the cadence on the left and 设置 → 额度与平台 on the right. The settings page is a four-section configuration page (内置平台: one row per built-in naming the env var it reads and its headline figure; 已接入平台: a row of status dot + name + kind·address + spelled-out state + amount + delete, with a dashed empty state that links to the form; 接入新平台: six preset pills that fill name and address, the OpenRouter address shown read-only, labelled name/address/key fields with a right-aligned 添加; 数据与刷新: a cadence select beside 立即刷新, the last refresh and the store path), with no money of its own. Semantic colour is only the three literals #7BB295 / #E0A03A / #E0574F; every other colour is an --dsw-alias-* token with a literal fallback.',
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
