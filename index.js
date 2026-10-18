/**
 * Host half of dsh-quota-dock.
 *
 * Publishes one cached snapshot of Command Code's three quota windows plus the
 * DeepSeek account balance over local HTTP routes, so the composer dock can
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
 *
 * CONTRACT.md §7 adds user-managed platforms on top of the two built-ins. Platform
 * records (name, kind, address, key) live in <DSH_HOME>/dsh-quota-dock/platforms.json,
 * written atomically with mode 0600. A stored key never leaves this module: every
 * response reports `hasKey` only. Each platform also keeps its own last-good
 * fields, so one dead platform cannot blank the others or the snapshot.
 */

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Default snapshot cadence, and the range the settings page may pick from. */
const DEFAULT_REFRESH_MS = 60_000
const REFRESH_CHOICES_MS = [30_000, 60_000, 120_000, 300_000, 600_000]
const MIN_REFRESH_MS = 15_000
const MAX_REFRESH_MS = 3_600_000

/**
 * Live cadence. Loaded from the store on every read, written by the settings
 * page; module scope is enough because one process hosts one plugin instance.
 */
let storeRefreshMs = DEFAULT_REFRESH_MS

/** Upstream request budget; Command Code legitimately needs 10-20s. */
const FETCH_TIMEOUT_MS = 25_000

/** Credential references; the ref literal IS the environment variable name. */
const CC_KEY_REF = 'COMMANDCODE_API_KEY'
const DS_KEY_REF = 'DEEPSEEK_API_KEY'

/** Frozen route paths (CONTRACT.md §1, §7.3). */
const SNAPSHOT_PATH = '/api/dsh-quota-dock/snapshot'
const REFRESH_PATH = '/api/dsh-quota-dock/refresh'
const PLATFORMS_PATH = '/api/dsh-quota-dock/platforms'

/** Upstream endpoints (CONTRACT.md §4, §7.3). */
const CC_BASE = 'https://api.commandcode.ai'
const CC_CREDITS_URL = `${CC_BASE}/alpha/billing/credits`
const CC_USAGE_URL = `${CC_BASE}/alpha/usage/summary`
const CC_SUBSCRIPTIONS_URL = `${CC_BASE}/alpha/billing/subscriptions`
const DS_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits'

/** Platform store, relative to DSH_HOME (CONTRACT.md §7.3). */
const STORE_DIR_NAME = 'dsh-quota-dock'
const STORE_FILE_NAME = 'platforms.json'

/** Platform kinds; `deepseek` is built in and may not be added. */
const PLATFORM_KINDS = ['openrouter', 'custom']

/** Per-platform request budget, shorter than the built-ins'. */
const PLATFORM_TIMEOUT_MS = 15_000

/** Bounds: how many flattened custom fields we publish, and how much body we buffer. */
const MAX_PLATFORM_FIELDS = 50
const MAX_BODY_BYTES = 64 * 1024

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
 * @param value - candidate flag.
 * @returns the boolean, or null when upstream did not report one.
 */
function booleanOf(value) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

/** A rejected request body: reported as 400, never as a store failure. */
class InvalidInput extends Error {}

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
 * @param timeoutMs - the budget that was in force, for the timeout wording.
 * @returns a short message.
 */
function describeError(error, timeoutMs = FETCH_TIMEOUT_MS) {
  if (!error || typeof error !== 'object') return '上游请求失败'
  const name = typeof error.name === 'string' ? error.name : ''
  const raw = messageOf(error.message) || '上游请求失败'
  if (name === 'TimeoutError' || name === 'AbortError' || /abort|timeout/i.test(raw)) {
    return `上游请求超时（${Math.round(timeoutMs / 1000)}s）`
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
 * @param timeoutMs - request budget.
 * @returns parsed JSON body.
 * @throws when the transport fails or the response is not a JSON object.
 */
async function getJson(url, key, timeoutMs = FETCH_TIMEOUT_MS) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeoutMs),
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
 * @returns { windows, remainingMonthlyCredits, usedMonthlyCredits, monthlyCap, credits, subscription }.
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
        planId: typeof subscriptionData.planId === 'string' ? subscriptionData.planId : null,
        currentPeriodStart: isoInstant(subscriptionData.currentPeriodStart ?? subscriptionData.current_period_start),
        currentPeriodEnd: isoInstant(subscriptionData.currentPeriodEnd ?? subscriptionData.current_period_end),
        createdAt: isoInstant(subscriptionData.createdAt ?? subscriptionData.created_at),
      }
    : null

  const windows = buildWindows(creditsBody, usageBody, subscriptionData)
  const remainingMonthly = remainingMonthlyCreditsOf(creditsBody)
  const usedMonthlyCredits = usedMonthlyCreditsOf(usageBody)
  // The panel prints cc.monthlyCap beside cc.windows.monthly.cap, so the window's
  // own (server-reportable) cap wins whenever there is one: the two must agree.
  const monthlyWindow = windows.find((window) => window.id === 'monthly')
  const monthlyCap = monthlyWindow?.cap
    ?? (usedMonthlyCredits !== null && remainingMonthly !== null ? usedMonthlyCredits + remainingMonthly : null)

  return {
    windows,
    remainingMonthlyCredits: remainingMonthly,
    usedMonthlyCredits,
    monthlyCap,
    credits: creditsDetailOf(creditsBody),
    subscription,
    error: failures.length > 0 ? failures.join('；').slice(0, 300) : null,
  }
}

