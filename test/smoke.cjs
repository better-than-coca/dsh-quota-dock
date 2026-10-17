'use strict'
/*
 * Throwaway acceptance harness for E:\dsh\dsh-quota-dock\client.js.
 * No DOM, no browser, no real network: it stubs window.__ModuleLoader__ and
 * require('react') / require('react-dom') just far enough to call the factory,
 * then drives the exported contract, the pure formatting helpers, the fill-bar
 * maths, and an actual render of the component through a mini hook runtime.
 *
 * The row now lives on the `conversation.input.dock` slot (the full-width row
 * above the composer card), shows all three Command Code windows with a bar
 * plus concrete numbers, and no longer carries a 余/remaining column.
 *
 * Run:  node E:\dsh\.tmp-quota-smoke\smoke.cjs
 */
const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')

const CLIENT = require('node:path').join(__dirname, '..', 'client.js')
const NS = 'quotaDock'
const SLOT = 'conversation.input.dock'

/* ---- 1. capture the module registration ---------------------------------- */
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(config) { captured = config },
  },
  // The component's refresh timer and focus listener, stubbed as no-ops so the
  // harness neither schedules a real 5-minute interval nor needs a DOM.
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
}

const source = fs.readFileSync(CLIENT, 'utf8')
const lineCount = source.split('\n').length - (source.endsWith('\n') ? 1 : 0)
vm.runInThisContext(source, { filename: CLIENT })

assert.ok(captured, 'window.__ModuleLoader__.load was never called')
assert.equal(captured.id, '@local/dsh-quota-dock', 'module id mismatch')
assert.equal(typeof captured.factory, 'function', 'factory missing')

/* ---- 2. minimal react / react-dom, with just enough hooks to render ------ */
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
  // The component's only effect has an empty dependency list, so it runs once.
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

