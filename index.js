/**
 * Host half of @local/dsh-quota-dock.
 *
 * Publishes one cached snapshot of Command Code's three quota windows plus the
 * DeepSeek account balance over two local HTTP routes, so the composer dock can
 * render concrete credit numbers on every page load.
 *
 * The upstream Command Code API takes 10-20s, so the read route NEVER awaits it:
 * it answers from whatever the background refresher last produced. Refreshes are
 * deduped into a single in-flight loop, run on a 60s TTL, on demand, and whenever
 * the cache is still empty.
 *
 * Each provider keeps its own last-good value, so a DeepSeek outage cannot erase
 * the Command Code numbers (and vice versa). Nothing here ever logs, echoes or
 * embeds an API key: the only key-shaped fact that leaves this module is whether
 * one was configured.
 */

/** Snapshot is refreshed at most once per this interval. */
const TTL_MS = 60_000

/** Upstream request budget; Command Code legitimately needs 10-20s. */
const FETCH_TIMEOUT_MS = 25_000

/** Credential references; the ref literal IS the environment variable name. */
const CC_KEY_REF = 'COMMANDCODE_API_KEY'
const DS_KEY_REF = 'DEEPSEEK_API_KEY'

/** Frozen route paths (CONTRACT.md §1). */
const SNAPSHOT_PATH = '/api/dsh-quota-dock/snapshot'
const REFRESH_PATH = '/api/dsh-quota-dock/refresh'

/** Upstream endpoints (CONTRACT.md §4). */
const CC_BASE = 'https://api.commandcode.ai'
const CC_CREDITS_URL = `${CC_BASE}/alpha/billing/credits`
const CC_USAGE_URL = `${CC_BASE}/alpha/usage/summary`
const CC_SUBSCRIPTIONS_URL = `${CC_BASE}/alpha/billing/subscriptions`
const DS_BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** cc.windows order and labels are frozen by the contract. */
const WINDOW_IDS = ['fiveHour', 'weekly', 'monthly']
const WINDOW_LABELS = { fiveHour: '5h', weekly: 'weekly', monthly: 'monthly' }

/** Field aliases seen across the upstream responses; first present wins. */
const USED_ALIASES = ['used', 'usage', 'usedCredits', 'used_credits']
const CAP_ALIASES = ['cap', 'limit', 'credits', 'total', 'totalCredits']
const RESET_ALIASES = ['resetAt', 'reset', 'resetsAt', 'resets_at', 'periodEnd', 'currentPeriodEnd']

/**
 * @param value - candidate number.
 * @returns a finite number, or null for anything that is not a usable number.
 */
function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * @param value - candidate number.
 * @returns a finite non-negative number, or null.
 */