/**
 * Fetch and normalize the DeepSeek balance.
 * @param key - bearer secret.
 * @returns { balances, isAvailable }.
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
  return { balances, isAvailable: booleanOf(body.is_available ?? body.isAvailable) }
}

/** What a platform reports before its first successful read. */
const PLATFORM_EMPTY_RUNTIME = Object.freeze({ ok: false, error: null, fetchedAt: null, fields: [] })

/** `cc.credits` before the first usable credits response (CONTRACT.md §7.1). */
const EMPTY_CREDITS = Object.freeze({
  monthlyCredits: null,
  purchasedCredits: null,
  freeCredits: null,
  belowThreshold: null,
  creditThreshold: null,
})

/**
 * @returns the absolute path of the platform store (CONTRACT.md §7.3).
 */
function storePath() {
  const configured = typeof process.env?.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const home = configured !== '' ? configured : join(homedir(), '.dsh')
  return join(home, STORE_DIR_NAME, STORE_FILE_NAME)
}

/**
 * @param raw - one stored entry.
 * @returns a usable record, or null when the entry is malformed.
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
  if (id === '' || !PLATFORM_KINDS.includes(kind)) return null
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id,
    kind,
    baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl.trim() !== '' ? raw.baseUrl.trim() : null,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
  }
}

/**
 * Read the platform store.
 * @returns the stored records; an empty array when the file does not exist yet.
 * @throws when the file exists but cannot be read or parsed, so that callers keep
 * whatever they already show instead of concluding that nothing is configured.
 */
/**
 * @param value - stored cadence.
 * @returns a cadence inside the accepted range; anything else falls back.
 */
function normalizeRefreshMs(value) {
  const parsed = finite(value)
  if (parsed === null) return DEFAULT_REFRESH_MS
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.round(parsed)))
}

/**
 * Read the whole store: the platform records plus the refresh cadence.
 * A legacy array-only file is understood and keeps the default cadence.
 * @returns `{ platforms, refreshMs }`.
 */
