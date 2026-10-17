/**
 * Client half of the quota dock: one always-visible, centred line of usage on the
 * input dock — the full-width row directly above the composer card — so the
 * Command Code 5h / weekly / monthly windows, each with a thin fill bar and its
 * percentage, plus the DeepSeek balance are readable at a glance with no click.
 *
 * Bars never replace the reading, in this shape:
 *   5h ▮▮▯▯▯ 6%  周 ▮▮▯▯▯ 14%  月 ▮▮▯▯▯ 12%  │  DS 峰 67% ▮▮▮▯ 谷 33%
 * A missing reading becomes an em dash instead of `undefined` or `NaN`.
 * The DeepSeek group is the clock rather than the wallet: a bar of the current
 * peak / off-peak split of the day (DeepSeek prices 谷 at 00:30–08:30 and all weekend).
 *
 * The data comes from this bundle's Host half over the same origin; the contract
 * (E:\dsh\dsh-quota-dock\CONTRACT.md) is the only interface between the halves.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-quota-dock',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'quotaDock'

    const SNAPSHOT_URL = '/api/dsh-quota-dock/snapshot'
    const REFRESH_URL = '/api/dsh-quota-dock/refresh'
    /** Cadence while the first upstream read is still running, and its budget. */
    const POLL_MS = 2000
    const POLL_BUDGET_MS = 30000
    /** Cadence once numbers are on screen; focus also refreshes. */
    const REFRESH_MS = 5 * 60 * 1000
    /** The countdown to the next rate switch re-renders this often. */
    const TICK_MS = 30 * 1000
    /** Command Code's three windows, fixed order, all three on the row. */
    const SHOWN_WINDOW_IDS = ['fiveHour', 'weekly', 'monthly']
    /** Fill-bar tiers: alerting starts at 80% of the cap; at 95% it is red. */
    const WARN_RATIO = 80
    const HIGH_RATIO = 95
    /** DeepSeek's 谷 window, in minutes past local midnight: 00:30–08:30. */
    const OFF_PEAK_START = 30
    const OFF_PEAK_END = 8 * 60 + 30
    /** Since 2026-08-23 DeepSeek prices a whole weekend at the off-peak rate. */
    const WEEKEND_IS_OFF_PEAK = true

    const LOCALES = {
      en: {
        fiveHour: '5h',
        weekly: 'wk',
        monthly: 'mo',
        deepseek: 'DS',
        peak: 'peak',
        offPeak: 'off',
        peakTime: 'peak',
        offPeakTime: 'off-peak',
        toPeak: 'peak in',
        toOffPeak: 'off-peak in',
        allDayOff: 'off-peak all day',
        used: 'used',
        loading: 'Checking…',
        unavailable: 'unavailable',
        noKey: 'key not configured',
        stale: 'possibly stale',
      },
      zh: {
        fiveHour: '5h',
        weekly: '周',
        monthly: '月',
        deepseek: 'DS',
        peak: '峰',
        offPeak: '谷',
        peakTime: '峰时',
        offPeakTime: '谷时',
        toPeak: '距峰',
        toOffPeak: '距谷',
        allDayOff: '全天谷价',
        used: '已用',
        loading: '查询中…',
        unavailable: '取数失败',
        noKey: '未配置 key',
        stale: '数据可能过期',
      },
    }

    const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

    /** AbortSignal.timeout when the runtime has it; nothing to pass when it does not. */
    function timeoutSignal(ms) {
      try {
        return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(ms)
          : undefined
      } catch (error) {
        return undefined
      }
    }

    /**
     * A usable number, or null. Nullish and empty values are rejected before
     * `Number()`, because `Number(null)` and `Number('')` are both 0.
     * @param value - value straight off the Host payload.
     * @returns the finite number, or null.
     */
    function toNum(value) {
      if (value === null || value === undefined || value === '') return null
      const number = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(number) ? number : null
    }

    const round2 = value => Math.round(value * 100) / 100

    /** Credit count as text; anything unusable reads as an em dash. */
    function numText(value) {
      const number = toNum(value)
      if (number === null) return '—'
      return Number.isInteger(number) ? String(number) : String(round2(number))
    }

    /** `used/cap`; a missing side is an em dash, so the shape never collapses. */
    function ratioText(used, cap) {
      if (toNum(used) === null && toNum(cap) === null) return '—'
      return `${numText(used)}/${numText(cap)}`
    }

    /**
     * `used / cap` as a whole percentage — the row's reading since 2026-10-18.
     * A non-zero ratio that would round to zero reads `<1%`, never a flat `0%`.
     */
    function percentText(used, cap) {
      const percent = barPercent(used, cap)
      if (percent === null) return '—'
      if (percent > 0 && percent < 0.5) return '<1%'
      return `${Math.round(percent)}%`
    }

    /** The window with this id, or null when the Host could not report it. */
    function windowOf(cc, id) {
      const windows = cc !== null && cc !== undefined && Array.isArray(cc.windows) ? cc.windows : []
      return windows.find(window => window !== null && window !== undefined && window.id === id) ?? null
    }

    /** True when anything numeric at all is on screen — the gate for 查询中…. */
    function hasNumbers(snapshot) {
      if (snapshot === null || snapshot === undefined) return false
      const cc = snapshot.cc
      const deepseek = snapshot.deepseek
      const windows = cc !== null && cc !== undefined && Array.isArray(cc.windows) ? cc.windows : []
      if (windows.some(window => window !== null && window !== undefined
        && (toNum(window.used) !== null || toNum(window.cap) !== null))) return true
      const balances = deepseek !== null && deepseek !== undefined && Array.isArray(deepseek.balances) ? deepseek.balances : []
      return balances.some(wallet => wallet !== null && wallet !== undefined && toNum(wallet.totalBalance) !== null)
    }

    /**
     * How full a window's bar is: `clamp(used / cap × 100, 0, 100)`.
     * @returns the percentage, or null when either side is unusable or the cap
     * is not positive — the caller then paints an empty track and relies on the
     * printed `used/cap` for the reading.
     */
    function barPercent(used, cap) {
      const upper = toNum(used)
      const limit = toNum(cap)
      if (upper === null || limit === null || limit <= 0) return null
      return Math.max(0, Math.min(100, (upper / limit) * 100))
    }

    /** Colour tier of a fill: ok below 80%, warn from 80%, high from 95%. */
    function barLevel(percent) {
      if (percent === null) return 'unknown'
      if (percent >= HIGH_RATIO) return 'high'
      if (percent >= WARN_RATIO) return 'warn'
      return 'ok'
    }

    /** A locale lookup, falling back to the Chinese dictionary. */
    const lookup = t => (typeof t === 'function' ? t : key => LOCALES.zh[key])

    /**
     * Where the clock stands in DeepSeek's price cycle. The cycle runs 08:30 →
     * next 08:30: 峰 for 16 hours, then 谷 (00:30–08:30) for 8. Since 2026-08-23
     * a whole weekend prices at the 谷 rate.
     *
     * The track is that cycle laid out once — 峰's share amber, 谷's share blue —
     * with a marker at the current position, so the bar always shows both the
     * schedule and where "now" sits in it. That mirrors how dsh-cost-meter
     * renders the same two windows.
     * @param now - clock; injectable so an offline test stays deterministic.
     * @returns each share of the cycle, the marker position, and the minutes
     * until the rate switches.
     */
    function cycleState(now) {
      const at = now instanceof Date ? now : new Date()
      const minutes = at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60
      const weekend = WEEKEND_IS_OFF_PEAK && (at.getDay() === 0 || at.getDay() === 6)
      const day = 24 * 60
      const offPeakMinutes = OFF_PEAK_END - OFF_PEAK_START
      const peakMinutes = day - offPeakMinutes
      if (weekend) {
        return {
          segment: 'offPeak',
          peakPercent: 0,
          offPeakPercent: 100,
          markerPercent: 0,
          remainingMinutes: 0,
          wholeDay: true,
        }
      }
      const sinceStart = (minutes - OFF_PEAK_END + day) % day
      const inPeak = sinceStart < peakMinutes
      return {
        segment: inPeak ? 'peak' : 'offPeak',
        peakPercent: (peakMinutes / day) * 100,
        offPeakPercent: (offPeakMinutes / day) * 100,
        markerPercent: (sinceStart / day) * 100,
        remainingMinutes: inPeak ? peakMinutes - sinceStart : day - sinceStart,
        wholeDay: false,
      }
    }

    /** `3h42m` — a compact countdown to the next rate switch. */
    function durationText(minutes) {
      const total = Math.max(0, Math.round(minutes))
      const hours = Math.floor(total / 60)
      const rest = total % 60
      return hours > 0 ? `${hours}h${rest}m` : `${rest}m`
    }

    /** `峰时 · 距谷 3h42m` — the DeepSeek group's reading. */
    function cycleText(tr, now) {
      const state = cycleState(now)
      if (state.wholeDay) return `${tr('offPeakTime')} · ${tr('allDayOff')}`
      const tier = state.segment === 'peak' ? tr('peakTime') : tr('offPeakTime')
      const until = state.segment === 'peak' ? tr('toOffPeak') : tr('toPeak')
      return `${tier} · ${until} ${durationText(state.remainingMinutes)}`
    }

    /**
     * The row as plain text: what it shows before any numbers exist, what its
     * tooltip carries afterwards, and — because the row spaces its cells with a
     * flex gap instead of separator glyphs — the exact text projection of the
     * structured row. There is no 余/remaining column: the monthly bar carries
     * that reading, and the DeepSeek group reads the rate cycle, not the wallet.
     * @param snapshot - the Host snapshot (CONTRACT §1), or null before first data.
     * @param t - locale lookup; falls back to the Chinese dictionary.
     * @param now - clock for the price cycle; injectable for the offline test.
     * @returns e.g. `5h 6% 周 14% 月 12% DS 峰时 · 距谷 3h42m`.
     */
    function formatStrip(snapshot, t, now) {
      const tr = lookup(t)
      if (snapshot === null || snapshot === undefined) return tr('loading')
      const parts = SHOWN_WINDOW_IDS.map(id => {
        const window = windowOf(snapshot.cc, id)
        return `${tr(id)} ${percentText(window?.used, window?.cap)}`
      })
      return `${parts.join(' ')} ${tr('deepseek')} ${cycleText(tr, now)}`
    }

    /**
     * One window's fill bar. The numbers live in sibling text nodes, so a bar
     * can never become the only reading on the row.
     * @param window - the window, or null when the Host did not report it.
     * @param label - already-localised window name, for the accessible name.
     * @param t - locale lookup, for the `used` word.
     */
    function renderBar(window, label, t) {
      const percent = barPercent(window?.used, window?.cap)
      const width = percent === null ? '0%' : `${round2(percent)}%`
      return h('span', {
        className: 'dsh-quota-dock-bar',
        'data-quota-bar': '',
        'data-level': barLevel(percent),
        'data-quota-fill': percent === null ? '—' : String(round2(percent)),
        role: 'img',
        'aria-label': `${label} ${t('used')} ${percentText(window?.used, window?.cap)}`,
      }, h('span', { className: 'dsh-quota-dock-bar-fill', style: { width } }))
    }

    /**
     * The percentage, tinted by tier — green while there is room, amber from 80%,
     * red from 95%. It sits beside the bar, so the bar is never the only reading.
     */
    function renderPercent(window) {
      return h('span', {
        className: 'dsh-quota-dock-pct',
        'data-level': barLevel(barPercent(window?.used, window?.cap)),
      }, percentText(window?.used, window?.cap))
    }

    /**
     * The structured row: every window as `label · bar · percent`, centred, plus
     * the DeepSeek group behind a hairline divider.
     *
     * Cells are separated by a flex gap, not by a `·` glyph, so the labels carry
     * the surrounding spaces themselves — that keeps the concatenated text of
     * this tree identical to `formatStrip(snapshot, t)`, which the offline smoke
     * test compares and the tooltip shows.
     */
    function renderCells(snapshot, t, now) {
      const cc = snapshot.cc
      const children = []
      SHOWN_WINDOW_IDS.forEach((id, index) => {
        const window = windowOf(cc, id)
        children.push(h('span', { key: id, className: 'dsh-quota-dock-cell' },
          h('span', { className: 'dsh-quota-dock-label' }, `${index > 0 ? ' ' : ''}${t(id)} `),
          renderBar(window, t(id), t),
          renderPercent(window)))
      })
      const cycle = cycleState(now)
      const tier = cycle.segment === 'peak' ? t('peakTime') : t('offPeakTime')
      const until = cycle.wholeDay
        ? t('allDayOff')
        : `${cycle.segment === 'peak' ? t('toOffPeak') : t('toPeak')} ${durationText(cycle.remainingMinutes)}`
      children.push(h('span', {
        key: 'deepseek',
        className: 'dsh-quota-dock-ds',
      },
        h('span', { className: 'dsh-quota-dock-divider', 'data-quota-divider': '' }),
        // Leading space in place of the flex gap, for the reason above; the
        // cycle track carries no text, so spaces are written out explicitly.
        h('span', { className: 'dsh-quota-dock-ds-num' },
          ` ${t('deepseek')} `,
          h('span', {
            className: 'dsh-quota-dock-track',
            'data-quota-cycle': cycle.segment,
            'data-quota-marker': String(Math.round(cycle.markerPercent)),
            role: 'img',
            'aria-label': `${t('deepseek')} ${tier} ${until}`,
          },
            h('span', { className: 'dsh-quota-dock-track-peak', style: { width: `${round2(cycle.peakPercent)}%` } }),
            h('span', { className: 'dsh-quota-dock-track-off', style: { width: `${round2(cycle.offPeakPercent)}%` } }),
            h('span', { className: 'dsh-quota-dock-marker', style: { left: `${round2(cycle.markerPercent)}%` } })),
          h('span', { className: 'dsh-quota-dock-tier' }, `${tier} · `),
          h('span', { className: 'dsh-quota-dock-until' }, until))))
      return children
    }

    const CSS = [
      // Full-width row above the composer card: the input dock's type scale, laid
      // out as wrapping flex items instead of `·` separators.
      '.dsh-quota-dock-root {',
      '  display: flex; align-items: center; width: 100%; box-sizing: border-box;',
      '  padding: 2px 2px 6px; color: var(--dsw-alias-label-tertiary);',
      '  font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums;',
      '}',
      '.dsh-quota-dock-strip {',
      '  display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 12px;',
      '  flex: 1 1 auto; min-width: 0;',
      '}',
      '.dsh-quota-dock-cell { display: inline-flex; align-items: center; gap: 6px; flex: none; }',
      '.dsh-quota-dock-label { color: var(--dsw-alias-label-tertiary); font-weight: 500; }',
      '.dsh-quota-dock-pct { flex: none; color: var(--dsw-alias-label-secondary); font-weight: 500; }',
      '.dsh-quota-dock-pct[data-level="warn"] { color: var(--dsw-alias-state-warn-primary); }',
      '.dsh-quota-dock-pct[data-level="high"] { color: var(--dsw-alias-state-error-primary); }',
      '.dsh-quota-dock-pct[data-level="unknown"] { color: var(--dsw-alias-label-tertiary); }',
      '.dsh-quota-dock-bar {',
      '  display: inline-block; flex: none; width: 48px; height: 7px; border-radius: 999px;',
      '  box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2);',
      '  background: var(--dsw-alias-fill-l2); overflow: hidden;',
      '}',
      '.dsh-quota-dock-bar-fill {',
      '  display: block; height: 100%; border-radius: inherit;',
      '  background: #7BB295; transition: width 160ms ease-out;',
      '}',
      '.dsh-quota-dock-bar[data-level="warn"] .dsh-quota-dock-bar-fill {',
      '  background: var(--dsw-alias-state-warn-primary);',
      '}',
      '.dsh-quota-dock-bar[data-level="high"] .dsh-quota-dock-bar-fill {',
      '  background: var(--dsw-alias-state-error-primary);',
      '}',
      '.dsh-quota-dock-bar[data-level="unknown"] .dsh-quota-dock-bar-fill { background: transparent; }',
      '.dsh-quota-dock-ds { display: inline-flex; align-items: center; gap: 8px; flex: none; }',
      '.dsh-quota-dock-divider { flex: none; width: 1px; height: 12px; margin: 0 4px;',
      '  background: var(--dsw-alias-border-l3); }',
      '.dsh-quota-dock-track {',
      '  position: relative; display: inline-flex; flex: none; width: 56px; height: 7px;',
      '  box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2);',
      '  border-radius: 999px; background: var(--dsw-alias-fill-l2); overflow: hidden;',
      '}',
      '.dsh-quota-dock-track-peak {',
      '  display: block; height: 100%; background: var(--dsw-alias-state-warn-primary);',
      '}',
      '.dsh-quota-dock-track-off { display: block; height: 100%; background: #5B9BF3; }',
      '.dsh-quota-dock-marker {',
      '  position: absolute; top: 0; bottom: 0; width: 1px; z-index: 1;',
      '  background: var(--dsw-alias-label-primary);',
      '  box-shadow: 0 0 0 1px var(--dsw-alias-bg-layer-1);',
      '}',
      '.dsh-quota-dock-tier { font-weight: 500; }',
      '.dsh-quota-dock-until { color: var(--dsw-alias-label-tertiary); }',
      '.dsh-quota-dock-root[data-warn] .dsh-quota-dock-strip { color: var(--dsw-alias-label-secondary); }',
      '.dsh-quota-dock-warn { flex: none; margin-left: 6px; color: var(--dsw-alias-label-secondary); }',
    ].join('\n')
    const STYLE = h('style', { key: 'quota-dock-style' }, CSS)

    /** GET the snapshot; null on any transport or parse failure. */
    async function readSnapshot() {
      const read = async url => {
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: timeoutSignal(15000),
        })
        if (response === null || response === undefined || response.ok !== true) return null
        const parsed = JSON.parse(await response.text())
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      }
      try {
        return await read(SNAPSHOT_URL)
      } catch (error) {
        return null
      }
    }

    /**
     * Read the Host snapshot, and when the Host has never succeeded, kick a
     * refresh and poll until numbers land — or until the ~30s budget runs out.
     * @param onSnapshot - called with each polled snapshot so numbers appear as
     * soon as they exist, rather than only when the whole routine returns.
     * @returns the last snapshot read, or null when the read itself failed.
     */
    async function runLoad(onSnapshot) {
      let snapshot = await readSnapshot()
      if (snapshot === null) return null
      const never = snapshot.fetchedAt === null || snapshot.fetchedAt === undefined
      if (!never) return snapshot
      try {
        await fetch(REFRESH_URL, { method: 'POST', signal: timeoutSignal(15000) })
      } catch (error) {
        // The poll below is what decides; a refused refresh is not fatal here.
      }
      const deadline = Date.now() + POLL_BUDGET_MS
      while (Date.now() < deadline) {
        await sleep(POLL_MS)
        const next = await readSnapshot()
        if (next === null) continue
        snapshot = next
        if (typeof onSnapshot === 'function') onSnapshot(next)
        if (next.fetchedAt !== null && next.fetchedAt !== undefined) break
      }
      return snapshot
    }

    /** Entry composed into the `conversation.input.dock` slot, above the composer. */
    function QuotaDock({ load, t }) {
      const [snapshot, setSnapshot] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      // True until the first load settles, so 查询中… does not depend on the Host
      // having set `fetching` on the very first snapshot.
      const [loading, setLoading] = React.useState(true)
      // Drives the 峰/谷 countdown re-render; the value itself is never read.
      const [, setTick] = React.useState(0)
      // The injected face is rebuilt on every render, so the loader rides a ref
      // and never enters a dependency array.
      const loader = React.useRef(load)
      loader.current = load

      React.useEffect(() => {
        let live = true
        const adopt = next => {
          if (live) {
            setSnapshot(next)
            setFailed(false)
          }
        }
        const pull = () => {
          if (typeof loader.current !== 'function') {
            setLoading(false)
            setFailed(true)
            return
          }
          Promise.resolve()
            .then(() => loader.current(adopt))
            .then(
              next => {
                if (!live) return
                setLoading(false)
                if (next === null || next === undefined) setFailed(true)
                else adopt(next)
              },
              () => {
                if (!live) return
                setLoading(false)
                setFailed(true)
              },
            )
        }
        pull()
        if (typeof window === 'undefined') return undefined
        const timer = window.setInterval(pull, REFRESH_MS)
        const ticker = window.setInterval(() => { setTick(value => value + 1) }, TICK_MS)
        const onFocus = () => { pull() }
        window.addEventListener('focus', onFocus)
        return () => {
          live = false
          window.clearInterval(timer)
          window.clearInterval(ticker)
          window.removeEventListener('focus', onFocus)
        }
      }, [])

      const numbers = hasNumbers(snapshot)
      // Re-render on a short tick so the 峰/谷 countdown stays honest without
      // waiting for the next upstream poll.
      const now = new Date()
      // 查询中… only while there is nothing numeric to show: once numbers exist
      // they stay on screen, refresh or not.
      const pending = !failed && !numbers
        && (loading || snapshot === null || snapshot.fetching === true)
      const text = numbers
        ? formatStrip(snapshot, t, now)
        : pending
          ? t('loading')
          : snapshot === null
            ? t('unavailable')
            : formatStrip(snapshot, t, now)
      // Bars whenever there are numbers: a window the Host could not report
      // still shows its empty track and an em dash rather than vanishing.
      const body = numbers && snapshot !== null
        ? renderCells(snapshot, t, now)
        : text
      const error = snapshot !== null && snapshot !== undefined && typeof snapshot.error === 'string'
        ? snapshot.error
        : null
      const warn = !pending && (failed || (snapshot !== null && snapshot !== undefined
        && (snapshot.stale === true || error !== null
          || snapshot.cc?.ok === false || snapshot.deepseek?.ok === false)))
      const title = warn ? `${text} · ${error ?? t('stale')}` : text

      return h(React.Fragment, null,
        STYLE,
        h('span', {
          className: 'dsh-quota-dock-root',
          'data-quota-dock': '',
          'data-warn': warn ? '' : undefined,
          title,
        },
        h('span', { className: 'dsh-quota-dock-strip' }, body),
        warn ? h('span', { className: 'dsh-quota-dock-warn', 'aria-hidden': true }, '⚠') : null))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, LOCALES), 'quota-dock: dictionaries')

        // One refresh loop at a time, shared by the initial load, the 5-minute
        // tick, and the focus refresh, so they cannot pile up on each other.
        let inFlight = null
        const load = onSnapshot => {
          if (inFlight !== null) return inFlight
          const pendingLoad = runLoad(onSnapshot)
          inFlight = pendingLoad
          const settle = () => { if (inFlight === pendingLoad) inFlight = null }
          pendingLoad.then(settle, settle)
          return pendingLoad
        }

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'quota-dock',
          order: -1, // first entry of the row directly above the composer card
          locale: NS,
          inject: () => ({ load }),
        }, QuotaDock))
      },
      // Pure, DOM-free helpers, additionally exported so an offline smoke test can
      // drive them without a browser; the slot loader reads only inject/apply.
      LOCALES,
      formatStrip,
      hasNumbers,
      barPercent,
      barLevel,
      cycleState,
      cycleText,
      durationText,
      renderCells,
    }
  },
})