function nonNegative(value) {
  const parsed = finite(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

/**
 * @param value - candidate count.
 * @returns an integer, or null.
 */
function integer(value) {
  const parsed = finite(value)
  return parsed !== null ? Math.round(parsed) : null
}

/**
 * @param value - candidate reset instant: ISO string, epoch ms, or epoch seconds.
 * @returns an ISO string, or null when absent or outside a sane epoch-ms range.
 */
function isoInstant(value) {
  let ms = null
  if (typeof value === 'number') ms = value
  else if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim()
    const numeric = Number(text)
    ms = Number.isFinite(numeric) ? numeric : Date.parse(text)
  }
  if (!Number.isFinite(ms) || ms <= 0) return null
  // A seconds-epoch would land in 1970; only treat a small value as seconds when
  // it is consistent with a modern instant.
  if (ms < 1e11) ms *= 1000
  if (ms < 1e11 || ms > 4.1e12) return null
  return new Date(ms).toISOString()
}

/**
 * First present, usable value among aliases.
 * @param source - object to read.
 * @param aliases - candidate keys, in priority order.
 * @returns the first value that is not null/undefined, or undefined.
 */
function pick(source, aliases) {
  if (!source || typeof source !== 'object') return undefined
  for (const key of aliases) {
    const value = source[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/**
 * @param value - candidate error message/token.
 * @returns a trimmed single-line string, or null.
 */
function messageOf(value) {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim()
    return text === '' ? null : text.slice(0, 200)
  }
  if (value === undefined || value === null) return null
  return messageOf(String(value))
}

/**
 * Turn any thrown value into a safe, key-free message.
 * Never includes a request body, a header, or a URL that could carry a secret.
 * @param error - thrown value.
 * @returns a short message.
 */
function describeError(error) {
  if (!error || typeof error !== 'object') return '上游请求失败'
  const name = typeof error.name === 'string' ? error.name : ''
  const raw = messageOf(error.message) || '上游请求失败'
  if (name === 'TimeoutError' || name === 'AbortError' || /abort|timeout/i.test(raw)) {
    return '上游请求超时（25s）'
  }
  return raw
}

/**
 * Read one credential: plugin credentials service first, then the environment.
 * @param ctx - plugin context.
 * @param ref - credential reference, which is also the environment variable name.
 * @returns the trimmed secret, or null when unconfigured.
 */
async function resolveKey(ctx, ref) {
  try {
    // CredentialProvider.resolve is asynchronous and yields {value, source}.
    const resolved = await ctx?.get?.('credentials')?.resolve?.(ref)
    const value = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
    if (value !== '') return value
  } catch {
    // A failing credentials service must fall through to the environment, not throw.
  }
  const fromEnv = process.env?.[ref]
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : null
}

/**
 * GET a JSON document from an upstream endpoint.
 * @param url - absolute endpoint.
 * @param key - bearer secret; never echoed into any error.
 * @returns parsed JSON body.
 * @throws when the transport fails or the response is not a JSON object.
 */
async function getJson(url, key) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim())
  let body = null
  try {
    body = await response.json()
  } catch {
    throw new Error('响应不是有效 JSON')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('响应不是 JSON 对象')
  }
  return body
}

/**
 * Upstream business failures can arrive as HTTP 200 with `success: false`.
 * @param body - parsed response.
 * @returns an error message, or null when the body reports success.
 */
function businessError(body) {
  if (!body || typeof body !== 'object' || body.success !== false) return null
  const code = body.error?.code ?? body.error?.type ?? 'UNKNOWN'
  return `业务错误 ${String(code)}`
}

/**
 * Normalize one upstream window object into the frozen window shape.
 * Every field is resolved independently: a missing field only nulls itself and
 * appends to this window's `error`.
 * @param id - frozen window id.
 * @param raw - upstream window object, or undefined.
 * @param fallback - derived values used when upstream omits a field.
 * @returns a contract-shaped window.
 */
function buildWindow(id, raw, fallback = {}) {
  const problems = []
  let used = nonNegative(pick(raw, USED_ALIASES))
  let cap = nonNegative(pick(raw, CAP_ALIASES))
  let resetAt = isoInstant(pick(raw, RESET_ALIASES))
  if (used === null) {
    used = nonNegative(fallback.used)
    if (used === null) problems.push('used 字段缺失')
  }
  if (cap === null) {
    cap = nonNegative(fallback.cap)
    if (cap === null) problems.push('cap 字段缺失')
  }
  if (resetAt === null) {
    resetAt = isoInstant(fallback.resetAt)
    if (resetAt === null) problems.push('resetAt 字段缺失')
  }
  // A window whose values were fully assembled carries no error, even when one
  // of the two endpoints was the one that supplied it.
  const complete = used !== null && cap !== null && resetAt !== null
  return { id, used, cap, resetAt, error: problems.length > 0 && !complete ? problems.join('；') : null }
}

/**
 * Pull the credentials object out of either the root or the `credits` envelope.
 * @param body - parsed /alpha/billing/credits body.
 * @returns the credits object, or null.
 */
function creditsOf(body) {
  const data = body?.data && typeof body.data === 'object' ? body.data : body
  const credits = data?.credits
  if (credits && typeof credits === 'object' && !Array.isArray(credits)) return credits
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null
}

/**
 * Read the contract's `remainingMonthlyCredits` (the REMAINING monthly credits).
 * @param body - parsed /alpha/billing/credits body.
 * @returns a number, or null.
 */
function remainingMonthlyCreditsOf(body) {
  const credits = creditsOf(body)
  return nonNegative(pick(credits, ['monthlyCredits', 'monthlyRemaining', 'monthlyCreditsRemaining']))
}

/**
 * Read `usage.summary.totalMonthlyCredits` (the USED monthly credits this cycle).
 * @param body - parsed /alpha/usage/summary body.
 * @returns a number, or null.
 */
function usedMonthlyCreditsOf(body) {
  // The live endpoint answers flat (`{ totalMonthlyCredits, … }`), so the body
  // itself is the last resort after the documented envelopes.
  const summary = body?.usage?.summary ?? body?.summary ?? body?.usage ?? body?.data?.usage?.summary ?? body?.data?.summary ?? body
  return nonNegative(pick(summary, ['totalMonthlyCredits', ...USED_ALIASES]))
}

/**
 * Locate the server-reported window limits, which may sit at the root, inside
 * `credits`, or one envelope down under `data`.
 * @param creditsBody - parsed credits body.
 * @returns the windowLimits object, or null.
 */
function windowLimitsOf(creditsBody) {
  const candidates = [
    creditsBody?.windowLimits,
    creditsBody?.credits?.windowLimits,
    creditsBody?.data?.windowLimits,
    creditsBody?.data?.credits?.windowLimits,
  ]
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate
  }
  return null
}

