/**
 * OpenCode Go usage meter for the Harness.
 *
 * Two read-only facts, both rendered by the Client half in the composer dock
 * beside the token pills:
 *
 * - Subscription allowance windows (5-hour / weekly / monthly) of an
 *   `opencode-go` route, read from OpenCode's API-key-authenticated usage
 *   endpoint.
 * - The exact USD cost of the current Session, folded from the durable log's
 *   usage-bearing model attempts and priced with the published OpenCode Go
 *   per-model rates (peak and off-peak for DeepSeek models).
 *
 * The plugin imports no `@deepseek-ai/*` module: a profile-installed bundle
 * cannot resolve the App's internal packages, so configuration is normalized
 * here, the API key resolves through the credential seam by reference, and the
 * browser reaches the Host through the web-server route seam.
 *
 * @module @local/dsh-opencode-go-usage
 */

export const name = 'opencode-go-usage'

/** The credential seam resolves the same reference the provider config uses. */
export const inject = ['credentials']

/** Keep in sync with package.json; visible in the Host log on activation. */
export const VERSION = '1.0.0'

// Kept out of `/plugin/` on purpose: the client-artifact route owns that
// namespace and, when it registers before this plugin on a cold Host start, it
// answers 404 for `/plugin/opencode-go-usage/report` before this prefix route is
// consulted. A namespace of our own cannot be shadowed by load order.
const API_PREFIX = '/opencode-go-usage/api'
const MAX_BODY_BYTES = 8 * 1024

