/**
 * Client half of the quota dock: one always-visible, centred line of usage on
 * the input dock — the full-width row directly above the composer card — so the
 * Command Code 5h / weekly / monthly windows, each with a thin fill bar and its
 * percentage, plus the DeepSeek rate clock are readable at a glance with no
 * click.
 *
 * Bars never replace the reading, in this shape:
 *   5h ▮▮▯▯▯ 6%  周 ▮▮▯▯▯ 14%  月 ▮▮▯▯▯ 12%  │  ▮▮▮▯ 峰时 · 距谷 3h42m
 * A missing reading becomes an em dash instead of `undefined` or `NaN`.
 *
 * Clicking that row slides a full-width money sheet down from the top edge of
 * the frame (`shell.overlay`): the three windows with their used/cap figures,
 * bars, percentages and reset countdowns, the monthly credit detail, every
 * DeepSeek wallet, and every other platform's balance. The sheet is money only —
 * it carries no form and no field for a credential.
 *
 * Platform configuration — list, add, remove — lives on its own settings page
 * (`settings.section`), beside the other entries in the settings sidebar.
 *
 * Row, sheet and settings page read one module-level store; only the row runs
 * the refresh loop.
 *
 * The data comes from this bundle's Host half over the same origin; the contract
 * (E:\dsh\dsh-quota-dock\CONTRACT.md) is the only interface between the halves.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quota-dock',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'quotaDock'

    const SNAPSHOT_URL = '/api/dsh-quota-dock/snapshot'
    const REFRESH_URL = '/api/dsh-quota-dock/refresh'
    const PLATFORMS_URL = '/api/dsh-quota-dock/platforms'
    /** Cadence while the first upstream read is still running, and its budget. */
    const POLL_MS = 2000
    const POLL_BUDGET_MS = 30000
    /** The countdown to the next rate switch re-renders this often. */
    const TICK_MS = 30 * 1000
    /**
     * The read loop: a read is also what makes the Host refresh (it answers from
     * cache and starts the cycle), so the cadence below IS the refresh timer.
     * Arrive just past the cache TTL, follow a running cycle closely, and back
     * off when the last cycle failed.
     */
    const FALLBACK_REFRESH_MS = 60 * 1000
    const READ_LEAD_MS = 500
    const FAST_FOLLOW_MS = 1500
    const MIN_READ_MS = 2000
    const OVERDUE_RETRY_MS = 15 * 1000
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
        stale: 'data is old',
        close: 'close',
        sheetTitle: 'Usage & balance',
        updated: 'updated',
        overviewRemaining: 'remaining',
        overviewUsed: 'used',
        overviewDaysLeft: 'days left',
        unitDays: '',
        monthRemaining: 'month left',
        monthUsed: 'month used',
        monthTotal: 'month total',
        periodEnd: 'period ends',
        resetsIn: 'to reset',
        plan: 'plan',
        purchased: 'purchased',
        free: 'free',
        threshold: 'alert below',
        balance: 'balance',
        total: 'total',
        granted: 'granted',
        toppedUp: 'topped up',
        available: 'available',
        unitCredits: 'credits',
        otherPlatforms: 'other platforms',
        schedule: 'off-peak 00:30-08:30, all weekend',
        fetchingNow: 'fetching…',
        settingsTitle: 'Quota & platforms',
        settingsHint: 'Configuration only — the amounts live on the row above the composer.',
        sectionPlatforms: 'Connected platforms',
        sectionAdd: 'Add a platform',
        sectionAbout: 'Notes',
        aboutText: 'The key stays in the local platforms.json; the endpoint only reports whether one is set. Each provider times out after 15s and one failure never affects the others.',
        kindCustom: 'Custom',
        stateOk: 'ok',
        stateBad: 'failed',
        platformsInSettings: 'platform access lives in Settings → Quota & platforms',
        resetLocal: 'reset times are local',
        otherNote: 'nothing yet — each connected platform gets one row here, with its balance and the time it was last read.',
        autoRefreshLead: 'every ',
        autoRefreshTail: ' auto refresh',
        refresh: 'refresh',
        addPlatform: 'add platform',
        platformName: 'name',
        kind: 'kind',
        baseUrl: 'endpoint',
        apiKey: 'API key',
        add: 'add',
        remove: 'remove',
        keySet: 'key set',
        keyMissing: 'key missing',
        none: 'none',
        emptyList: 'no platforms yet',
        emptyHint: 'add one below',
        unitSeconds: 's',
        unitMinutes: 'min',
        sectionBuiltin: 'Built-in providers',
        builtinNote: 'keys come from the environment',
        sectionData: 'Data & refresh',
        intervalLabel: 'refresh every',
        lastRefresh: 'last refresh',
        storeFile: 'store file',
        refreshNowLabel: 'refresh now',
        presetCustom: 'Custom',
        presetHint: 'a preset fills the address for you',
        addExisting: 'add one',
        fixedAddress: 'this provider address is fixed by the plugin',
        addressHint: 'Any JSON endpoint works: the Host flattens up to 50 numeric fields into rows.',
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
        stale: '数据较旧',
        close: '关闭',
        sheetTitle: '额度与余额',
        updated: '更新于',
        overviewRemaining: '本月剩余',
        overviewUsed: '本月已用',
        overviewDaysLeft: '还能用',
        unitDays: '天',
        monthRemaining: '月度剩余',
        monthUsed: '月度已用',
        monthTotal: '月度总额',
        periodEnd: '周期结束',
        resetsIn: '后重置',
        plan: '订阅',
        purchased: '购买额度',
        free: '赠送额度',
        threshold: '告警线',
        balance: '余额',
        total: '总额',
        granted: '赠送',
        toppedUp: '充值',
        available: '可用',
        unitCredits: 'credits',
        otherPlatforms: '其他平台',
        schedule: '谷 00:30–08:30（周末全天谷价）',
        fetchingNow: '拉取中…',
        settingsTitle: '额度与平台',
        settingsHint: '这里只管配置，金额看输入框上方那一行。',
        sectionPlatforms: '已接入平台',
        sectionAdd: '接入新平台',
        sectionAbout: '说明',
        aboutText: 'API key 只存在本机 platforms.json，接口只回传是否配置；单家超时 15 秒，失败不影响其他家。',
        kindCustom: '自定义',
        stateOk: '正常',
        stateBad: '失败',
        platformsInSettings: '平台接入在 设置 → 额度与平台',
        resetLocal: '重置时间按本地时区',
        otherNote: '暂无。已接入的平台会在这里各占一行，显示余额和最近一次读取的时间。',
        autoRefreshLead: '每 ',
        autoRefreshTail: '自动重取一次',
        refresh: '刷新',
        addPlatform: '接入平台',
        platformName: '名称',
        kind: '类型',
        baseUrl: '接口地址',
        apiKey: 'API key',
        add: '添加',
        remove: '删除',
        keySet: '已配置 key',
        keyMissing: '未配置 key',
        none: '暂无',
        emptyList: '还没有接入任何平台',
        emptyHint: '下面添加一个即可',
        unitSeconds: '秒',
        unitMinutes: '分钟',
        sectionBuiltin: '内置平台',
        builtinNote: 'key 从环境变量读',
        sectionData: '数据与刷新',
        intervalLabel: '刷新间隔',
        lastRefresh: '最近刷新',
        storeFile: '配置文件',
        refreshNowLabel: '立即刷新',
        presetCustom: '自定义',
        presetHint: '选预设可省掉填地址',
        addExisting: '去添加',
        fixedAddress: '这一家的地址由插件固定',
        addressHint: '任何返回 JSON 的余额接口都能接：Host 会把最多 50 个数字字段平铺成行。',
      },
    }

    /* ---- shared store ------------------------------------------------------
     * The row, the sheet and the settings page are three separate components on
     * three separate slots, so they cannot share React state. They share this
     * module-level store instead; only the row owns the polling loop and the
     * settings page owns the platform list, so nothing polls twice.
     */
    const store = {
      snapshot: null,
      /** 'loading' | 'ready' | 'failed' — what the last row load settled on. */
      phase: 'loading',
      /** The clock; the ticker republishes it so every surface agrees on now. */
      now: Date.now(),
      /** Whether the money sheet is slid in. */
      panelOpen: false,
      listeners: new Set(),
    }

    /** Merge a patch into the store and wake every subscriber. */
    function publish(patch) {
      Object.assign(store, patch)
      store.listeners.forEach(listener => {
        try {
          listener()
        } catch (error) {
          // One broken subscriber must not stop the others from repainting.
        }
      })
    }

    /** Subscribe the calling component to the store. */
    function useStore() {
      const [, bump] = React.useReducer(value => value + 1, 0)
      React.useEffect(() => {
        store.listeners.add(bump)
        return () => { store.listeners.delete(bump) }
      }, [])
      return store
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

    /** `window.setTimeout`, or the global one in a runtime without a window. */
    const setTimer = (fn, ms) => (typeof window !== 'undefined' && typeof window.setTimeout === 'function'
      ? window.setTimeout(fn, ms)
      : setTimeout(fn, ms))

    /** Cancel a timer started by `setTimer`; a missing id is a no-op. */
    const clearTimer = id => {
      if (id === null || id === undefined) return
      if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') window.clearTimeout(id)
      else clearTimeout(id)
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

    /**
     * A usable instant in ms, or null. The contract hands out ISO strings, but
     * numbers are accepted too, so a host that switches to epoch ms keeps working.
     */
    function toMs(value) {
      const number = toNum(value)
      if (number !== null) return number
      if (typeof value === 'string') {
        const parsed = Date.parse(value)
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    }

    const round2 = value => Math.round(value * 100) / 100

    /** Credit count as text; anything unusable reads as an em dash. */
    function numText(value) {
      const number = toNum(value)
      if (number === null) return '—'
      return Number.isInteger(number) ? String(number) : String(round2(number))
    }

    /** Currency mark: a known code becomes its symbol, an unknown one a suffix. */
    const CURRENCY_MARKS = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥', KRW: '₩', HKD: 'HK$', TWD: 'NT$' }

    /**
     * A money amount with its unit: `36.16` + `CNY` reads `¥36.16`, an unknown
     * code reads `36.16 XYZ`, and no code at all leaves the bare number.
     */
    function moneyText(value, code) {
      const text = numText(value)
      if (text === '—') return text
      const key = typeof code === 'string' ? code.trim().toUpperCase() : ''
      if (key === '') return text
      const mark = CURRENCY_MARKS[key]
      return mark === undefined ? `${text} ${key}` : `${mark}${text}`
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
      return `${parts.join(' ')} ${cycleText(tr, now)}`
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
          ' ',
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

    /** Local `MM-DD HH:mm`, or null when the value is unusable. */
    function fmtClock(value) {
      const ms = toMs(value)
      if (ms === null) return null
      const date = new Date(ms)
      if (Number.isNaN(date.getTime())) return null
      const pad = part => String(part).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** `3h12m` until the instant; null when it is absent or already past. */
    function fmtCountdown(value, now) {
      const ms = toMs(value)
      if (ms === null) return null
      const rest = ms - now.getTime()
      if (!Number.isFinite(rest) || rest <= 0) return null
      const minutes = Math.round(rest / 60000)
      const hours = Math.floor(minutes / 60)
      return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`
    }

    /** `3h12m 后重置`, or — when the window has no usable reset instant. */
    function resetText(window, t, now) {
      const countdown = window === null ? null : fmtCountdown(window.resetAt, now)
      return countdown === null ? '—' : `${countdown} ${t('resetsIn')}`
    }

    /** `更新于 10-18 02:52`, or an empty string when the Host never succeeded. */
    function ageText(snapshot, t) {
      if (snapshot === null || snapshot === undefined) return ''
      const clock = fmtClock(snapshot.fetchedAt)
      if (clock === null) return ''
      // The age is only called out once it is genuinely old: a low-key suffix
      // rather than a permanent "possibly stale" nag.
      const fetchedAt = toMs(snapshot?.fetchedAt)
      const old = fetchedAt !== null && Date.now() - fetchedAt > 24 * 60 * 60 * 1000
      return old ? `${t('updated')} ${clock} · ${t('stale')}` : `${t('updated')} ${clock}`
    }

    /**
     * What a non-Command-Code platform is worth, as one finished string: an
     * explicit `balance` field first, then a `fields` entry named like a balance,
     * then the error, and only then the raw fields. Never the API key.
     */
    function platformMoney(entry, t) {
      if (entry === null || entry === undefined) return t('none')
      if (toNum(entry.balance) !== null) return numText(entry.balance)
      const fields = Array.isArray(entry.fields) ? entry.fields : []
      const named = fields.find(field => field !== null && field !== undefined
        && /balance|余额/i.test(String(field.label ?? '')))
      if (named !== undefined && named !== null) return String(named.value ?? '—')
      if (entry.ok === false) return entry.error ?? t('unavailable')
      if (fields.length > 0) {
        return fields.map(field => `${field?.label ?? '—'} ${field?.value ?? '—'}`).join(' · ')
      }
      return t('none')
    }

    /**
     * The money sheet's three cards as plain data, so the offline smoke test can
     * assert them without a browser. Every value is a finished string.
     */
    /**
     * Rough runway left at the current burn rate: `remaining / (used / elapsed)`
     * days. Null — rendered as `—` — whenever the estimate would be a guess:
     * nothing used yet, no usable period start, or a non-finite division.
     */
    function daysLeft(cc, now) {
      const remaining = toNum(cc?.remainingMonthlyCredits)
      const used = toNum(cc?.usedMonthlyCredits)
      if (remaining === null || used === null || used <= 0) return null
      const start = toMs(cc?.subscription?.currentPeriodStart)
      const from = start === null ? now.getTime() - 30 * 86400000 : start
      const elapsedDays = (now.getTime() - from) / 86400000
      if (!Number.isFinite(elapsedDays) || elapsedDays <= 0) return null
      const perDay = used / elapsedDays
      if (!Number.isFinite(perDay) || perDay <= 0) return null
      const days = remaining / perDay
      return Number.isFinite(days) && days >= 0 ? days : null
    }

    /** `12.3` / `<0.1` / `0` / `—` — one decimal, and never Infinity or NaN. */
    function daysText(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '—'
      if (value <= 0) return '0'
      if (value < 0.1) return '<0.1'
      return String(Math.round(value * 10) / 10)
    }

    function sheetCards(snapshot, t, now) {
      const snap = snapshot ?? {}
      const cc = snap.cc ?? {}
      const deepseek = snap.deepseek ?? {}
      const subscription = cc.subscription ?? {}
      const creditUnit = t('unitCredits')
      /** Amounts are Command Code credits, so every one of them carries the unit. */
      const withCredits = text => (text === '—' || text === '' ? text : `$${text}`)
      const windows = SHOWN_WINDOW_IDS.map(id => {
        const window = windowOf(cc, id)
        return {
          key: id,
          label: t(id),
          value: withCredits(ratioText(window?.used, window?.cap)),
          // A month-away countdown is noise; that row carries the date instead.
          reset: id === 'monthly'
            ? (fmtClock(window?.resetAt) ?? resetText(window, t, now))
            : resetText(window, t, now),
          window,
        }
      })
      const plan = [subscription.planId, subscription.status]
        .filter(part => part !== null && part !== undefined && part !== '')
        .join(' · ') || '—'
      /**
       * The month's own figures, flattened onto a single line under the month row.
       * They used to sit in a second block that repeated the word 月; the row above
       * already names it, and its right-hand column already carries the period end,
       * so neither is repeated here.
       */
      const detail = [
        { label: t('monthUsed'), value: withCredits(numText(cc.usedMonthlyCredits)) },
        { label: t('monthRemaining'), value: withCredits(numText(cc.remainingMonthlyCredits)) },
        { label: t('plan'), value: plan },
      ]
      const wallets = (Array.isArray(deepseek.balances) ? deepseek.balances : []).map((wallet, index) => ({
        key: `wallet-${index}`,
        currency: wallet?.currency ?? `#${index + 1}`,
        money: [
          { label: t('total'), value: moneyText(wallet?.totalBalance, wallet?.currency) },
          { label: t('granted'), value: moneyText(wallet?.grantedBalance, wallet?.currency) },
          { label: t('toppedUp'), value: moneyText(wallet?.toppedUpBalance, wallet?.currency) },
        ],
      }))
      const extras = []
      if (deepseek.isAvailable !== undefined && deepseek.isAvailable !== null) {
        // The state word always rides with the mark: colour alone never carries it.
        extras.push({
          label: t('available'),
          state: deepseek.isAvailable === true ? 'ok' : 'bad',
          value: deepseek.isAvailable === true ? t('stateOk') : t('stateBad'),
        })
      }
      const platforms = (Array.isArray(snap.platforms) ? snap.platforms : []).map((entry, index) => {
        const value = platformMoney(entry, t)
        // OpenRouter bills in USD; a custom endpoint has no known unit.
        const code = entry?.kind === 'openrouter' ? 'USD' : ''
        return {
          key: entry?.id ?? `platform-${index}`,
          label: entry?.name ?? entry?.id ?? `#${index + 1}`,
          kind: entry?.kind ?? '',
          value: code !== '' && toNum(value) !== null ? moneyText(value, code) : value,
        }
      })
      const overview = {
        remaining: withCredits(numText(cc.remainingMonthlyCredits)),
        used: withCredits(numText(cc.usedMonthlyCredits)),
        days: daysText(daysLeft(cc, now)),
      }
      return { overview, windows, detail, wallets, extras, platforms }
    }

    /**
     * The money sheet itself: a centred floating panel, money only — there is
     * deliberately no form, no add button and no credential field anywhere in
     * this tree.
     *
     * There is no page-wide backdrop: the wrapper spans only the panel, so the
     * rest of the frame keeps its hover and its clicks; the close button,
     * Escape and the always-on row all close the sheet.
     */
    function sheetTree(state) {
      const { t, now, snapshot, busy, onClose, onRefresh } = state
      const cards = sheetCards(snapshot, t, now)
      const snap = snapshot ?? {}
      const ccOk = snap.cc?.ok !== false
      const dsOk = snap.deepseek?.ok !== false
      const cap = toNum(snap.cc?.monthlyCap)
      const used = toNum(snap.cc?.usedMonthlyCredits)
      // Only present when both figures exist: a dash here would read as missing data.
      const usedShare = cap !== null && cap > 0 && used !== null
        ? `${Math.round((used / cap) * 100)}%`
        : null
      const card = (key, title, options, children) => h('section', {
        className: options.wide === true
          ? 'dsh-quota-dock-card dsh-quota-dock-card-wide'
          : 'dsh-quota-dock-card',
        'data-quota-card': key,
        key,
      },
      h('div', { className: 'dsh-quota-dock-card-head', key: 'head' },
        h('span', { className: 'dsh-quota-dock-card-title', key: 'title' }, title),
        options.note === undefined || options.note === null || options.note === ''
          ? null
          : h('span', { className: 'dsh-quota-dock-card-note', key: 'note' }, options.note)),
      ...children)
      /** Key/value rows on a shared baseline; falsy rows drop out instead of printing a dash. */
      const kv = (rows, key) => h('div', { className: 'dsh-quota-dock-kv', key },
        ...rows.flatMap((row, index) => {
          const value = row.value === null || row.value === undefined || row.value === ''
            ? '—'
            : String(row.value)
          return [
            h('span', { className: 'dsh-quota-dock-kv-label', key: `${index}-label` }, row.label),
            row.state === undefined
              ? h('span', { className: 'dsh-quota-dock-kv-value', key: `${index}-value` }, value)
              : h('span', {
                  className: 'dsh-quota-dock-status',
                  'data-state': row.state,
                  key: `${index}-value`,
                },
                  h('i', { key: 'dot' }),
                  value),
          ]
        }))
      const stat = (key, label, value) => h('div', { className: 'dsh-quota-dock-stat', key },
        h('span', { className: 'dsh-quota-dock-stat-label', key: 'label' }, label),
        h('span', { className: 'dsh-quota-dock-stat-value', key: 'value' }, value))
      const hero = h('div', {
        className: 'dsh-quota-dock-hero',
        'data-quota-card': 'overview',
        key: 'overview',
      },
      h('div', { className: 'dsh-quota-dock-hero-main', key: 'main' },
        h('span', { className: 'dsh-quota-dock-hero-label', key: 'label' }, t('overviewRemaining')),
        h('span', { className: 'dsh-quota-dock-hero-value', key: 'value' }, cards.overview.remaining)),
      h('div', { className: 'dsh-quota-dock-stats', key: 'side' },
        stat('used', t('overviewUsed'), cards.overview.used),
        stat('days', t('overviewDaysLeft'), `${cards.overview.days} ${t('unitDays')}`),
        usedShare === null ? null : stat('share', t('monthUsed'), usedShare)))
      const windowRows = cards.windows.map(window => h('div', {
        className: 'dsh-quota-dock-qrow',
        'data-quota-window': window.key,
        key: window.key,
      },
        h('span', { className: 'dsh-quota-dock-qk', key: 'label' }, window.label),
        h('span', { className: 'dsh-quota-dock-qv', key: 'value' }, window.value),
        renderBar(window.window, window.label, t),
        renderPercent(window.window),
        h('span', { className: 'dsh-quota-dock-qr', key: 'reset' }, window.reset)))
      // The month's figures on one line; a missing cap simply drops its own cell.
      const detailRows = [
        ...cards.detail,
        cap === null ? null : { label: t('monthTotal'), value: `${"$"}${numText(cap)}` },
      ].filter(row => row !== null)
      const detailKids = []
      detailRows.forEach((row, index) => {
        if (index > 0) {
          detailKids.push(h('span', { className: 'dsh-quota-dock-detail-sep', key: `${index}-sep` }, '·'))
        }
        detailKids.push(h('span', { key: `${index}-row`, className: 'dsh-quota-dock-detail-cell' },
          `${row.label} `,
          h('b', { key: `${index}-value` }, row.value)))
      })
      const wallets = cards.wallets.length === 0
        ? [h('div', { className: 'dsh-quota-dock-empty', key: 'none' }, t('none'))]
        : cards.wallets.flatMap(wallet => [
            cards.wallets.length > 1
              ? h('div', { className: 'dsh-quota-dock-cur', key: `${wallet.key}-cur` },
                  String(wallet.currency).toUpperCase())
              : null,
            kv(wallet.money, `${wallet.key}-money`),
          ])
      const platformRows = cards.platforms.length === 0
        ? [h('p', {
            className: 'dsh-quota-dock-note dsh-quota-dock-note-solo',
            key: 'none',
          }, t('otherNote'))]
        : cards.platforms.map(entry => h('div', {
            className: 'dsh-quota-dock-prow',
            key: entry.key,
          },
            h('span', { className: 'dsh-quota-dock-prow-name', key: 'name' }, entry.label),
            entry.kind ? h('span', { className: 'dsh-quota-dock-prow-kind', key: 'kind' }, entry.kind) : null,
            h('span', { className: 'dsh-quota-dock-prow-money', key: 'money' }, entry.value)))
      const platformNote = cards.platforms.length === 0
        ? null
        : h('p', { className: 'dsh-quota-dock-note', key: 'count' },
            `${t('sectionPlatforms')} ${cards.platforms.length}`)
      const walletNote = cards.wallets.length === 1
        ? String(cards.wallets[0].currency).toUpperCase()
        : null
      const cadence = snapshot === null || snapshot === undefined ? null : snapshot.refreshMs
      const footLeft = Number.isFinite(cadence)
        ? `${t('autoRefreshLead')}${intervalLabel(cadence, t)}${t('autoRefreshTail')}`
        : t('platformsInSettings')
      return h('div', {
        className: 'dsh-quota-dock-layer',
        'data-quota-sheet': '',
        style: { pointerEvents: 'auto' },
      },
        h('div', {
          className: 'dsh-quota-dock-sheet',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('sheetTitle'),
        },
          h('div', { className: 'dsh-quota-dock-sheet-head', key: 'head' },
            h('div', { className: 'dsh-quota-dock-sheet-id', key: 'id' },
              h('span', { className: 'dsh-quota-dock-sheet-title', key: 'title' }, t('sheetTitle')),
              h('span', { className: 'dsh-quota-dock-sheet-age', key: 'age' }, ageText(snapshot, t))),
            h('div', { className: 'dsh-quota-dock-chips', key: 'chips' },
              h('span', { className: 'dsh-quota-dock-chip', 'data-state': ccOk ? 'ok' : 'bad', key: 'cc' },
                'CC ', ccOk ? t('stateOk') : t('stateBad')),
              h('span', { className: 'dsh-quota-dock-chip', 'data-state': dsOk ? 'ok' : 'bad', key: 'ds' },
                'DS ', dsOk ? t('stateOk') : t('stateBad'))),
            h('button', {
              type: 'button',
              className: 'dsh-quota-dock-ghost',
              key: 'refresh',
              disabled: busy === true,
              onClick: onRefresh,
            }, t('refresh')),
            h('button', {
              type: 'button',
              className: 'dsh-quota-dock-sheet-close',
              key: 'close',
              'aria-label': t('close'),
              onClick: onClose,
            }, '×')),
          hero,
          h('div', { className: 'dsh-quota-dock-rule', key: 'rule' }),
          h('div', { className: 'dsh-quota-dock-grid', key: 'grid' },
            card('cc', 'Command Code', { wide: true, note: t('resetLocal') }, [
              ...windowRows,
              h('div', { className: 'dsh-quota-dock-detail', key: 'detail' }, ...detailKids),
            ]),
            card('deepseek', 'DeepSeek', { note: walletNote }, [
              ...wallets,
              cards.extras.length === 0 ? null : kv(cards.extras, 'extras-kv'),
              h('p', { className: 'dsh-quota-dock-note', key: 'cycle' }, cycleText(t, now)),
            ]),
            card('platforms', t('otherPlatforms'), {}, [...platformRows, platformNote])),
          h('div', { className: 'dsh-quota-dock-sheet-foot', key: 'foot' },
            h('span', { key: 'cadence' }, footLeft),
            h('span', { key: 'where' }, t('platformsInSettings')))))
    }

    /** One configured platform: what it is, its last result, its amount, remove. */
    function platformRow(entry, index, t, onRemove) {
      const key = entry?.id ?? `platform-${index}`
      const ok = entry?.ok === true
      return h('div', { className: 'dsh-quota-dock-plat', key },
        h('span', {
          className: 'dsh-quota-dock-dot',
          'data-quota-dot': ok ? 'ok' : 'bad',
          'aria-hidden': true,
        }),
        h('div', { className: 'dsh-quota-dock-brow-text', key: 'text' },
          h('div', { className: 'dsh-quota-dock-brow-name', key: 'name' },
            String(entry?.name ?? entry?.id ?? '—')),
          h('div', { className: 'dsh-quota-dock-brow-sub', key: 'sub' },
            [entry?.kind, entry?.baseUrl]
              .filter(part => typeof part === 'string' && part !== '')
              .join(' · '))),
        h('span', {
          className: 'dsh-quota-dock-pstate',
          'data-quota-state': ok ? 'ok' : 'bad',
        }, ok ? t('stateOk') : t('stateBad')),
        h('span', { className: 'dsh-quota-dock-pmoney' }, platformMoney(entry, t)),
        h('button', {
          type: 'button',
          className: 'dsh-quota-dock-remove',
          key: `${key}-remove`,
          onClick: () => onRemove(entry?.id),
        }, t('remove')))
    }

    /** Cadences the settings page offers; the Host validates the value again. */
    const REFRESH_CHOICES = [30_000, 60_000, 120_000, 300_000, 600_000]

    /**
     * Platform presets. A preset only fills a name and an address — the key is
     * always typed. OpenRouter's address is fixed by the Host; the others point
     * at JSON endpoints whose numeric fields the Host flattens without needing a
     * per-vendor adapter, so a self-hosted address stays editable.
     */
    const PRESETS = [
      { id: 'openrouter', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1/credits' },
      { id: 'litellm', name: 'LiteLLM', kind: 'custom', baseUrl: '' },
      { id: 'newapi', name: 'New API', kind: 'custom', baseUrl: '' },
      { id: 'siliconflow', name: '硅基流动', kind: 'custom', baseUrl: 'https://api.siliconflow.cn/v1/user/info' },
      { id: 'kimi', name: 'Kimi', kind: 'custom', baseUrl: 'https://api.moonshot.cn/v1/users/me/balance' },
      { id: 'custom', name: '', kind: 'custom', baseUrl: '' },
    ]

    /** `30_000` reads `30 秒`, `600_000` reads `10 分钟`. */
    function intervalLabel(ms, t) {
      const seconds = Math.round(ms / 1000)
      return seconds < 60
        ? `${seconds} ${t('unitSeconds')}`
        : `${Math.round(seconds / 60)} ${t('unitMinutes')}`
    }

    /**
     * The settings page: one row per provider, a preset picker for a new one, and
     * the refresh cadence. Money lives on the row and in the sheet; the figures
     * here are a reminder of what is configured, not the reading.
     */
    function settingsTree(state) {
      const {
        t, platforms, refreshMs, storePath, form, busy, message, snapshot,
        onForm, onAdd, onRemove, onRefresh, onInterval,
      } = state
      const section = (id, title, aside, children) => h('section', {
        className: 'dsh-quota-dock-sec',
        'data-quota-section': id,
        key: id,
      },
      h('div', { className: 'dsh-quota-dock-sec-head', key: 'head' },
        h('h3', { className: 'dsh-quota-dock-sec-title', key: 'title' }, title),
        aside === null || aside === undefined || aside === ''
          ? null
          : h('span', { className: 'dsh-quota-dock-sec-aside', key: 'aside' }, String(aside))),
      ...children)
      const field = (key, label, input) => h('label', {
        className: 'dsh-quota-dock-field',
        key,
      }, h('span', { className: 'dsh-quota-dock-field-label', key: 'label' }, label), input)
      const preset = PRESETS.find(entry => entry.id === form.preset) ?? PRESETS[0]
      const fixedAddress = preset.id === 'openrouter'
      const age = ageText(snapshot, t)
      const cc = snapshot?.cc ?? {}
      const deepseek = snapshot?.deepseek ?? {}
      const cap = toNum(cc.monthlyCap)
      const used = toNum(cc.usedMonthlyCredits)
      const percent = cap !== null && cap > 0 && used !== null ? Math.round((used / cap) * 100) : null
      const wallet = Array.isArray(deepseek.balances) ? deepseek.balances[0] : null
      const list = Array.isArray(platforms) ? platforms : null
      const healthy = list === null ? null : list.filter(entry => entry?.ok === true).length
      const broken = list === null ? null : list.length - healthy
      const summary = (key, label, value) => h('div', { className: 'dsh-quota-dock-sum', key },
        h('span', { className: 'dsh-quota-dock-sum-value', key: 'v' }, value),
        h('span', { className: 'dsh-quota-dock-sum-label', key: 'l' }, label))
      /** One built-in row: what it reads, how much of the month is gone, when it last answered. */
      const builtinRow = (key, name, ref, value, ok, share) => h('div', {
        className: 'dsh-quota-dock-brow',
        key,
      },
      h('div', { className: 'dsh-quota-dock-brow-main', key: 'main' },
        h('span', {
          className: 'dsh-quota-dock-dot',
          'data-quota-dot': ok === true ? 'ok' : 'bad',
          'aria-hidden': true,
          key: 'dot',
        }),
        h('div', { className: 'dsh-quota-dock-brow-text', key: 'text' },
          h('div', { className: 'dsh-quota-dock-brow-name', key: 'name' }, name),
          h('div', { className: 'dsh-quota-dock-brow-sub', key: 'sub' }, ref))),
      share === null
        ? null
        : h('span', { className: 'dsh-quota-dock-mini', key: 'share', 'aria-hidden': true },
            h('i', { style: { width: `${share}%` } })),
      h('span', { className: 'dsh-quota-dock-brow-value', key: 'value' }, value),
      h('span', { className: 'dsh-quota-dock-brow-age', key: 'age' }, age),
      h('button', {
        type: 'button',
        className: 'dsh-quota-dock-ghost dsh-quota-dock-ghost-sm',
        key: 'refresh',
        disabled: busy === true,
        onClick: onRefresh,
      }, t('refresh')))
      const emptyState = h('div', { className: 'dsh-quota-dock-empty-row', key: 'empty' },
        h('div', { key: 'text' },
          h('div', { className: 'dsh-quota-dock-empty-title', key: 'title' }, t('emptyList')),
          h('div', { className: 'dsh-quota-dock-empty-sub', key: 'sub' }, t('emptyHint'))),
        h('button', {
          type: 'button',
          className: 'dsh-quota-dock-ghost dsh-quota-dock-ghost-sm',
          key: 'jump',
          onClick: () => {
            if (typeof document === 'undefined') return
            const node = document.querySelector('[data-quota-section="add"]')
            if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
          },
        }, t('addExisting')))
      const listBody = platforms === null
        ? [h('div', { className: 'dsh-quota-dock-empty', key: 'waiting' }, t('fetchingNow'))]
        : platforms.length === 0
          ? [emptyState]
          : platforms.map((entry, index) => platformRow(entry, index, t, onRemove))
      const chip = entry => h('button', {
        type: 'button',
        className: 'dsh-quota-dock-pill',
        'data-quota-preset': entry.id,
        'data-quota-kind': entry.kind,
        'data-active': form.preset === entry.id ? '' : undefined,
        key: entry.id,
        onClick: () => onForm({ preset: entry.id, name: entry.name, baseUrl: entry.baseUrl, kind: entry.kind }),
      }, entry.name === '' ? t('presetCustom') : entry.name)
      const pref = (key, label, control) => h('div', { className: 'dsh-quota-dock-pref', key },
        h('span', { className: 'dsh-quota-dock-pref-label', key: 'label' }, label),
        h('div', { className: 'dsh-quota-dock-pref-control', key: 'control' }, control))
      return h('div', { className: 'dsh-quota-dock-set', 'data-quota-settings': '' },
        h('div', { className: 'dsh-quota-dock-set-head' },
          h('h2', { className: 'dsh-quota-dock-set-title' }, t('settingsTitle')),
          h('button', {
            type: 'button',
            className: 'dsh-quota-dock-ghost',
            key: 'refresh',
            disabled: busy === true,
            onClick: onRefresh,
          }, t('refresh'))),
        h('p', { className: 'dsh-quota-dock-set-hint' }, t('settingsHint')),
        h('div', { className: 'dsh-quota-dock-summary' },
          summary('total', t('sectionPlatforms'), list === null ? '—' : String(list.length)),
          summary('ok', t('stateOk'), healthy === null ? '—' : String(healthy)),
          summary('bad', t('stateBad'), broken === null ? '—' : String(broken)),
          summary('cadence', t('intervalLabel'), intervalLabel(refreshMs, t))),
        section('builtin', t('sectionBuiltin'), t('builtinNote'), [
          h('div', { className: 'dsh-quota-dock-card-flat', key: 'rows' },
            builtinRow('cc', 'Command Code', 'COMMANDCODE_API_KEY',
              percent === null ? '—' : `${t('monthly')} ${percent}%`, cc.ok === true, percent),
            builtinRow('deepseek', 'DeepSeek', 'DEEPSEEK_API_KEY',
              wallet === null ? '—' : moneyText(wallet.totalBalance, wallet.currency), deepseek.ok === true, null)),
        ]),
        section('platforms', t('sectionPlatforms'), platforms === null ? null : String(platforms.length), [
          h('div', { className: 'dsh-quota-dock-list', key: 'list' }, ...listBody),
        ]),
        section('add', t('sectionAdd'), t('presetHint'), [
          h('div', { className: 'dsh-quota-dock-pills', key: 'pills' }, ...PRESETS.map(chip)),
          fixedAddress
            ? h('div', { className: 'dsh-quota-dock-fixed', key: 'fixed' },
                h('span', { className: 'dsh-quota-dock-field-label', key: 'label' }, t('baseUrl')),
                h('code', { className: 'dsh-quota-dock-file', key: 'value' }, PRESETS[0].baseUrl),
                h('p', { className: 'dsh-quota-dock-hint', key: 'hint' }, t('fixedAddress')))
            : field('name', t('platformName'), h('input', {
                value: form.name,
                placeholder: 'LiteLLM',
                onChange: event => onForm({ name: event.target.value }),
              })),
          fixedAddress
            ? null
            : field('baseUrl', t('baseUrl'), h('input', {
                value: form.baseUrl,
                placeholder: 'https://…',
                onChange: event => onForm({ baseUrl: event.target.value }),
              })),
          field('apiKey', t('apiKey'), h('input', {
            type: 'password',
            value: form.apiKey,
            onChange: event => onForm({ apiKey: event.target.value }),
          })),
          h('p', { className: 'dsh-quota-dock-hint', key: 'hint' }, t('addressHint')),
          h('p', { className: 'dsh-quota-dock-hint', key: 'key-hint' }, t('aboutText')),
          h('div', { className: 'dsh-quota-dock-form-actions', key: 'actions' },
            h('button', {
              type: 'button',
              className: 'dsh-quota-dock-submit',
              key: 'submit',
              disabled: busy === true || form.apiKey.trim() === '',
              onClick: onAdd,
            }, t('add'))),
        ]),
        section('data', t('sectionData'), null, [
          h('div', { className: 'dsh-quota-dock-prefs', key: 'prefs' },
            pref('interval', t('intervalLabel'),
              h('div', { className: 'dsh-quota-dock-pref-control' },
                h('select', {
                  className: 'dsh-quota-dock-select',
                  value: String(refreshMs),
                  onChange: event => onInterval(Number(event.target.value)),
                }, ...REFRESH_CHOICES.map(ms => h('option', { value: String(ms), key: ms }, intervalLabel(ms, t)))),
                h('button', {
                  type: 'button',
                  className: 'dsh-quota-dock-ghost dsh-quota-dock-ghost-sm',
                  key: 'now',
                  disabled: busy === true,
                  onClick: onRefresh,
                }, t('refreshNowLabel')))),
            pref('age', t('lastRefresh'),
              h('span', { className: 'dsh-quota-dock-pref-value', key: 'v' }, age)),
            pref('file', t('storeFile'),
              h('code', { className: 'dsh-quota-dock-file', key: 'v' },
                storePath === null || storePath === undefined ? '—' : String(storePath)))),
        ]),
        message === null || message === undefined
          ? null
          : h('div', { className: 'dsh-quota-dock-pmsg', key: 'message' }, String(message)))
    }

    const CSS = [
      '/* ---- token layer ----------------------------------------------------------',
      '   Components read --qd-*; --qd-* maps the host --dsw-* tokens so the surfaces',
      '   follow the skin, the theme and the density the rest of DSH uses.',
      '   The three state colours are ours, not the host\'s: the host palette is',
      '   green-500 #22c55e / amber-500 #f59e0b / red-500 #ef4444, which reads as a',
      '   warning light next to this type scale. These are the muted equivalents. */',
      '.dsh-quota-dock-root, .dsh-quota-dock-set, .dsh-quota-dock-sheet {',
      '  --qd-layer-0: var(--dsw-alias-bg-base, #fff);',
      '  --qd-layer-1: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-l1, #fafafa));',
      '  --qd-layer-2: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-l1, #fff));',
      '  --qd-card-fill: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-l1, #f7f7f8));',
      '  --qd-card-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1, rgb(127 127 127 / 16%)));',
      '  --qd-border-1: var(--dsw-alias-border-l1, rgb(127 127 127 / 16%));',
      '  --qd-border-2: var(--dsw-alias-border-l2, rgb(127 127 127 / 28%));',
      '  --qd-border-3: var(--dsw-alias-border-l3, rgb(127 127 127 / 40%));',
      '  --qd-label-1: var(--dsw-alias-label-primary, #17181a);',
      '  --qd-label-2: var(--dsw-alias-label-secondary, #5f6368);',
      '  --qd-label-3: var(--dsw-alias-label-tertiary, #8a8a8a);',
      '  --qd-label-4: var(--dsw-alias-label-caption, var(--dsw-alias-label-quaternary, #a0a4a9));',
      '  --qd-brand: var(--dsw-alias-brand-primary, #3d6fd6);',
      '  --qd-success: #4f8d6c;',
      '  --qd-warn: #b9812f;',
      '  --qd-error: #c05a52;',
      '  --qd-idle: var(--dsw-alias-label-quaternary, #9aa0a6);',
      '  --qd-fill-1: var(--dsw-alias-fill-l1, rgb(127 127 127 / 8%));',
      '  --qd-fill-2: var(--dsw-alias-fill-l2, rgb(127 127 127 / 16%));',
      '  --qd-hover: var(--dsw-alias-interactive-bg-hover, rgb(127 127 127 / 8%));',
      '  --qd-focus: var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #3d6fd6));',
      '  --qd-r-xs: var(--dsw-radius-xs, 4px);',
      '  --qd-r-sm: var(--dsw-radius-sm, 6px);',
      '  --qd-r-md: var(--dsw-radius-md, 8px);',
      '  --qd-r-lg: var(--dsw-radius-lg, 10px);',
      '  --qd-r-panel: var(--dsw-radius-panel, 12px);',
      '  --qd-elev: var(--dsw-elevation-prominent, 0 24px 64px -12px rgb(0 0 0 / 22%), 0 2px 8px rgb(0 0 0 / 6%));',
      '}',
      '/* ---- the row above the composer: three windows plus the DS cycle clock ---- */',
      '.dsh-quota-dock-root {',
      '  position: relative; display: inline-flex; align-items: center; width: 100%;',
      '  box-sizing: border-box; padding: 2px 2px 6px;',
      '  color: var(--qd-label-3);',
      '  font-size: 11.5px; line-height: 18px; font-variant-numeric: tabular-nums;',
      '}',
      '.dsh-quota-dock-row {',
      '  display: inline-flex; flex: 0 1 auto; min-width: 0; margin: 0 auto; justify-content: center; align-items: center;',
      '  gap: 8px; padding: 2px 10px; border: 0; border-radius: var(--qd-r-sm); background: transparent;',
      '  color: inherit; font: inherit; cursor: pointer;',
      '  transition: background-color 120ms ease-out;',
      '}',
      '.dsh-quota-dock-row:hover { background: var(--qd-hover); }',
      '.dsh-quota-dock-row:focus-visible { outline: 2px solid var(--qd-focus); outline-offset: 1px; }',
      '.dsh-quota-dock-strip {',
      '  display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 10px;',
      '  flex: 0 1 auto; min-width: 0;',
      '}',
      '.dsh-quota-dock-cell { display: inline-flex; align-items: center; gap: 6px; flex: none; }',
      '.dsh-quota-dock-label { color: var(--qd-label-3); font-weight: 500; }',
      '.dsh-quota-dock-pct { flex: none; color: var(--qd-label-2); font-weight: 500; font-variant-numeric: tabular-nums; }',
      '.dsh-quota-dock-pct[data-level="warn"] { color: var(--qd-warn); }',
      '.dsh-quota-dock-pct[data-level="high"] { color: var(--qd-error); }',
      '.dsh-quota-dock-pct[data-level="unknown"] { color: var(--qd-label-3); }',
      '.dsh-quota-dock-bar {',
      '  display: inline-block; flex: none; width: 44px; height: 5px; border-radius: 999px;',
      '  box-sizing: border-box; border: 0; background: var(--qd-fill-1); overflow: hidden;',
      '}',
      '.dsh-quota-dock-bar-fill {',
      '  display: block; height: 100%; border-radius: inherit;',
      '  background: var(--qd-success);',
      '  transition: width 150ms ease-out;',
      '}',
      '.dsh-quota-dock-bar[data-level="warn"] .dsh-quota-dock-bar-fill { background: var(--qd-warn); }',
      '.dsh-quota-dock-bar[data-level="high"] .dsh-quota-dock-bar-fill { background: var(--qd-error); }',
      '.dsh-quota-dock-bar[data-level="unknown"] .dsh-quota-dock-bar-fill { background: transparent; }',
      '.dsh-quota-dock-ds { display: inline-flex; align-items: center; gap: 10px; flex: none; }',
      '.dsh-quota-dock-divider { flex: none; width: 1px; height: 12px; margin: 0 4px; background: var(--qd-border-3); }',
      '.dsh-quota-dock-track {',
      '  position: relative; display: inline-flex; flex: none; width: 52px; height: 5px;',
      '  box-sizing: border-box; border: 0; border-radius: 999px; background: var(--qd-fill-1); overflow: hidden;',
      '}',
      // The 峰/谷 track keeps the host palette on purpose: this one is a clock, not a
      // budget meter, and the bright pair reads better against the muted bars beside it.
      '.dsh-quota-dock-track-peak { display: block; height: 100%; background: var(--dsw-alias-state-warn-primary, #e0a03a); }',
      '.dsh-quota-dock-track-off { display: block; height: 100%; background: var(--dsw-alias-brand-primary, #5B9BF3); }',
      '.dsh-quota-dock-marker {',
      '  position: absolute; top: 0; bottom: 0; width: 1px; z-index: 1;',
      '  background: var(--qd-label-1); box-shadow: 0 0 0 1px var(--qd-layer-1);',
      '}',
      '.dsh-quota-dock-tier { font-weight: 500; }',
      '.dsh-quota-dock-until { color: var(--qd-label-3); }',
      '.dsh-quota-dock-root[data-warn] .dsh-quota-dock-strip { color: var(--qd-label-2); }',
      '.dsh-quota-dock-warn { flex: none; margin-left: 6px; color: var(--qd-warn); }',
      '/* ---- the sheet ---------------------------------------------------------- */',
      '.dsh-quota-dock-layer { position: fixed; inset: 0; z-index: 900; display: flex; align-items: center; justify-content: center; padding: 24px; pointer-events: none; }',
      '.dsh-quota-dock-sheet {',
      '  position: relative; margin: 0; pointer-events: auto; z-index: 900;',
      '  width: min(780px, 90vw); max-height: 78vh; overflow: auto; box-sizing: border-box;',
      '  border-radius: var(--qd-r-panel); background: var(--qd-layer-2);',
      '  border: 1px solid var(--qd-border-2);',
      '  box-shadow: var(--qd-elev); padding: 0;',
      '  color: var(--qd-label-1); font-size: 12.5px; line-height: 1.6;',
      '  animation: dsh-quota-sheet-in 180ms ease-out;',
      '}',
      '@keyframes dsh-quota-sheet-in {',
      '  from { transform: translateY(-20px); opacity: 0; }',
      '  to { transform: translateY(0); opacity: 1; }',
      '}',
      '.dsh-quota-dock-sheet-head { display: flex; align-items: center; gap: 12px; padding: 12px 16px 11px; }',
      '.dsh-quota-dock-sheet-id { display: flex; align-items: baseline; gap: 8px; min-width: 0; }',
      '.dsh-quota-dock-sheet-title { font-size: 12.5px; font-weight: 600; letter-spacing: .01em; }',
      '.dsh-quota-dock-sheet-age { color: var(--qd-label-4); font-size: 10.5px; font-variant-numeric: tabular-nums; }',
      '.dsh-quota-dock-chips { display: flex; align-items: center; gap: 6px; margin-left: auto; }',
      '.dsh-quota-dock-chip {',
      '  display: inline-flex; align-items: center; gap: 4px;',
      '  padding: 1px 7px; border-radius: 999px;',
      '  font-size: 10.5px; font-weight: 500; line-height: 16px;',
      '  color: var(--qd-label-2); background: var(--qd-fill-1);',
      '}',
      '.dsh-quota-dock-chip::before { content: ""; width: 5px; height: 5px; border-radius: 999px; background: var(--qd-idle); }',
      '.dsh-quota-dock-chip[data-state="ok"] { color: var(--qd-success); }',
      '.dsh-quota-dock-chip[data-state="ok"]::before { background: var(--qd-success); }',
      '.dsh-quota-dock-chip[data-state="bad"] { color: var(--qd-error); }',
      '.dsh-quota-dock-chip[data-state="bad"]::before { background: var(--qd-error); }',
      '.dsh-quota-dock-ghost { height: 26px; min-height: 26px; padding: 0 9px; cursor: pointer;',
      '  font: inherit; font-size: 11.5px; border: 1px solid var(--qd-border-2);',
      '  border-radius: var(--qd-r-sm); background: transparent; color: var(--qd-label-2);',
      '  transition: color 150ms ease-out, border-color 150ms ease-out, background-color 150ms ease-out; }',
      '.dsh-quota-dock-ghost:hover { color: var(--qd-label-1); background: var(--qd-hover); border-color: var(--qd-border-3); }',
      '.dsh-quota-dock-ghost:disabled { opacity: .5; cursor: default; }',
      '.dsh-quota-dock-sheet-close { box-sizing: border-box; width: 26px; height: 26px; flex: none;',
      '  border: 0; border-radius: var(--qd-r-sm); background: transparent; cursor: pointer;',
      '  color: var(--qd-label-3); font-size: 15px; line-height: 1;',
      '  transition: color 150ms ease-out, background-color 150ms ease-out; }',
      '.dsh-quota-dock-sheet-close:hover { color: var(--qd-label-1); background: var(--qd-hover); }',
      '.dsh-quota-dock-hero { display: flex; align-items: flex-end; gap: 28px; flex-wrap: wrap;',
      '  box-sizing: border-box; padding: 2px 16px 14px; font-variant-numeric: tabular-nums; }',
      '.dsh-quota-dock-hero-main { display: flex; flex-direction: column; gap: 1px; }',
      '.dsh-quota-dock-hero-label { font-size: 10.5px; letter-spacing: .02em; color: var(--qd-label-4); }',
      '.dsh-quota-dock-hero-value { font-size: 26px; font-weight: 600; line-height: 1.15; letter-spacing: -0.01em; }',
      '.dsh-quota-dock-stats { display: flex; gap: 22px; padding-bottom: 2px; flex-wrap: wrap; }',
      '.dsh-quota-dock-stat { display: flex; flex-direction: column; gap: 1px; }',
      '.dsh-quota-dock-stat-label { font-size: 10.5px; color: var(--qd-label-4); }',
      '.dsh-quota-dock-stat-value { font-size: 13px; font-weight: 600; color: var(--qd-label-2); }',
      '.dsh-quota-dock-rule { height: 1px; margin: 0 16px; background: var(--qd-border-2); }',
      '.dsh-quota-dock-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 12px 16px 14px; }',
      '.dsh-quota-dock-card { box-sizing: border-box; min-width: 0; padding: 11px 12px 10px;',
      '  align-self: start; background: var(--qd-card-fill);',
      '  border: 1px solid var(--qd-card-stroke); border-radius: var(--qd-r-lg); }',
      '.dsh-quota-dock-card-wide { grid-column: 1 / -1; }',
      '.dsh-quota-dock-card-head { display: flex; align-items: baseline; justify-content: space-between;',
      '  gap: 10px; margin-bottom: 3px; }',
      '.dsh-quota-dock-card-title { font-size: 12px; font-weight: 600; }',
      '.dsh-quota-dock-card-note { font-size: 10.5px; color: var(--qd-label-4); }',
      '.dsh-quota-dock-qrow { display: grid; grid-template-columns: 34px 108px 1fr 40px 84px;',
      '  align-items: center; gap: 10px; padding: 7px 0; min-width: 0; }',
      '.dsh-quota-dock-qrow + .dsh-quota-dock-qrow { border-top: 1px solid var(--qd-border-1); }',
      '.dsh-quota-dock-qk { font-size: 11.5px; color: var(--qd-label-2); }',
      '.dsh-quota-dock-qv { font-size: 12px; font-weight: 600; text-align: right;',
      '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }',
      '.dsh-quota-dock-qrow .dsh-quota-dock-bar { width: auto; height: 4px; }',
      '.dsh-quota-dock-qrow .dsh-quota-dock-pct { font-size: 11.5px; font-weight: 600;',
      '  text-align: right; font-variant-numeric: tabular-nums; }',
      '.dsh-quota-dock-qr { font-size: 10.5px; text-align: right; white-space: nowrap;',
      '  color: var(--qd-label-4); font-variant-numeric: tabular-nums; }',
      '.dsh-quota-dock-detail { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px;',
      '  padding: 8px 0 1px 44px; font-size: 10.5px; line-height: 1.5; color: var(--qd-label-4); }',
      '.dsh-quota-dock-detail-sep { color: var(--qd-border-3); }',
      '.dsh-quota-dock-detail b { font-weight: 600; color: var(--qd-label-2); font-variant-numeric: tabular-nums; }',
      '.dsh-quota-dock-kv { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px;',
      '  align-items: center; margin-top: 6px; font-variant-numeric: tabular-nums; }',
      '.dsh-quota-dock-kv-label { font-size: 11px; color: var(--qd-label-3); }',
      '.dsh-quota-dock-kv-value { font-size: 12px; font-weight: 600; text-align: right; white-space: nowrap; }',
      '.dsh-quota-dock-status { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px;',
      '  font-size: 11.5px; font-weight: 500; color: var(--qd-success); }',
      '.dsh-quota-dock-status i { width: 6px; height: 6px; flex: none; border-radius: 50%; background: currentColor; }',
      '.dsh-quota-dock-status[data-state="bad"] { color: var(--qd-error); }',
      '.dsh-quota-dock-note { margin: 9px 0 0; padding-top: 8px; font-size: 10.5px; line-height: 1.55;',
      '  color: var(--qd-label-4); border-top: 1px solid var(--qd-border-1); }',
      '.dsh-quota-dock-note b { font-weight: 600; color: var(--qd-label-2); }',
      '.dsh-quota-dock-note-solo { margin-top: 5px; padding-top: 0; border-top: 0; }',
      '.dsh-quota-dock-cur { margin-bottom: 3px; font-size: 10px; font-weight: 600;',
      '  letter-spacing: 0.06em; color: var(--qd-label-4); }',
      '.dsh-quota-dock-prow { display: flex; align-items: center; gap: 8px; min-height: 28px; min-width: 0; }',
      '.dsh-quota-dock-prow-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.dsh-quota-dock-prow-kind { flex: none; font-size: 10.5px; color: var(--qd-label-4); }',
      '.dsh-quota-dock-prow-money { flex: none; margin-left: auto; font-size: 12.5px; font-weight: 600;',
      '  font-variant-numeric: tabular-nums; }',
      '.dsh-quota-dock-empty { font-size: 11.5px; color: var(--qd-label-3); }',
      '.dsh-quota-dock-sheet-foot { display: flex; align-items: center; justify-content: space-between;',
      '  gap: 10px; padding: 9px 16px 11px; font-size: 10.5px; color: var(--qd-label-3);',
      '  border-top: 1px solid var(--qd-border-2); background: var(--qd-fill-1); }',
      '/* ---- the settings page --------------------------------------------------- */',
      '.dsh-quota-dock-set { display: block; max-width: 600px;',
      '  color: var(--qd-label-1); font-size: 12.5px; line-height: 1.6; }',
      '.dsh-quota-dock-set-head { display: flex; align-items: center; gap: 12px; }',
      '.dsh-quota-dock-set-title { margin: 0; font-size: 14px; font-weight: 600; }',
      '.dsh-quota-dock-set-title + .dsh-quota-dock-ghost { margin-left: auto; }',
      '.dsh-quota-dock-set-hint { margin: 4px 0 14px; font-size: 11.5px; color: var(--qd-label-3); }',
      '.dsh-quota-dock-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px;',
      '  margin-bottom: 20px; background: var(--qd-border-1);',
      '  border: 1px solid var(--qd-border-1); border-radius: var(--qd-r-lg); overflow: hidden; }',
      '.dsh-quota-dock-sum { display: flex; flex-direction: column; gap: 1px; padding: 9px 12px;',
      '  background: var(--qd-card-fill); font-variant-numeric: tabular-nums; }',
      '.dsh-quota-dock-sum-value { font-size: 15px; font-weight: 600; line-height: 1.25; }',
      '.dsh-quota-dock-sum-label { font-size: 10.5px; color: var(--qd-label-4); }',
      '.dsh-quota-dock-sec { margin-bottom: 18px; }',
      '.dsh-quota-dock-sec-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }',
      '.dsh-quota-dock-sec-title { margin: 0 0 7px; font-size: 11.5px; font-weight: 600;',
      '  color: var(--qd-label-2); letter-spacing: .01em; }',
      '.dsh-quota-dock-sec-aside { font-size: 10.5px; color: var(--qd-label-4); }',
      '.dsh-quota-dock-list { display: block; }',
      '.dsh-quota-dock-plat { display: flex; align-items: center; gap: 8px; min-height: 38px;',
      '  padding: 0 8px; border-radius: var(--qd-r-sm); transition: background-color 120ms ease-out; }',
      '.dsh-quota-dock-plat:hover { background: var(--qd-hover); }',
      '.dsh-quota-dock-dot { flex: none; width: 6px; height: 6px; border-radius: 999px; background: var(--qd-idle); }',
      '.dsh-quota-dock-dot[data-quota-dot="ok"] { background: var(--qd-success); }',
      '.dsh-quota-dock-dot[data-quota-dot="bad"] { background: var(--qd-error); }',
      '.dsh-quota-dock-pname { min-width: 0; overflow: hidden; text-overflow: ellipsis;',
      '  white-space: nowrap; font-size: 12.5px; font-weight: 600; }',
      '.dsh-quota-dock-badge { flex: none; padding: 1px 6px; border-radius: var(--qd-r-xs); font-size: 10.5px;',
      '  background: var(--qd-fill-1); color: var(--qd-label-3); }',
      '.dsh-quota-dock-pstate { flex: none; font-size: 10.5px; color: var(--qd-label-3); }',
      '.dsh-quota-dock-pstate[data-quota-state="ok"] { color: var(--qd-success); }',
      '.dsh-quota-dock-pstate[data-quota-state="bad"] { color: var(--qd-error); }',
      '.dsh-quota-dock-pmoney { flex: none; margin-left: auto; font-size: 12.5px; font-weight: 600;',
      '  font-variant-numeric: tabular-nums; }',
      '.dsh-quota-dock-remove { flex: none; min-height: 26px; padding: 0 7px; cursor: pointer;',
      '  font: inherit; font-size: 11px; border: 0; border-radius: var(--qd-r-sm); background: transparent;',
      '  color: var(--qd-label-3); transition: color 150ms ease-out, background-color 150ms ease-out; }',
      '.dsh-quota-dock-remove:hover { color: var(--qd-error); background: var(--qd-hover); }',
      '.dsh-quota-dock-form { margin-top: 4px; }',
      '.dsh-quota-dock-pills { display: flex; gap: 6px; flex-wrap: wrap; }',
      '.dsh-quota-dock-pill { min-height: 25px; padding: 0 10px; cursor: pointer; font: inherit;',
      '  font-size: 11.5px; border: 1px solid var(--qd-border-2); border-radius: 999px;',
      '  background: transparent; color: var(--qd-label-2);',
      '  transition: color 150ms ease-out, background-color 150ms ease-out, border-color 150ms ease-out; }',
      '.dsh-quota-dock-pill:hover { background: var(--qd-hover); }',
      '.dsh-quota-dock-pill[data-active] { border-color: var(--qd-border-3);',
      '  background: var(--qd-fill-1); color: var(--qd-label-1); font-weight: 500; }',
      '.dsh-quota-dock-field { display: block; margin-top: 10px; }',
      '.dsh-quota-dock-field-label { display: block; margin-bottom: 4px; font-size: 10.5px; color: var(--qd-label-3); }',
      '.dsh-quota-dock-field input { box-sizing: border-box; width: 100%; height: 32px; padding: 0 9px;',
      '  border: 1px solid var(--qd-border-2); border-radius: var(--qd-r-sm);',
      '  background: var(--qd-layer-2); color: inherit; font: inherit; font-size: 12.5px; }',
      '.dsh-quota-dock-submit { display: block; box-sizing: border-box; width: auto; height: 28px; min-height: 28px;',
      '  padding: 0 14px; margin-top: 14px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 500;',
      '  border: 0; border-radius: var(--qd-r-sm);',
      '  background: var(--dsw-alias-button-primary-fill, var(--qd-brand));',
      '  color: var(--dsw-alias-label-primary-foreground, #fff);',
      '  transition: opacity 150ms ease-out; }',
      '.dsh-quota-dock-submit:hover { opacity: .9; }',
      '.dsh-quota-dock-submit:disabled { opacity: .45; cursor: default; }',
      '.dsh-quota-dock-about { margin: 0; font-size: 11px; color: var(--qd-label-3); }',
      '.dsh-quota-dock-pmsg { margin-top: 12px; font-size: 11.5px; color: var(--qd-label-3); }',
      '.dsh-quota-dock-card-flat { padding: 2px 10px;',
      '  background: var(--qd-card-fill);',
      '  border: 1px solid var(--qd-card-stroke); border-radius: var(--qd-r-lg); }',
      '.dsh-quota-dock-brow { display: flex; align-items: center; gap: 10px; min-height: 40px; }',
      '.dsh-quota-dock-brow + .dsh-quota-dock-brow { border-top: 1px solid var(--qd-border-1); }',
      '.dsh-quota-dock-brow-main { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }',
      '.dsh-quota-dock-brow-text { min-width: 0; }',
      '.dsh-quota-dock-brow-name { font-size: 12.5px; font-weight: 500; }',
      '.dsh-quota-dock-brow-sub { margin-top: 1px; font-size: 10.5px; color: var(--qd-label-4);',
      '  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
      '.dsh-quota-dock-brow-value { font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }',
      '.dsh-quota-dock-brow-age { min-width: 54px; text-align: right; font-size: 10.5px; color: var(--qd-label-4); white-space: nowrap; }',
      '.dsh-quota-dock-mini { flex: none; width: 40px; height: 4px; border-radius: 999px;',
      '  background: var(--qd-fill-1); overflow: hidden; }',
      '.dsh-quota-dock-mini i { display: block; height: 100%; border-radius: inherit; background: var(--qd-success); }',
      '.dsh-quota-dock-empty-row { display: flex; align-items: center; justify-content: space-between; gap: 14px;',
      '  padding: 12px; border: 1px dashed var(--qd-border-2); border-radius: var(--qd-r-lg); }',
      '.dsh-quota-dock-empty-title { font-size: 12px; }',
      '.dsh-quota-dock-empty-sub { margin-top: 3px; font-size: 11px; color: var(--qd-label-3); }',
      '.dsh-quota-dock-fixed { margin-top: 12px; }',
      '.dsh-quota-dock-hint { margin: 7px 0 0; font-size: 10.5px; line-height: 1.6; color: var(--qd-label-4); }',
      '.dsh-quota-dock-file { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px;',
      '  color: var(--qd-label-4); background: var(--qd-fill-1); padding: 1px 5px; border-radius: var(--qd-r-xs); }',
      '.dsh-quota-dock-form-actions { display: flex; justify-content: flex-start; gap: 8px; align-items: center; margin-top: 14px; }',
      '.dsh-quota-dock-form-actions .dsh-quota-dock-submit { width: auto; padding: 0 14px; margin-top: 0; }',
      '.dsh-quota-dock-prefs { border: 1px solid var(--qd-border-1); border-radius: var(--qd-r-lg);',
      '  padding: 2px 12px; background: var(--qd-card-fill); }',
      '.dsh-quota-dock-pref { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 38px; }',
      '.dsh-quota-dock-pref + .dsh-quota-dock-pref { border-top: 1px solid var(--qd-border-1); }',
      '.dsh-quota-dock-pref-label { font-size: 11.5px; color: var(--qd-label-2); }',
      '.dsh-quota-dock-pref-control { display: flex; align-items: center; gap: 10px; }',
      '.dsh-quota-dock-pref-value { font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--qd-label-3); }',
      '.dsh-quota-dock-select { height: 26px; padding: 0 8px; font: inherit; font-size: 11.5px;',
      '  border-radius: var(--qd-r-sm); border: 1px solid var(--qd-border-2);',
      '  background: var(--qd-layer-2); color: var(--qd-label-1); cursor: pointer; }',
      '.dsh-quota-dock-ghost-sm { min-height: 24px; height: 24px; padding: 0 8px; font-size: 11px; }',
      '.dsh-quota-dock-pill:focus-visible, .dsh-quota-dock-remove:focus-visible,',
      '.dsh-quota-dock-ghost:focus-visible, .dsh-quota-dock-sheet-close:focus-visible,',
      '.dsh-quota-dock-submit:focus-visible, .dsh-quota-dock-field input:focus-visible {',
      '  outline: 2px solid var(--qd-focus); outline-offset: 1px;',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  .dsh-quota-dock-sheet { animation: none; }',
      '  .dsh-quota-dock-bar-fill, .dsh-quota-dock-plat, .dsh-quota-dock-pill,',
      '  .dsh-quota-dock-ghost, .dsh-quota-dock-remove, .dsh-quota-dock-submit,',
      '  .dsh-quota-dock-sheet-close, .dsh-quota-dock-row { transition: none; }',
      '}',
    ].join('\n')
    const STYLE = h('style', { key: 'quota-dock-style' }, CSS)

    /**
     * The cadence the Host publishes; the row never invents one of its own.
     * @param snapshot - the Host snapshot, or null before the first read.
     * @returns the refresh interval in milliseconds.
     */
    function refreshCadence(snapshot) {
      const ms = snapshot === null || snapshot === undefined ? null : snapshot.refreshMs
      return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : FALLBACK_REFRESH_MS
    }

    /**
     * How long to wait before reading the snapshot again. The read is the
     * trigger, so the wait is the whole loop: land just past the cache TTL, come
     * back quickly while the Host reports a cycle in flight (so its numbers show
     * up the moment it settles), and back off when the last cycle failed.
     * @param snapshot - the snapshot the previous read returned, or null.
     * @returns the delay in milliseconds.
     */
    function nextReadDelay(snapshot) {
      if (snapshot !== null && snapshot !== undefined && snapshot.fetching === true) return FAST_FOLLOW_MS
      const cadence = refreshCadence(snapshot)
      const age = snapshot !== null && snapshot !== undefined
        && typeof snapshot.ageMs === 'number' && Number.isFinite(snapshot.ageMs)
        ? Math.max(0, snapshot.ageMs)
        : null
      // No age at all: the Host has never succeeded, so retry calmly.
      if (age === null) return Math.min(cadence, OVERDUE_RETRY_MS)
      const left = cadence - age
      // Past the TTL with nothing in flight means the last cycle failed.
      if (left <= 0) return Math.min(cadence, OVERDUE_RETRY_MS)
      return Math.max(MIN_READ_MS, left + READ_LEAD_MS)
    }

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

    /** GET the platform document: list, cadence and store path. */
    async function fetchPlatforms() {
      const response = await fetch(PLATFORMS_URL, {
        headers: { accept: 'application/json' },
        signal: timeoutSignal(15000),
      })
      if (response === null || response === undefined || response.ok !== true) {
        throw new Error(`HTTP ${response !== null && response !== undefined ? response.status : '?'}`)
      }
      const body = JSON.parse(await response.text())
      if (!Array.isArray(body?.platforms)) throw new Error('platform list missing')
      return body
    }

    /** POST an add, remove or settings action; returns the fresh document. */
    async function postPlatforms(payload) {
      const response = await fetch(PLATFORMS_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: timeoutSignal(15000),
      })
      const text = response !== null && response !== undefined ? await response.text() : ''
      let body = null
      try {
        body = JSON.parse(text)
      } catch (error) {
        body = null
      }
      if (response === null || response === undefined || response.ok !== true) {
        throw new Error(body?.error ?? `HTTP ${response !== null && response !== undefined ? response.status : '?'}`)
      }
      return body !== null && typeof body === 'object' ? body : { platforms: [] }
    }

    /** `Error: x` as a plain string, whatever was thrown. */
    const messageOf = error => String(
      error !== null && error !== undefined && error.message ? error.message : error)

    /**
     * Which conversation the row is looking at. The input dock passes the
     * session's own snapshot down as `SessionSnapshot`; without it we fall back
     * to the document URL, which changes as the app moves between sessions.
     */
    function sessionKeyOf(props) {
      const source = props?.SessionSnapshot ?? props?.sessionSnapshot ?? props?.session
      const id = source?.id ?? source?.sessionId ?? source?.session?.id
      if (id !== null && id !== undefined && String(id) !== '') return String(id)
      if (typeof window !== 'undefined' && window.location) return String(window.location.href)
      return ''
    }

    let refreshInFlight = null

    /**
     * Set by the row's effect: re-arm the read timer from the current snapshot.
     * A manual or session-switch refresh lands here so it never waits out the
     * cadence, and a running cycle is then followed at the fast cadence.
     */
    let nudge = null

    /**
     * Ask the Host for a fresh read, then adopt whatever it reports. Single
     * flight on this side, with the Host's own dedupe behind it, so a session
     * switch landing on top of a button press still sends one request.
     */
    function refreshNow() {
      if (refreshInFlight !== null) return refreshInFlight
      publish({ busy: true })
      refreshInFlight = Promise.resolve()
        .then(() => fetch(REFRESH_URL, { method: 'POST', signal: timeoutSignal(15000) }))
        .then(
          () => readSnapshot(),
          () => readSnapshot(),
        )
        .then(next => {
          refreshInFlight = null
          publish({ busy: false })
          if (next !== null && next !== undefined) publish({ snapshot: next, phase: 'ready' })
          else if (store.snapshot === null) publish({ phase: 'failed' })
          if (typeof nudge === 'function') nudge()
          return next
        })
      return refreshInFlight
    }

    /**
     * Entry composed into the `conversation.input.dock` slot, above the composer.
     * It owns the only read of the snapshot — on mount and on a session switch;
     * the sheet and the settings page read the store it publishes, and the
     * refresh buttons call refreshNow directly.
     */
    function QuotaDock(props) {
      const state = useStore()
      const { load, t } = props
      // The injected face is rebuilt on every render, so the loader rides a ref
      // and never enters a dependency array.
      const loader = React.useRef(load)
      loader.current = load

      React.useEffect(() => {
        let live = true
        const adopt = next => {
          if (live) publish({ snapshot: next, phase: 'ready' })
        }
        const pull = () => {
          if (typeof loader.current !== 'function') {
            publish({ phase: 'failed' })
            return Promise.resolve()
          }
          return Promise.resolve()
            .then(() => loader.current(adopt))
            .then(
              next => {
                if (!live) return
                if (next === null || next === undefined) publish({ phase: 'failed' })
                else adopt(next)
              },
              () => {
                if (live) publish({ phase: 'failed' })
              },
            )
        }
        if (typeof window === 'undefined') {
          pull()
          return undefined
        }
        // The ticker only repaints, so the 峰/谷 countdown stays honest; it never
        // touches the network.
        const ticker = window.setInterval(() => { publish({ now: Date.now() }) }, TICK_MS)

        // The read loop is the refresh timer. The Host refreshes lazily on a read,
        // so re-reading on the cadence it publishes is what keeps the numbers —
        // and the warning that rides on them — honest. While a cycle is in flight
        // the loop follows at the fast cadence, so a finished cycle shows up the
        // moment it settles instead of one whole cadence later.
        let timer = null
        let reading = false
        function schedule(snapshot) {
          if (!live) return
          if (timer !== null) {
            clearTimer(timer)
            timer = null
          }
          timer = setTimer(read, nextReadDelay(snapshot))
        }
        async function read() {
          if (!live || reading) return
          reading = true
          let next = null
          try {
            next = await readSnapshot()
          } finally {
            reading = false
          }
          if (!live) return
          if (next !== null && next !== undefined) publish({ snapshot: next, phase: 'ready' })
          schedule(next)
        }
        // A manual refresh or a session switch re-arms the loop immediately.
        nudge = () => { if (live) schedule(store.snapshot) }
        Promise.resolve(pull()).then(() => { if (live) schedule(store.snapshot) })
        return () => {
          live = false
          nudge = null
          window.clearInterval(ticker)
          clearTimer(timer)
        }
      }, [])

      // A new session id means the numbers on screen belong to the previous
      // conversation: refresh once, and only once per id.
      const sessionId = sessionKeyOf(props)
      const sessionSeen = React.useRef(sessionId)
      React.useEffect(() => {
        if (sessionSeen.current === sessionId) return undefined
        sessionSeen.current = sessionId
        void refreshNow()
        return undefined
      }, [sessionId])

      const snapshot = state.snapshot
      const failed = state.phase === 'failed'
      const loading = state.phase === 'loading'
      const numbers = hasNumbers(snapshot)
      // Re-render on a short tick so the 峰/谷 countdown stays honest without
      // waiting for the next upstream poll.
      const now = new Date(state.now)
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
      // A read at the TTL boundary is what starts the next cycle, so `stale` rides
      // along with `fetching` on the way to fresh numbers. That is not a data
      // problem: only the settled state may raise the marker. Failures (an error
      // string, a provider reporting not-ok) still show through immediately.
      const inflight = snapshot !== null && snapshot !== undefined && snapshot.fetching === true
      const warn = !pending && (failed || (snapshot !== null && snapshot !== undefined
        && (error !== null
          || snapshot.cc?.ok === false || snapshot.deepseek?.ok === false
          || (snapshot.stale === true && !inflight))))
      // The tooltip carries the age, and the upstream error when there is one:
      // the row itself never nags about staleness.
      const age = ageText(snapshot, t)
      const title = [text, age, warn ? error : null]
        .filter(part => part !== null && part !== undefined && part !== '')
        .join(' · ')

      return h(React.Fragment, null,
        STYLE,
        h('span', {
          className: 'dsh-quota-dock-root',
          'data-quota-dock': '',
          'data-warn': warn ? '' : undefined,
          'data-open': state.panelOpen ? '' : undefined,
          title,
        },
        h('button', {
          type: 'button',
          className: 'dsh-quota-dock-row',
          'data-quota-row': '',
          'aria-expanded': state.panelOpen ? 'true' : 'false',
          'aria-haspopup': 'dialog',
          title,
          onClick: () => publish({ panelOpen: !store.panelOpen }),
        },
        h('span', { className: 'dsh-quota-dock-strip' }, body),
        warn ? h('span', { className: 'dsh-quota-dock-warn', 'aria-hidden': true }, '⚠') : null)))
    }

    /**
     * The money sheet, composed into the frame-wide `shell.overlay` slot. It
     * renders nothing at all while closed, so it never leaves a layer that
     * swallows clicks.
     */
    function QuotaSheet({ t }) {
      const state = useStore()
      const open = state.panelOpen
      React.useEffect(() => {
        if (!open || typeof window === 'undefined') return undefined
        const onKey = event => { if (event.key === 'Escape') publish({ panelOpen: false }) }
        window.addEventListener('keydown', onKey)
        return () => { window.removeEventListener('keydown', onKey) }
      }, [open])
      if (!open) return null
      return sheetTree({
        t,
        now: new Date(state.now),
        snapshot: state.snapshot,
        busy: state.busy === true,
        onClose: () => publish({ panelOpen: false }),
        onRefresh: () => { void refreshNow() },
      })
    }

    /**
     * The settings page, composed into `settings.section`. It is the only
     * surface that reads or writes the platform list.
     */
    /**
     * Settings: what is connected, how a new provider is added, and how often the
     * numbers are re-read. The document comes from the Host, so the page and the
     * row agree on the store path and the cadence.
     */
    function QuotaSettings({ t }) {
      const store = useStore()
      const [doc, setDoc] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [form, setForm] = React.useState({
        preset: 'openrouter',
        name: '',
        kind: 'openrouter',
        baseUrl: '',
        apiKey: '',
      })
      const alive = React.useRef(true)

      const read = () => {
        setBusy(true)
        setMessage(null)
        fetchPlatforms().then(
          body => {
            if (alive.current !== true) return
            setDoc(body)
            setBusy(false)
          },
          error => {
            if (alive.current !== true) return
            setDoc({ platforms: [], refreshMs: REFRESH_CHOICES[1], storePath: null })
            setBusy(false)
            setMessage(messageOf(error))
          }
        )
      }

      React.useEffect(() => {
        alive.current = true
        read()
        return () => { alive.current = false }
      }, [])

      const send = payload => {
        setBusy(true)
        setMessage(null)
        return postPlatforms(payload).then(
          body => {
            if (alive.current === true) {
              setDoc(body)
              setBusy(false)
            }
            return true
          },
          error => {
            if (alive.current === true) {
              setBusy(false)
              setMessage(messageOf(error))
            }
            return false
          },
        )
      }

      const submitAdd = () => {
        const entry = form.kind === 'openrouter'
          ? { action: 'add', name: 'OpenRouter', kind: 'openrouter', baseUrl: '', apiKey: form.apiKey }
          : {
              action: 'add',
              name: form.name.trim() === '' ? t('presetCustom') : form.name,
              kind: 'custom',
              baseUrl: form.baseUrl,
              apiKey: form.apiKey,
            }
        void send(entry).then(ok => {
          if (ok !== true || alive.current !== true) return
          // Keep the chosen preset; drop the secret and the one-off fields.
          setForm(value => ({
            ...value,
            name: value.preset === 'custom' ? '' : value.name,
            apiKey: '',
          }))
        })
      }

      // The sheet's figures and this page's header both come from the store, so
      // one refresh updates them together.
      const refreshAll = () => {
        void refreshNow()
        read()
      }

      return settingsTree({
        t,
        snapshot: store.snapshot,
        platforms: doc === null ? null : doc.platforms,
        refreshMs: doc?.refreshMs ?? REFRESH_CHOICES[1],
        storePath: doc?.storePath ?? null,
        form,
        busy,
        message,
        onForm: patch => setForm(value => ({ ...value, ...patch })),
        onAdd: submitAdd,
        onRemove: id => { void send({ action: 'remove', id }) },
        onRefresh: refreshAll,
        onInterval: ms => { void send({ action: 'settings', refreshMs: ms }) },
      })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, LOCALES), 'quota-dock: dictionaries')

        // Label thunks are re-read on every projection, so the settings sidebar
        // follows a live language switch without re-registering the slot.
        const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
        const label = key => () => (bound === null ? LOCALES.zh[key] : bound(key))

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

        // The always-visible row above the composer card.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'quota-dock',
          order: -1, // first entry of the row directly above the composer card
          locale: NS,
          inject: () => ({ load }),
        }, QuotaDock))

        // The money sheet, on the frame-wide floating layer. That layer is
        // click-through, so the sheet's own root opts back into pointer events.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'quota-dock-sheet',
          order: 60,
          label: label('sheetTitle'),
          locale: NS,
        }, QuotaSheet))

        // Platform configuration, beside the other settings entries.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'quota-dock',
          order: 23,
          label: label('settingsTitle'),
          locale: NS,
        }, QuotaSettings))
      },
      // Pure, DOM-free helpers, additionally exported so an offline smoke test can
      // drive them without a browser; the slot loader reads only inject/apply.
      LOCALES,
      store,
      publish,
      useStore,
      formatStrip,
      hasNumbers,
      barPercent,
      barLevel,
      percentText,
      ratioText,
      numText,
      cycleState,
      cycleText,
      durationText,
      fmtClock,
      fmtCountdown,
      toMs,
      sheetCards,
      sheetTree,
      settingsTree,
      daysLeft,
      daysText,
      refreshNow,
      nextReadDelay,
      ageText,
      sessionKeyOf,
      platformMoney,
      renderBar,
      renderPercent,
      renderCells,
      QuotaDock,
      QuotaSheet,
      QuotaSettings,
    }
  },
})