/**
 * Assemble the three frozen windows.
 *
 * The monthly window must be joined from both endpoints: the cycle total is
 * `usage.totalMonthlyCredits` (USED) + `credits.monthlyCredits` (REMAINING), and
 * the used side is `usage.totalMonthlyCredits`. A more reliable server-reported
 * pair in `windowLimits.monthly` wins per field, with the derived value filling
 * only what upstream left out.
 * @param creditsBody - parsed credits body.
 * @param usageBody - parsed usage body.
 * @param subscriptionBody - parsed subscriptions body, or null; supplies the cycle end.
 * @returns the three windows, in contract order.
 */
function buildWindows(creditsBody, usageBody, subscriptionBody = null) {
  const limits = windowLimitsOf(creditsBody)
  // `credits` is sometimes the numeric monthly balance rather than a nested
  // envelope, so only descend into it when it really is an object.
  const limitsEnvelope = limits && limits.credits && typeof limits.credits === 'object' && !Array.isArray(limits.credits)
    ? limits.credits
    : limits
  const usedMonthly = usedMonthlyCreditsOf(usageBody)
  const remainingMonthly = remainingMonthlyCreditsOf(creditsBody)
  const derivedCap = usedMonthly !== null && remainingMonthly !== null ? usedMonthly + remainingMonthly : null
  const monthlyReset = creditsBody?.credits?.windowLimits?.monthly?.resetAt
    ?? creditsBody?.credits?.windowLimits?.monthly?.reset
    ?? creditsBody?.windowLimits?.monthly?.resetAt
    ?? creditsBody?.data?.credits?.windowLimits?.monthly?.resetAt
    ?? creditsBody?.data?.windowLimits?.monthly?.resetAt
    // The live API carries no `windowLimits.monthly`; the billing period end is
    // the monthly reset and it arrives on the subscriptions endpoint.
    ?? subscriptionBody?.currentPeriodEnd
    ?? subscriptionBody?.currentPeriodEndAt

  const windows = []
  for (const id of WINDOW_IDS) {
    const raw = limitsEnvelope?.[id]
    const fallback = id === 'monthly'
      ? { used: usedMonthly, cap: derivedCap, resetAt: monthlyReset }
      : {}
    windows.push(buildWindow(id, raw, fallback))
  }
  return windows
}

/**
 * Fetch and normalize one Command Code snapshot.
 * The three upstream calls run in parallel; each failure is captured, so a dead
 * credits endpoint still reports whatever the usage endpoint returned.
 * @param key - bearer secret.
 * @returns { windows, remainingMonthlyCredits, subscription }.
 */
async function readCommandCode(key) {
  const [credits, usage, subscriptions] = await Promise.allSettled([
    getJson(CC_CREDITS_URL, key),
    getJson(CC_USAGE_URL, key),
    getJson(CC_SUBSCRIPTIONS_URL, key),
  ])

  const creditsBody = credits.status === 'fulfilled' ? credits.value : null
  const usageBody = usage.status === 'fulfilled' ? usage.value : null
  const subscriptionsBody = subscriptions.status === 'fulfilled' ? subscriptions.value : null

  const failures = []
  if (credits.status === 'fulfilled') {
    const problem = businessError(creditsBody)
    if (problem) failures.push(problem)
  } else {
    failures.push(`credits ${describeError(credits.reason)}`)
  }
  if (usage.status === 'fulfilled') {
    const problem = businessError(usageBody)
    if (problem) failures.push(problem)
  } else {
    failures.push(`usage ${describeError(usage.reason)}`)
  }
  if (subscriptions.status === 'rejected') failures.push(`subscriptions ${describeError(subscriptions.reason)}`)
  else {
    const problem = businessError(subscriptionsBody)
    if (problem) failures.push(problem)
  }

  const subscriptionData = subscriptionsBody?.data && typeof subscriptionsBody.data === 'object'
    ? subscriptionsBody.data
    : subscriptionsBody
  const subscription = subscriptionData && (subscriptionData.status || subscriptionData.planId)
    ? {
        status: typeof subscriptionData.status === 'string' ? subscriptionData.status : null,
        createdAt: isoInstant(subscriptionData.createdAt ?? subscriptionData.created_at),
      }
    : null

  return {
    windows: buildWindows(creditsBody, usageBody, subscriptionData),
    remainingMonthlyCredits: remainingMonthlyCreditsOf(creditsBody),
    subscription,
    error: failures.length > 0 ? failures.join('；').slice(0, 300) : null,
  }
}