async function readStoreDoc() {
  let text
  try {
    text = await readFile(storePath(), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { platforms: [], refreshMs: DEFAULT_REFRESH_MS }
    throw error
  }
  const parsed = JSON.parse(text)
  const list = Array.isArray(parsed) ? parsed : parsed?.platforms
  if (!Array.isArray(list)) throw new Error('平台存储格式无效')
  const refreshMs = normalizeRefreshMs(Array.isArray(parsed) ? null : parsed?.refreshMs)
  storeRefreshMs = refreshMs
  return { platforms: list.map(normalizeRecord).filter(Boolean), refreshMs }
}

/**
 * @returns just the platform records.
 */
async function readStore() {
  const doc = await readStoreDoc()
  return doc.platforms
}

/**
 * Replace the platform store atomically, best-effort 0600 (CONTRACT.md §7.3).
 * @param records - the full record list.
 */
async function writeStore(records) {
  const path = storePath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify({ version: 1, refreshMs: storeRefreshMs, platforms: records }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
  try {
    await chmod(path, 0o600)
  } catch {
    // Windows and some filesystems ignore POSIX modes; the create mode already applied.
  }
}

/**
 * @param value - number.
 * @returns the number with float noise trimmed, or null.
 */
function round6(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null
}

/**
 * Flatten the first two levels of numeric fields (CONTRACT.md §7.3, `custom`).
 * @param body - parsed response object.
 * @returns up to MAX_PLATFORM_FIELDS `{label, value}` entries.
 */
function flattenNumeric(body) {
  const out = []
  const walk = (source, prefix, depth) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return
    for (const [key, value] of Object.entries(source)) {
      if (out.length >= MAX_PLATFORM_FIELDS) return
      const label = prefix === '' ? key : `${prefix}.${key}`
      const number = finite(value)
      if (number !== null) out.push({ label, value: number })
      else if (depth < 1 && value && typeof value === 'object' && !Array.isArray(value)) walk(value, label, depth + 1)
    }
  }
  walk(body, '', 0)
  return out
}

/**
 * Read one OpenRouter key's credit totals, deriving the spendable balance.
 * @param key - bearer secret.
 * @returns `{label, value}` entries.
 */
async function readOpenRouter(key) {
  const body = await getJson(OPENROUTER_CREDITS_URL, key, PLATFORM_TIMEOUT_MS)
  const problem = businessError(body)
  if (problem) throw new Error(problem)
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body
  const total = finite(pick(data, ['total_credits', 'totalCredits']))
  const usage = finite(pick(data, ['total_usage', 'totalUsage']))
  return [
    { label: 'total_credits', value: total },
    { label: 'total_usage', value: usage },
    { label: 'balance', value: total !== null && usage !== null ? round6(total - usage) : null },
  ]
}

/**
 * Read a generic JSON endpoint with a bearer token.
 * @param record - a stored `custom` platform record.
 * @returns flattened `{label, value}` entries.
 */
async function readCustom(record) {
  const body = await getJson(record.baseUrl, record.apiKey, PLATFORM_TIMEOUT_MS)
  const problem = businessError(body)
  if (problem) throw new Error(problem)
  return flattenNumeric(body)
}

/**
 * Buffer and parse a JSON request body.
 * @param req - node HTTP request.
 * @returns the parsed object; `{}` for an empty body.
 * @throws InvalidInput when the body is oversized or not a JSON object.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > MAX_BODY_BYTES) {
        fail(new InvalidInput('请求体过大'))
        req.destroy?.()
      }
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        const parsed = text === '' ? {} : JSON.parse(text)
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch {
        reject(new InvalidInput('请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => fail(new InvalidInput(messageOf(error) || '请求体读取失败')))
  })
}

/**
 * Assemble the contract's `cc.credits` detail object (CONTRACT.md §7.1).
 * @param creditsBody - parsed /alpha/billing/credits body, or null.
 * @returns the five fields, each null when upstream did not report it.
 */
function creditsDetailOf(creditsBody) {
  const credits = creditsOf(creditsBody)
  return {
    monthlyCredits: nonNegative(pick(credits, ['monthlyCredits', 'monthlyRemaining', 'monthlyCreditsRemaining'])),
    purchasedCredits: nonNegative(pick(credits, ['purchasedCredits', 'purchased', 'toppedUpCredits', 'topUpCredits'])),
    freeCredits: nonNegative(pick(credits, ['freeCredits', 'free', 'grantedCredits'])),
    belowThreshold: booleanOf(pick(credits, ['belowThreshold', 'belowCreditThreshold'])),
    creditThreshold: nonNegative(pick(credits, ['creditThreshold', 'threshold'])),
  }
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
    cc: { ok: false, error: `${CC_KEY_REF} 未配置`, windows: [], remainingMonthlyCredits: null, usedMonthlyCredits: null, monthlyCap: null, credits: EMPTY_CREDITS, subscription: null, fetchedAt: null, stale: false },
    deepseek: { ok: false, error: `${DS_KEY_REF} 未配置`, isAvailable: null, balances: [], fetchedAt: null, stale: false },
    /** User-managed platforms, cache-only (CONTRACT.md §7.1); never carries a key. */
    platforms: [],
  }

  /** Last-good runtime result per platform id (CONTRACT.md §7.3). */
  const platformRuntime = new Map()

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
          usedMonthlyCredits: read.usedMonthlyCredits ?? state.cc.usedMonthlyCredits,
          monthlyCap: read.monthlyCap ?? state.cc.monthlyCap,
          credits: read.credits ?? state.cc.credits,
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
        const read = await readDeepSeek(dsKey)
        state.deepseek = { ok: true, error: null, isAvailable: read.isAvailable, balances: read.balances, fetchedAt: Date.now(), stale: false }
      } catch (error) {
        const message = describeError(error)
        failures.push(`DeepSeek ${message}`)
        state.deepseek = { ...state.deepseek, ok: false, error: message, stale: state.deepseek.balances.length > 0 }
      }
    }

    await Promise.allSettled([ccRun(), dsRun(), refreshPlatforms()])

    const platformSuccessAt = state.platforms.reduce((max, platform) => Math.max(max, platform.fetchedAt ?? 0), 0)
    const successAt = Math.max(state.cc.fetchedAt ?? 0, state.deepseek.fetchedAt ?? 0, platformSuccessAt)
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
    return age === null || age > storeRefreshMs
  }

  /**
   * @param record - a stored platform record.
   * @returns the contract view of one platform; the key is never included.
   */
  function platformView(record) {
    const runtime = platformRuntime.get(record.id) ?? PLATFORM_EMPTY_RUNTIME
    return {
      id: record.id,
      name: record.name,
      kind: record.kind,
      baseUrl: record.baseUrl,
      hasKey: record.apiKey.trim() !== '',
      ok: runtime.ok,
      error: runtime.error,
      fetchedAt: runtime.fetchedAt,
      fields: runtime.fields,
    }
  }

  /**
   * Refresh one platform, keeping its last-good fields when the read fails.
   * @param record - a stored platform record.
   */
  async function refreshOnePlatform(record) {
    const previous = platformRuntime.get(record.id) ?? PLATFORM_EMPTY_RUNTIME
    const key = record.apiKey.trim()
    if (key === '') {
      platformRuntime.set(record.id, { ok: false, error: 'API key 未配置', fetchedAt: previous.fetchedAt, fields: previous.fields })
      return
    }
    try {
      const fields = record.kind === 'openrouter' ? await readOpenRouter(key) : await readCustom(record)
      platformRuntime.set(record.id, { ok: true, error: null, fetchedAt: Date.now(), fields })
    } catch (error) {
      platformRuntime.set(record.id, {
        ok: false,
        error: describeError(error, PLATFORM_TIMEOUT_MS),
        fetchedAt: previous.fetchedAt,
        fields: previous.fields,
      })
    }
  }

  /**
   * Re-read the platform store and refresh every platform in parallel.
   * Never throws: an unreadable store must leave the current view alone, and one
   * dead platform must not disturb the others or the rest of the cycle.
   */
  async function refreshPlatforms() {
    let records
    try {
      records = await readStore()
    } catch {
      return
    }
    const live = new Set(records.map((record) => record.id))
    for (const id of [...platformRuntime.keys()]) {
      if (!live.has(id)) platformRuntime.delete(id)
    }
    for (const record of records) {
      if (!platformRuntime.has(record.id)) platformRuntime.set(record.id, { ...PLATFORM_EMPTY_RUNTIME, fields: [] })
    }
    await Promise.allSettled(records.map((record) => refreshOnePlatform(record)))
    state.platforms = records.map((record) => platformView(record))
  }

  /**
   * @returns whether any configured platform still lacks data or is past the TTL.
   */
  function platformsDue() {
    if (state.platforms.length === 0) return false
    const now = Date.now()
    return state.platforms.some((platform) => platform.fetchedAt === null || now - platform.fetchedAt > storeRefreshMs)
  }

  /**
   * @param body - parsed POST body.
   * @returns a new platform record.
   * @throws InvalidInput when any required field is missing or malformed.
   */
  function buildPlatform(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name === '') throw new InvalidInput('name 必填')
    if (name.length > 60) throw new InvalidInput('name 过长（最多 60 字）')
    const kind = typeof body.kind === 'string' ? body.kind.trim() : ''
    if (!PLATFORM_KINDS.includes(kind)) throw new InvalidInput('kind 必须是 openrouter 或 custom')
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    if (apiKey === '') throw new InvalidInput('apiKey 必填')
    if (kind === 'openrouter') {
      // The address is fixed for this kind; the contract's §7.3 text listed a
      // baseUrl for `custom` and conveyed openrouter's via §7.1's data.total_credits.
      return { id: randomUUID(), name, kind, baseUrl: OPENROUTER_CREDITS_URL, apiKey }
    }
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
    if (!/^https?:\/\//i.test(baseUrl)) throw new InvalidInput('custom 平台需要 http(s) baseUrl')
    if (baseUrl.length > 500) throw new InvalidInput('baseUrl 过长')
    return { id: randomUUID(), name, kind, baseUrl, apiKey }
  }

  /**
   * GET lists platforms (never keys); POST adds or removes one (CONTRACT.md §7.3).
   * @param req - HTTP request.
   * @param res - HTTP response.
   */
  async function handlePlatforms(req, res) {
    const method = req?.method ?? 'GET'
    if (method === 'GET') {
      const records = await readStore()
      state.platforms = records.map((record) => platformView(record))
      if (platformsDue() || shouldRefresh()) startRefresh()
      writeJson(res, 200, {
        ok: true,
        platforms: state.platforms,
        refreshMs: storeRefreshMs,
        refreshChoices: REFRESH_CHOICES_MS,
        storePath: storePath(),
      })
      return
    }
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      writeJson(res, 400, { ok: false, error: messageOf(error?.message) || '请求体无效' })
      return
    }
    const action = typeof body.action === 'string' ? body.action.trim() : ''
    try {
      const records = await readStore()
      if (action === 'settings') {
        const wanted = finite(body.refreshMs)
        if (wanted === null || !REFRESH_CHOICES_MS.includes(Math.round(wanted))) {
          throw new InvalidInput('refreshMs 不在可选范围')
        }
        storeRefreshMs = Math.round(wanted)
        await writeStore(records)
        writeJson(res, 200, {
          ok: true,
          platforms: state.platforms,
          refreshMs: storeRefreshMs,
          refreshChoices: REFRESH_CHOICES_MS,
          storePath: storePath(),
        })
        return
      }
      if (action === 'add') {
        records.push(buildPlatform(body))
      } else if (action === 'remove') {
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (id === '') throw new InvalidInput('id 必填')
        const kept = records.filter((record) => record.id !== id)
        if (kept.length === records.length) throw new InvalidInput('未找到该平台')
        records.length = 0
        records.push(...kept)
        platformRuntime.delete(id)
      } else {
        throw new InvalidInput('action 必须是 add 或 remove')
      }
      await writeStore(records)
      state.platforms = records.map((record) => platformView(record))
      // A freshly added platform has no numbers yet; fill them in the background.
      if (action === 'add') startRefresh()
      writeJson(res, 200, { ok: true, platforms: state.platforms })
    } catch (error) {
      if (error instanceof InvalidInput) {
        writeJson(res, 400, { ok: false, error: messageOf(error.message) || '请求无效' })
        return
      }
      writeJson(res, 500, { ok: false, error: '平台配置写入失败' })
    }
  }

  /**
   * The wire payload (CONTRACT.md §1). Pure cache read — never awaits upstream.
   * @returns the snapshot body.
   */
  function snapshot() {
    const age = ageMs()
    const expired = state.fetchedAt !== null && (age === null || age > storeRefreshMs)
    // A platform serving its last-good fields counts as stale, but never raises
    // the snapshot's own error: platforms report through their own ok/error.
    const platformsStale = state.platforms.some((platform) => platform.ok === false && platform.fields.length > 0)
    return {
      ok: true,
      fetchedAt: state.fetchedAt,
      ageMs: age,
      // The cadence the sheet's footer prints, so the panel and the settings page
      // can never disagree about how often the numbers are re-read.
      refreshMs: storeRefreshMs,
      // Showing old data when the cache expired, the last cycle failed, or a
      // provider is serving its last-good copy.
      stale: state.fetchedAt === null
        ? false
        : (expired || state.error !== null || state.cc.stale || state.deepseek.stale || platformsStale),
      fetching: state.fetching,
      error: state.error,
      cc: {
        ok: state.cc.ok,
        error: state.cc.error,
        windows: state.cc.windows,
        remainingMonthlyCredits: state.cc.remainingMonthlyCredits,
        usedMonthlyCredits: state.cc.usedMonthlyCredits,
        monthlyCap: state.cc.monthlyCap,
        credits: state.cc.credits,
        subscription: state.cc.subscription,
      },
      deepseek: {
        ok: state.deepseek.ok,
        error: state.deepseek.error,
        isAvailable: state.deepseek.isAvailable,
        balances: state.deepseek.balances,
      },
      platforms: state.platforms,
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
        // The cycle also refreshes the platform store (CONTRACT.md §7.3).
        startRefresh()
        writeJson(res, 200, { ok: true, started, fetching: true })
      },
    },
    {
      kind: 'exact',
      path: PLATFORMS_PATH,
      handler: async (req, res) => {
        try {
          await handlePlatforms(req, res)
        } catch {
          // Store I/O failed. Never a 200, and never a leaked path or secret.
          writeJson(res, 500, { ok: false, error: '平台配置不可用' })
        }
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
    platformRuntime.clear()
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