/* ---- 3. fake ctx: one slot, one dictionary ------------------------------ */
const injected = []
const slots = []
const locales = []
const effects = []
const ctx = {
  effect(fn, label) {
    effects.push(label)
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: { register(namespace, dictionary) { locales.push({ namespace, dictionary }); return () => {} } },
  get() { return undefined },
  slots: {
    inject(name, factory) { injected.push(name); return factory() },
    register(config, component) { slots.push({ config, component }); return () => {} },
  },
}
mod.apply(ctx)

assert.deepEqual(injected, [SLOT], 'slots.inject target mismatch')
assert.equal(slots.length, 1, `expected exactly one registered slot, got ${slots.length}`)
const { config, component } = slots[0]
assert.equal(config.name, SLOT, 'slot name mismatch')
assert.equal(config.order, -1, 'slot order must be -1 (the input dock list first entry)')
assert.equal(typeof config.id, 'string')
assert.ok(config.id.length > 0, 'slot id must be a non-empty string')
assert.equal(config.locale, NS, 'slot locale namespace mismatch')
assert.equal(typeof component, 'function', 'slot component must be a function')
const injectedProps = config.inject()
assert.equal(typeof injectedProps.load, 'function', 'inject() must expose load()')

assert.equal(locales.length, 1, 'expected exactly one locale registration')
assert.equal(locales[0].namespace, NS, 'locale namespace mismatch')
for (const key of ['en', 'zh']) {
  assert.ok(locales[0].dictionary[key], `locale dictionary missing "${key}"`)
  for (const field of ['fiveHour', 'weekly', 'monthly', 'deepseek', 'used', 'loading', 'noKey']) {
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
  // The Host still reports all three windows; the row shows all three of them.
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
    subscription: null,
  },
  deepseek: {
    ok: true,
    error: null,
    balances: [
      { currency: 'CNY', totalBalance: '39.62', grantedBalance: '0.00', toppedUpBalance: '39.62' },
    ],
  },
}

const zh = key => mod.LOCALES.zh[key]
const PEAK_AT = new Date(2026, 9, 19, 9, 0, 0) // Mon 09:00 → 30 min into the 16h 峰
const OFF_AT = new Date(2026, 9, 19, 2, 0, 0) // Mon 02:00 → 90 min into the 8h 谷
const strip = mod.formatStrip(fixture, zh, PEAK_AT)
assert.equal(strip, '5h 6% 周 14% 月 12% DS 峰时 · 距谷 15h30m', 'strip shape drifted')
assert.equal(mod.formatStrip(fixture, zh, OFF_AT), '5h 6% 周 14% 月 12% DS 谷时 · 距峰 6h30m', 'the countdown must follow the clock')
assert.equal(mod.formatStrip(fixture, zh, new Date(2026, 9, 17, 12, 0, 0)), '5h 6% 周 14% 月 12% DS 谷时 · 全天谷价', 'a weekend must read 谷 all day')
assert.equal(strip.includes('余'), false, `the row must not print a 余 column: ${strip}`)
assert.ok(/5h \d+% 周 \d+% 月 \d+% DS/.test(strip), `cells must be space-separated: ${strip}`)
assert.equal(strip.includes('/'), false, `the row shows percentages, not used/cap: ${strip}`)
for (const needle of ['6%', '14%', '12%', '峰时']) {
  assert.ok(strip.includes(needle), `strip is missing "${needle}": ${strip}`)
}
for (const label of ['5h', '周', '月', 'DS']) {
  assert.ok(strip.includes(label), `strip is missing the "${label}" label: ${strip}`)
}
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
assert.equal(brokenStrip, '5h — 周 — 月 — DS 峰时 · 距谷 15h30m', 'missing-key wording drifted')
assert.equal(mod.hasNumbers(broken), false, 'broken snapshot must not count as having numbers')

// A provider that failed without the credential wording keeps the row and shows
// em dashes rather than dropping or crashing.
const partial = {
  ok: true,
  fetchedAt: 1,
  cc: { ok: false, error: 'timeout', windows: [] },
  deepseek: { ok: true, balances: [{ currency: 'USD', totalBalance: '1.5' }] },
}
const partialStrip = mod.formatStrip(partial, zh, PEAK_AT)
assert.equal(partialStrip, '5h — 周 — 月 — DS 峰时 · 距谷 15h30m', 'partial strip drifted')
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

/* ---- 6. render the component through the mini hook runtime -------------- */
const tick = () => new Promise(resolve => { setTimeout(resolve, 0) })
const render = props => { hooks.cursor = 0; return component(props) }
const resetInstance = () => { hooks.slots = []; hooks.cleanups = []; hooks.cursor = 0 }
const mount = async snapshot => {
  resetInstance()
  render({ load: async () => snapshot, t: zh })
  await tick()
  return render({ load: async () => snapshot, t: zh })
}

// The rendered row reads the live clock, so its DeepSeek tail is asserted by shape.
const CYCLE_TAIL = /DS (峰时|谷时) · (距[峰谷] (?:\d+h)?\d+m|全天谷价)$/

async function main() {
  // 6a: a pending load paints 查询中…, and the row is never blank.
  resetInstance()
  const loadingTree = render({ load: () => new Promise(() => {}), t: zh })
  assert.equal(stripText(loadingTree), '查询中…', 'pending load must read 查询中…')

  // 6b: numbers land — the row carries three bars AND the concrete numbers for
  //     all three windows, plus the DeepSeek balance, with no 余 column.
  const readyTree = await mount(fixture)
  const renderedText = stripText(readyTree)
  assert.match(renderedText, new RegExp('^5h 6% 周 14% 月 12% ' + CYCLE_TAIL.source), 'rendered row must read as formatStrip does')
  assert.equal(renderedText.includes('余'), false, `rendered row must not show a 余 column: ${renderedText}`)
  for (const needle of ['6%', '14%', '12%']) {
    assert.ok(renderedText.includes(needle), `rendered row is missing "${needle}": ${renderedText}`)
  }
  for (const label of ['5h', '周', '月', 'DS']) {
    assert.ok(renderedText.includes(label), `rendered row is missing the "${label}" label: ${renderedText}`)
  }
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
  assert.match(find(readyTree, 'dsh-quota-dock-root').props.title, new RegExp('^5h 6% 周 14% 月 12% ' + CYCLE_TAIL.source), 'tooltip must carry the same line')

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

  // 6g: the structured row and the plain-text projection agree.
  assert.equal(mod.hasNumbers(gappy), true, 'a single reported window still counts as numbers')

  // 6h: unmount runs the effect cleanup without throwing.
  for (const cleanup of hooks.cleanups) cleanup()

  /* ---- report ----------------------------------------------------------- */
  console.log(JSON.stringify({
    ok: true,
    clientFile: CLIENT,
    clientLines: lineCount,
    moduleId: captured.id,
    injectedServices: mod.inject,
    slot: { name: config.name, id: config.id, order: config.order, locale: config.locale },
    localeKeys: Object.keys(locales[0].dictionary.zh),
    effects: effects.length,
    strip,
    brokenStrip,
    partialStrip,
    barFormula: 'fill% = clamp(used / cap * 100, 0, 100); fill width = <round2(fill%)>% of a 48x7px track; tiers <80 ok, >=80 warn, >=95 high, unusable -> unknown',
    bars: readyBars.map(bar => ({
      fill: bar.props['data-quota-fill'],
      level: bar.props['data-level'],
      width: bar.children[0].props.style.width,
      aria: bar.props['aria-label'],
    })),
    rendered: {
      loading: stripText(loadingTree),
      ready: renderedText,
      warnHigh: stripText(hotTree),
      gappy: stripText(gappyTree),
      failed: stripText(failedTree),
      stale: stripText(staleRendered),
    },
    visual: 'Centred wrapping row above the composer: each window is a 12px label + a 48x7px rounded, 1px-bordered track filled to used/cap (muted green #7BB295 while there is room, amber from 80%, red from 95%) + the integer percentage in a neutral tone (amber/red only in the alert tiers), then a 12px hairline divider and the DS group as a 56x7px cycle track (amber for the 16h 峰 share, blue for the 8h 谷 share, a 1px marker at now) + "峰时 · 距谷 3h42m"; no separators, no 余 column, no used/cap figures, themed entirely with --dsw-alias-* tokens.',
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