/**
 * Fetch and normalize the DeepSeek balance.
 * @param key - bearer secret.
 * @returns an array of contract-shaped balance entries.
 */
async function readDeepSeek(key) {
  const body = await getJson(DS_BALANCE_URL, key)
  const problem = businessError(body)
  if (problem) throw new Error(problem)
  const infos = Array.isArray(body.balance_infos)
    ? body.balance_infos
    : (Array.isArray(body.balances) ? body.balances : [])
  const balances = []
  for (const info of infos) {
    if (!info || typeof info !== 'object') continue
    const currency = typeof info.currency === 'string' && info.currency.trim() !== ''
      ? info.currency.trim().toUpperCase()
      : null
    const totalBalance = pick(info, ['total_balance', 'totalBalance', 'total'])
    balances.push({
      currency,
      totalBalance: totalBalance === undefined ? null : String(totalBalance),
      grantedBalance: info.granted_balance === undefined ? null : String(info.granted_balance),
      toppedUpBalance: info.topped_up_balance === undefined ? null : String(info.topped_up_balance),
    })
  }
  if (balances.length === 0) throw new Error('余额接口未返回 balance_infos')
  return balances
}

/**
 * Host services required before apply() runs. `webServer` is needed to register the
 * two routes; `credentials` is deliberately NOT listed — it is optional and resolved
 * lazily with ctx.get() so a host without it still activates with the env fallback.
 */
export const inject = ['webServer']

/**
 * Register the quota-dock host half.
 * @param ctx - Host plugin context.
 * @returns a disposer that unregisters the routes and stops the refresher.
 */