/** USD per 1M tokens, published by OpenCode Go docs (2026-11). */
const DEFAULT_PRICES = {
  'deepseek-v4.1-flash': { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0, peak: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } },
  'deepseek-v4-pro': { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0, peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 } },
  'glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  'glm-5.3-flash': { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
  'kimi-k3': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  'kimi-k3.1-pro': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
  'kimi-k2.7-code': { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
  'qwen3.8-max': { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
  'qwen3.8-flash': { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  'grok-4.7': { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
  'minimax-m3.1-flash': { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
  'mimo-v2.6-flash': { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
}

/** Monthly included usage per model, used to read a percent as dollars. */
const DEFAULT_MONTHLY_LIMITS = {
  'deepseek-v4.1-flash': 100,
  'deepseek-v4-pro': 15,
  'glm-5.3': 15,
  'glm-5.3-flash': 60,
  'kimi-k3': 15,
  'kimi-k3.1-pro': 15,
  'qwen3.8-max': 15,
  'qwen3.8-flash': 30,
  'claude-haiku-5-5': 15,
  'gpt-6-luna': 15,
  'grok-4.7': 15,
}

/** DeepSeek peak hours are UTC and weekdays only, per the Go docs. */
const DEEPSEEK_PEAK_HOURS_UTC = [[1, 4], [6, 10]]

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function rateOf(value, label) {
  const rate = finiteNumber(value)
  if (rate === undefined || rate < 0) throw new Error(`opencode-go-usage: ${label} must be a non-negative number`)
  return rate
}

/** Validate one model's rate row, keeping a missing `peak` block absent. */
function normalizeRate(row, label) {
  if (!isPlainObject(row)) throw new Error(`opencode-go-usage: ${label} must be an object`)
  const rate = {
    input: rateOf(row.input, `${label}.input`),
    output: rateOf(row.output, `${label}.output`),
    cacheRead: rateOf(row.cacheRead ?? 0, `${label}.cacheRead`),
    cacheWrite: rateOf(row.cacheWrite ?? 0, `${label}.cacheWrite`),
  }
  if (row.peak === undefined) return rate
  if (!isPlainObject(row.peak)) throw new Error(`opencode-go-usage: ${label}.peak must be an object`)
  return { ...rate, peak: normalizeRate(row.peak, `${label}.peak`) }
}

/** Normalize the raw Loader config; unknown fields are ignored. */
function normalizeConfig(raw) {
  const source = isPlainObject(raw) ? raw : {}
  const prices = { ...DEFAULT_PRICES }
  if (source.prices !== undefined) {
    if (!isPlainObject(source.prices)) throw new Error('opencode-go-usage: prices must be an object keyed by model id')
    for (const [model, row] of Object.entries(source.prices)) prices[model] = normalizeRate(row, `prices.${model}`)
  }
  const monthlyLimits = { ...DEFAULT_MONTHLY_LIMITS }
  if (source.monthlyLimits !== undefined) {
    if (!isPlainObject(source.monthlyLimits)) throw new Error('opencode-go-usage: monthlyLimits must be an object keyed by model id')
    for (const [model, value] of Object.entries(source.monthlyLimits)) {
      const limit = finiteNumber(value)
      if (limit === undefined || limit < 0) throw new Error(`opencode-go-usage: monthlyLimits.${model} must be a non-negative number`)
      monthlyLimits[model] = limit
    }
  }
  const baseUrl = source.baseUrl ?? 'https://opencode.ai'
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new Error('opencode-go-usage: baseUrl must be an http(s) URL')
  }
  const apiKeyRef = source.apiKeyRef ?? 'OPENCODE_GO_API_KEY'
  if (typeof apiKeyRef !== 'string' || apiKeyRef.length === 0) {
    throw new Error('opencode-go-usage: apiKeyRef must be a non-empty credential reference')
  }
  const usagePaths = source.usagePaths ?? ['/zen/go/v1/usage', '/inference/go/v1/usage']
  if (!Array.isArray(usagePaths) || usagePaths.length === 0 || usagePaths.some((p) => typeof p !== 'string')) {
    throw new Error('opencode-go-usage: usagePaths must be a non-empty array of path strings')
  }
  const quotaTtlSeconds = finiteNumber(source.quotaTtlSeconds) ?? 30
  const requestTimeoutMs = finiteNumber(source.requestTimeoutMs) ?? 10_000
  return {
    apiKeyRef,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    usagePaths,
    quotaTtlSeconds: Math.max(5, Math.min(600, quotaTtlSeconds)),
    requestTimeoutMs: Math.max(1_000, Math.min(60_000, requestTimeoutMs)),
    prices,
    monthlyLimits,
  }
}

/** Whether an epoch time falls in a DeepSeek peak window (UTC, Mon–Fri). */
function inPeakWindow(timeMs) {
  const date = new Date(timeMs)
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  return DEEPSEEK_PEAK_HOURS_UTC.some(([start, end]) => hour >= start && hour < end)
}

function usageFromStream(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record !== null && typeof record === 'object' && record.type === 'chunk'
      && record.chunk !== null && typeof record.chunk === 'object' && record.chunk.type === 'usage') {
      const usage = record.chunk.usage
      if (isPlainObject(usage)) return usage
    }
  }
  return undefined
}

function bucketsOf(usage) {
  return {
    input: finiteNumber(usage.inputTokens) ?? 0,
    output: finiteNumber(usage.outputTokens) ?? 0,
    cacheRead: finiteNumber(usage.cacheReadTokens) ?? 0,
    cacheWrite: finiteNumber(usage.cacheWriteTokens) ?? 0,
  }
}

function rateFor(config, model, timeMs) {
  const row = config.prices[model]
  if (row === undefined) return undefined
  return row.peak !== undefined && inPeakWindow(timeMs) ? row.peak : row
}

function usdOf(buckets, rate) {
  return (buckets.input * rate.input
    + buckets.output * rate.output
    + buckets.cacheRead * rate.cacheRead
    + buckets.cacheWrite * rate.cacheWrite) / 1_000_000
}

/**
 * Fold the durable log into billed usage per model.
 *
 * Every usage-bearing `assistant/message` and `assistant/attempt` is billed:
 * a retried attempt is a second provider request, so it is a second charge.
 *
 * @param events - committed Session events in log order.
 * @param config - normalized plugin config.
 */
export function foldSessionCost(events, config) {
  const models = new Map()
  const unpriced = new Set()
  let lastModel
  const add = (buckets, provider, model, timeMs) => {
    if (buckets.input === 0 && buckets.output === 0 && buckets.cacheRead === 0 && buckets.cacheWrite === 0) return
    const key = `${provider ?? ''}/${model ?? ''}`
    const entry = models.get(key) ?? {
      provider: provider ?? 'unknown',
      model: model ?? 'unknown',
      costUsd: 0,
      calls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    entry.calls += 1
    entry.tokens.input += buckets.input
    entry.tokens.output += buckets.output
    entry.tokens.cacheRead += buckets.cacheRead
    entry.tokens.cacheWrite += buckets.cacheWrite
    const rate = model === undefined ? undefined : rateFor(config, model, timeMs)
    if (rate === undefined) {
      if (model !== undefined) unpriced.add(model)
    } else {
      entry.costUsd += usdOf(buckets, rate)
    }
    models.set(key, entry)
  }

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    // An attempt carries no message source, so the route in force at that
    // request is the last logged header or route-context record.
    if (event.type === 'request/header' && isPlainObject(data) && isPlainObject(data.header) && isPlainObject(data.header.config)) {
      const config_ = data.header.config
      if (typeof config_.model === 'string') {
        lastModel = { provider: typeof config_.provider === 'string' ? config_.provider : undefined, model: config_.model }
      }
      continue
    }
    if (event.type === 'request/context' && isPlainObject(data) && typeof data.model === 'string') {
      lastModel = { provider: typeof data.provider === 'string' ? data.provider : undefined, model: data.model }
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    if (!isPlainObject(data)) continue
    const usage = event.type === 'assistant/message'
      ? (isPlainObject(data.usage) ? data.usage : usageFromStream(data.stream))
      : usageFromStream(data.stream)
    if (usage === undefined) continue
    const source = event.type === 'assistant/message' && isPlainObject(data.message) && isPlainObject(data.message.source)
      ? data.message.source
      : undefined
    if (source !== undefined && typeof source.model === 'string') {
      lastModel = { provider: typeof source.provider === 'string' ? source.provider : undefined, model: source.model }
    }
    const time = finiteNumber(event.time) ?? Date.now()
    add(bucketsOf(usage), source?.provider ?? lastModel?.provider, source?.model ?? lastModel?.model, time)
  }

  const rows = [...models.values()].sort((left, right) => right.costUsd - left.costUsd)
  const totals = rows.reduce((sum, row) => ({
    input: sum.input + row.tokens.input,
    output: sum.output + row.tokens.output,
    cacheRead: sum.cacheRead + row.tokens.cacheRead,
    cacheWrite: sum.cacheWrite + row.tokens.cacheWrite,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  return {
    costUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
    calls: rows.reduce((sum, row) => sum + row.calls, 0),
    tokens: totals,
    models: rows,
    unpricedModels: [...unpriced],
  }
}

function numberOrNull(value) {
  const number = finiteNumber(value)
  return number === undefined ? null : number
}

function windowFrom(raw) {
  if (!isPlainObject(raw)) return null
  const used = numberOrNull(raw.used ?? raw.costUsd ?? raw.amountUsed)
  const limit = numberOrNull(raw.limit ?? raw.limitUsd ?? raw.amountLimit)
  let percent = numberOrNull(raw.percent ?? raw.usagePercent ?? raw.pct)
  if (percent === null && used !== null && limit !== null && limit > 0) percent = (used / limit) * 100
  const resetsAt = typeof raw.resetsAt === 'string' ? raw.resetsAt : (typeof raw.resets_at === 'string' ? raw.resets_at : null)
  return {
    status: typeof raw.status === 'string' ? raw.status : null,
    percent,
    used,
    limit,
    resetsAt,
  }
}

/**
 * Accept every known shape of the usage endpoint without assuming one:
 * `{ usage: { rolling, weekly, monthly } }`, `{ windows: [...] }`, or a bare
 * window map.
 *
 * @param body - decoded JSON reply.
 */
export function normalizeUsageReply(body) {
  const windows = { rolling: null, weekly: null, monthly: null, other: [] }
  let plan = null
  let balance = null
  if (!isPlainObject(body)) return { windows, plan, balance }
  plan = typeof body.plan === 'string' ? body.plan : (typeof body.planId === 'string' ? body.planId : null)
  const balanceSource = isPlainObject(body.balance) ? body.balance : undefined
  if (balanceSource !== undefined) balance = numberOrNull(balanceSource.remaining ?? balanceSource.amount ?? balanceSource.credit)
  const container = Array.isArray(body.windows)
    ? body.windows
    : isPlainObject(body.usage) ? body.usage : (isPlainObject(body.windows) ? body.windows : body)
  if (Array.isArray(container)) {
    for (const entry of container) {
      if (!isPlainObject(entry)) continue
      const name = String(entry.name ?? entry.window ?? 'other').toLowerCase()
      const window = windowFrom(entry)
      if (window === null) continue
      if (name.includes('roll') || name.includes('5h') || name.includes('hour')) windows.rolling = window
      else if (name.includes('week') || name.includes('7d')) windows.weekly = window
      else if (name.includes('month') || name.includes('30d')) windows.monthly = window
      else windows.other.push({ name, ...window })
    }
    return { windows, plan, balance }
  }
  windows.rolling = windowFrom(container.rolling ?? container['5h'] ?? container.fiveHour)
  windows.weekly = windowFrom(container.weekly ?? container['7d'] ?? container.week)
  windows.monthly = windowFrom(container.monthly ?? container['30d'] ?? container.month)
  if (isPlainObject(container.windows)) {
    windows.rolling = windows.rolling ?? windowFrom(container.windows.rolling)
    windows.weekly = windows.weekly ?? windowFrom(container.windows.weekly)
    windows.monthly = windows.monthly ?? windowFrom(container.windows.monthly)
  }
  return { windows, plan, balance }
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  return isPlainObject(parsed) ? parsed : {}
}

/**
 * Mount the meter.
 *
 * @param ctx - Cordis context of the bundle row.
 * @param rawConfig - the row's `config` object.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = ctx.logger ?? console

  // Quota cache: one in-flight request per endpoint chain, shared by every
  // browser tab; the credential is resolved per call so a Settings change
  // takes effect on the next poll without a Host restart.
  let quotaCache
  let quotaInFlight

  const quotaState = () => ({
    ok: quotaCache?.ok === true,
    stale: quotaCache !== undefined && Date.now() - quotaCache.at > config.quotaTtlSeconds * 1_000,
    windows: quotaCache?.windows ?? { rolling: null, weekly: null, monthly: null, other: [] },
    plan: quotaCache?.plan ?? null,
    balance: quotaCache?.balance ?? null,
    fetchedAt: quotaCache?.at ?? null,
    endpoint: quotaCache?.endpoint ?? null,
    error: quotaCache?.error ?? null,
    hasKey: quotaCache?.hasKey ?? null,
    baseUrl: config.baseUrl,
  })

  async function resolveKey() {
    const resolved = await ctx.credentials.resolve(config.apiKeyRef)
    return typeof resolved?.value === 'string' && resolved.value.length > 0 ? resolved.value : undefined
  }

  async function fetchQuota() {
    const now = Date.now()
    if (quotaCache !== undefined && now - quotaCache.at < config.quotaTtlSeconds * 1_000) return quotaCache
    if (quotaInFlight !== undefined) return quotaInFlight
    quotaInFlight = (async () => {
      const key = await resolveKey()
      if (key === undefined) {
        quotaCache = { ok: false, at: now, hasKey: false, error: 'missing-key', windows: { rolling: null, weekly: null, monthly: null, other: [] } }
        return quotaCache
      }
      let lastError = 'unavailable'
      for (const usagePath of config.usagePaths) {
        const endpoint = `${config.baseUrl}${usagePath}`
        try {
          const response = await fetch(endpoint, {
            method: 'GET',
            headers: {
              authorization: `Bearer ${key}`,
              accept: 'application/json',
              'user-agent': `dsh-opencode-go-usage/${VERSION}`,
            },
            signal: AbortSignal.timeout(config.requestTimeoutMs),
          })
          if (response.status === 401 || response.status === 403) {
            lastError = `key-rejected (${response.status})`
            break
          }
          if (!response.ok) {
            lastError = `http-${response.status}`
            continue
          }
          const parsed = normalizeUsageReply(await response.json())
          quotaCache = { ok: true, at: Date.now(), hasKey: true, endpoint, ...parsed }
          return quotaCache
        } catch (error) {
          lastError = `request-failed: ${error?.message ?? error}`
        }
      }
      if (quotaCache === undefined || quotaCache.ok !== true) {
        quotaCache = {
          ok: false,
          at: Date.now(),
          hasKey: true,
          error: lastError,
          windows: { rolling: null, weekly: null, monthly: null, other: [] },
        }
      } else {
        quotaCache = { ...quotaCache, at: Date.now(), error: lastError, stale: true }
      }
      return quotaCache
    })()
    try {
      return await quotaInFlight
    } finally {
      quotaInFlight = undefined
    }
  }

  // Session cost cache: one entry per Session, invalidated by the log cursor.
  const sessionCache = new Map()

  function foldSession(session) {
    const events = typeof session?.snapshotEvents === 'function'
      ? session.snapshotEvents()
      : (Array.isArray(session?.events) ? session.events : [])
    const cursor = finiteNumber(session?.seq)
      ?? (events.length === 0 ? 0 : (finiteNumber(events[events.length - 1]?.seq) ?? events.length))
    const id = session?.id
    const cached = id === undefined ? undefined : sessionCache.get(id)
    if (cached !== undefined && cached.cursor === cursor) return cached.value
    const value = foldSessionCost(events, config)
    if (id !== undefined) sessionCache.set(id, { cursor, value })
    return value
  }

  async function sessionCostOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false, error: 'missing-session' }
    const query = ctx.get('sessionQuery')
    if (query !== undefined && typeof query.inspectSession === 'function') {
      try {
        const value = await query.inspectSession(sessionId, (session) => foldSession(session))
        return { ok: true, ...value, source: 'session-log' }
      } catch (error) {
        return { ok: false, error: `inspect-failed: ${error?.message ?? error}` }
      }
    }
    const live = ctx.get('sessions')?.get?.(sessionId)
    if (live !== undefined) return { ok: true, ...foldSession(live), source: 'live-session' }
    return { ok: false, error: 'session-unavailable' }
  }

  function limitForWindows(rows, modelHint) {
    const model = typeof modelHint === 'string' && config.monthlyLimits[modelHint] !== undefined ? modelHint : undefined
    if (model !== undefined) return { model, monthlyLimitUsd: config.monthlyLimits[model] }
    const priced = Object.keys(config.monthlyLimits)
    return { model: null, monthlyLimitUsd: priced.length === 1 ? config.monthlyLimits[priced[0]] : null }
  }

  function registerRoutes(scope) {
    const webServer = scope.get('webServer') ?? scope.webServer
    const connection = scope.get('connection') ?? scope.connection
    if (webServer === undefined) {
      log.info('opencode-go-usage: no web server in this composition; the meter has no browser surface')
      return
    }

    const handler = async (request, response) => {
      if (connection !== undefined && typeof connection.requestRejection === 'function') {
        const rejection = connection.requestRejection(request)
        if (rejection !== undefined) {
          response.writeHead(rejection, { 'content-type': 'text/plain' })
          response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
      }
      const url = new URL(request.url ?? '/', 'http://opencode-go-usage.invalid')
      if (!url.pathname.startsWith(API_PREFIX)) {
        sendJson(response, 404, { error: 'unknown route' })
        return
      }
      const route = url.pathname.slice(API_PREFIX.length) || '/'
      const method = request.method ?? 'GET'
      try {
        if (method === 'GET' && route === '/report') {
          const sessionId = url.searchParams.get('sessionId') ?? undefined
          const modelHint = url.searchParams.get('model') ?? undefined
          const [quota, session] = await Promise.all([fetchQuota(), sessionCostOf(sessionId)])
          sendJson(response, 200, {
            ok: true,
            at: Date.now(),
            version: VERSION,
            quota: quotaState(),
            session,
            limits: limitForWindows(quotaState().windows, modelHint),
          })
          return
        }
        if (method === 'GET' && route === '/quota') {
          await fetchQuota()
          sendJson(response, 200, { ok: true, at: Date.now(), quota: quotaState() })
          return
        }
        if (method === 'POST' && route === '/refresh') {
          try {
            await readJsonBody(request)
          } catch {
            // A refresh needs no body; a malformed one changes nothing.
          }
          quotaCache = undefined
          sessionCache.clear()
          await fetchQuota()
          sendJson(response, 200, { ok: true, at: Date.now(), quota: quotaState() })
          return
        }
        sendJson(response, 404, { error: `unknown route ${method} ${route}` })
      } catch (error) {
        log.warn('opencode-go-usage: %s %s failed: %s', method, route, error?.message ?? error)
        sendJson(response, 500, { error: String(error?.message ?? error) })
      }
    }

    scope.effect(
      () => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'opencode-go-usage: report API',
    )
  }

  // On a fresh Host start the web-app bundle (and its `webServer`/`connection`
  // services) can mount after this plugin applies, so a single `ctx.get()` read
  // here would drop the route for the whole process lifetime. `ctx.inject` ties
  // the registration to the services' availability: it runs as soon as both
  // exist, and again if either is replaced.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'connection'], (scope) => {
      registerRoutes(scope)
    })
  } else {
    registerRoutes(ctx)
  }

  ctx.effect(() => () => {
    sessionCache.clear()
    quotaCache = undefined
  }, 'opencode-go-usage: clear caches')

  log.info('opencode-go-usage %s: monthly limits and per-model prices are configurable', VERSION)
}