export function apply(ctx) {
  let disposed = false

  /** Cache, mutated only by the single in-flight refresh loop. */
  const state = {
    /** Last successful upstream read, across providers; null before any success. */
    fetchedAt: null,
    /** First error of the most recent refresh cycle; null when it fully succeeded. */
    error: null,
    /** Whether a refresh loop is currently in flight. */
    fetching: false,
    /** Per-provider last-good values (CONTRACT.md §2). */
    cc: { ok: false, error: `${CC_KEY_REF} 未配置`, windows: [], remainingMonthlyCredits: null, subscription: null, fetchedAt: null, stale: false },
    deepseek: { ok: false, error: `${DS_KEY_REF} 未配置`, balances: [], fetchedAt: null, stale: false },
  }

  /** Single in-flight refresh promise; the dedupe latch (CONTRACT.md §2). */
  let inFlight = null

  /** Frozen snapshot of the last fully-successful whole refresh (expiry clock). */
  let cacheFilledAt = null

  /**
   * @returns every window still null while we hold a previous good copy.
   */
  function mergeWindows(previous, next) {
    if (!Array.isArray(previous) || previous.length === 0) return next
    return next.map((window) => {
      if (window.used !== null && window.cap !== null) return window
      const prior = previous.find((candidate) => candidate?.id === window.id)
      if (!prior) return window
      return {
        ...window,
        used: window.used ?? prior.used ?? null,
        cap: window.cap ?? prior.cap ?? null,
        resetAt: window.resetAt ?? prior.resetAt ?? null,
      }
    })
  }

  /** One refresh cycle: both providers in parallel, failures isolated per provider. */
  async function refreshOnce() {
    const ccKey = await resolveKey(ctx, CC_KEY_REF)
    const dsKey = await resolveKey(ctx, DS_KEY_REF)
    const failures = []

    const ccRun = async () => {
      if (ccKey === null) {
        state.cc = { ...state.cc, ok: false, error: `${CC_KEY_REF} 未配置`, stale: state.cc.windows.length > 0 }
        failures.push(`${CC_KEY_REF} 未配置`)
        return
      }
      try {
        const read = await readCommandCode(ccKey)
        state.cc = {
          ok: true,
          error: read.windows.every((window) => window.used === null && window.cap === null)
            ? 'Command Code 未返回可识别的窗口数据'
            : read.error,
          windows: mergeWindows(state.cc.windows, read.windows),
          remainingMonthlyCredits: read.remainingMonthlyCredits ?? state.cc.remainingMonthlyCredits,
          subscription: read.subscription ?? state.cc.subscription,
          fetchedAt: Date.now(),
          stale: false,
        }
      } catch (error) {
        const message = describeError(error)
        failures.push(`Command Code ${message}`)
        // Last-good survives: the DeepSeek side is untouched and our own numbers stay.
        state.cc = { ...state.cc, ok: false, error: message, stale: state.cc.windows.length > 0 }
      }
    }

    const dsRun = async () => {
      if (dsKey === null) {
        state.deepseek = { ...state.deepseek, ok: false, error: `${DS_KEY_REF} 未配置`, stale: state.deepseek.balances.length > 0 }
        failures.push(`${DS_KEY_REF} 未配置`)
        return
      }
      try {
        const balances = await readDeepSeek(dsKey)
        state.deepseek = { ok: true, error: null, balances, fetchedAt: Date.now(), stale: false }
      } catch (error) {
        const message = describeError(error)
        failures.push(`DeepSeek ${message}`)
        state.deepseek = { ...state.deepseek, ok: false, error: message, stale: state.deepseek.balances.length > 0 }
      }
    }

    await Promise.allSettled([ccRun(), dsRun()])

    const successAt = Math.max(state.cc.fetchedAt ?? 0, state.deepseek.fetchedAt ?? 0)
    if (successAt > 0) {
      state.fetchedAt = successAt
      cacheFilledAt = Date.now()
    }
    state.error = failures.length > 0 ? failures.join('；').slice(0, 300) : null
  }

  /**
   * Start a refresh unless one is already in flight.
   * @returns the shared refresh promise.
   */
  function startRefresh() {
    if (inFlight !== null) return inFlight
    state.fetching = true
    inFlight = refreshOnce()
      .catch(() => {
        // refreshOnce isolates provider failures itself; this guards the loop.
        state.error = state.error ?? '刷新失败'
      })
      .finally(() => {
        state.fetching = false
        inFlight = null
      })
    return inFlight
  }

  /**
   * Current cache age, or null when nothing has been fetched successfully yet.
   * @returns milliseconds since the last successful refresh.
   */
  function ageMs() {
    if (cacheFilledAt === null) return null
    return Math.max(0, Date.now() - cacheFilledAt)
  }

  /**
   * @returns whether a refresh cycle should be kicked off for the current cache.
   */
  function shouldRefresh() {
    if (state.fetchedAt === null) return true
    const age = ageMs()
    return age === null || age > TTL_MS
  }

  /**
   * The wire payload (CONTRACT.md §1). Pure cache read — never awaits upstream.
   * @returns the snapshot body.
   */
  function snapshot() {
    const age = ageMs()
    const expired = state.fetchedAt !== null && (age === null || age > TTL_MS)
    return {
      ok: true,
      fetchedAt: state.fetchedAt,
      ageMs: age,
      // Showing old data when the cache expired, the last cycle failed, or a
      // provider is serving its last-good copy.
      stale: state.fetchedAt === null ? false : (expired || state.error !== null || state.cc.stale || state.deepseek.stale),
      fetching: state.fetching,
      error: state.error,
      cc: {
        ok: state.cc.ok,
        error: state.cc.error,
        windows: state.cc.windows,
        remainingMonthlyCredits: state.cc.remainingMonthlyCredits,
        subscription: state.cc.subscription,
      },
      deepseek: { ok: state.deepseek.ok, error: state.deepseek.error, balances: state.deepseek.balances },
    }
  }

  /** @param res - HTTP response. @param status - HTTP status. @param payload - JSON body. */
  function writeJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  const routes = [
    {
      kind: 'exact',
      path: SNAPSHOT_PATH,
      handler: (req, res) => {
        if (req?.method && req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        // Kick a refresh when the cache is empty or expired, then answer NOW.
        if (shouldRefresh()) startRefresh()
        writeJson(res, 200, snapshot())
      },
    },
    {
      kind: 'exact',
      path: REFRESH_PATH,
      handler: (req, res) => {
        if (req?.method && req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const started = inFlight === null
        startRefresh()
        writeJson(res, 200, { ok: true, started, fetching: true })
      },
    },
  ]

  const disposers = []
  for (const route of routes) {
    if (typeof ctx?.webServer?.register !== 'function') {
      throw new Error('dsh-quota-dock: ctx.webServer.register 不可用')
    }
    disposers.push(ctx.webServer.register(route))
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const release of disposers.splice(0)) {
      if (typeof release !== 'function') continue
      try {
        release()
      } catch {
        // A failing route disposer must not block the others.
      }
    }
  }

  if (typeof ctx?.effect === 'function') ctx.effect(() => dispose, 'dsh-quota-dock:cleanup')

  // Warm the cache on activation so the first dock render usually has numbers.
  startRefresh()

  return dispose
}
