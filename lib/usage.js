/**
 * Provider facts and pure shaping for CommandCode account data.
 *
 * CommandCode (commandcode.ai) exposes two read-only billing endpoints and one
 * OpenAI-compatible model catalog:
 *
 *   GET {base}/alpha/billing/credits         -> credit buckets + rate-limit windows
 *   GET {base}/alpha/billing/subscriptions   -> current subscription (soft-fail)
 *   GET {providerBase}/models                -> model catalog
 *
 * `{base}` is `https://api.commandcode.ai`; `{providerBase}` is that plus
 * `/provider/v1`. Everything in this module is pure so it can be unit tested
 * without a network or a Harness.
 *
 * @module dsh-commandcode/usage
 */

/** Account/billing API root. */
export const DEFAULT_ACCOUNT_BASE_URL = 'https://api.commandcode.ai'

/** OpenAI-compatible inference root used by the `llm-pi-ai` route. */
export const DEFAULT_PROVIDER_BASE_URL = 'https://api.commandcode.ai/provider/v1'

/** Default route key inside the `llm-pi-ai` `providers` dictionary. */
export const DEFAULT_ROUTE_KEY = 'commandcode'

/** Credential reference the route resolves per request. */
export const DEFAULT_API_KEY_REF = 'COMMANDCODE_API_KEY'

/** Protocol the route declares: CommandCode serves `POST /chat/completions`. */
export const DEFAULT_ROUTE_API = 'openai-completions'

/** Human labels for the subscription plan ids CommandCode issues. */
const PLAN_LABELS = {
  'individual-goat': 'GOAT',
  'individual-go': 'Go',
  'individual-pro': 'Pro',
  'individual-max-10x': 'Max 10x',
  'individual-max-20x': 'Max 20x',
  'team-pro': 'Team Pro',
}

/**
 * Turn a subscription plan id into a display label.
 * Unknown ids are title-cased rather than dropped, so a new plan still reads.
 * @param planId - raw `planId` from the subscriptions endpoint.
 * @returns a `Command Code · …` label, or plain `Command Code` when absent.
 */
export function humanizePlanId(planId) {
  if (typeof planId !== 'string' || planId.length === 0) return 'Command Code'
  const mapped = PLAN_LABELS[planId]
  if (mapped !== undefined) return `Command Code · ${mapped}`
  const title = planId
    .replace(/^individual-/, '')
    .replace(/^team-/, 'Team ')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
  return `Command Code · ${title || planId}`
}

/**
 * Coerce an unknown JSON value into a finite number, defaulting to 0.
 * A missing or non-numeric field must not poison the whole snapshot.
 * @param value - candidate number.
 * @returns a finite number.
 */
export function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Remaining share of a rate-limit window.
 * @param used - credits consumed in the window.
 * @param cap - window capacity; a non-positive cap means "unlimited".
 * @returns a percentage clamped to 0..100.
 */
export function remainingPercent(used, cap) {
  const capacity = num(cap)
  if (capacity <= 0) return 100
  const left = capacity - num(used)
  return Math.max(0, Math.min(100, (left / capacity) * 100))
}

/**
 * Format a credit amount the way the account surfaces it.
 * @param value - credit amount in USD.
 * @returns a `$0.00` string.
 */
export function formatCredits(value) {
  return `$${num(value).toFixed(2)}`
}

/**
 * Render the time left until a rate-limit window resets.
 * @param resetAt - epoch milliseconds, or a parseable date string.
 * @param now - current epoch milliseconds.
 * @returns `3d 4h`, `4h 12m`, `12m`, or `-` when unset/elapsed.
 */
export function formatCountdown(resetAt, now = Date.now()) {
  const target = typeof resetAt === 'string' ? Date.parse(resetAt) : num(resetAt)
  if (!Number.isFinite(target) || target <= 0) return '-'
  const delta = target - num(now)
  if (delta <= 0) return '-'
  const minutes = Math.floor(delta / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

/**
 * Normalize one rate-limit window from the credits payload.
 * @param raw - the `fiveHour` or `weekly` object.
 * @param key - stable window key the client localizes.
 * @returns a normalized window, or undefined when the payload omits it.
 */
function windowOf(raw, key) {
  if (raw === null || typeof raw !== 'object') return undefined
  const used = num(raw.used)
  const cap = num(raw.cap)
  const resetAt = num(raw.resetAt)
  return {
    key,
    used,
    cap,
    remaining: Math.max(0, cap - used),
    remainingPercent: remainingPercent(used, cap),
    exceeded: raw.exceeded === true,
    resetAt: resetAt > 0 ? new Date(resetAt).toISOString() : null,
  }
}

/**
 * Shape the `GET /alpha/billing/credits` payload into the account snapshot.
 * @param payload - parsed JSON body; any shape is accepted.
 * @returns credit buckets plus the rate-limit windows that were present.
 */
export function normalizeCredits(payload) {
  const root = payload !== null && typeof payload === 'object' ? payload : {}
  const credits = root.credits !== null && typeof root.credits === 'object' ? root.credits : {}
  const limits = root.windowLimits !== null && typeof root.windowLimits === 'object' ? root.windowLimits : {}

  const monthly = num(credits.monthlyCredits)
  const purchased = num(credits.purchasedCredits)
  const free = num(credits.freeCredits)
  const windows = [windowOf(limits.fiveHour, 'fiveHour'), windowOf(limits.weekly, 'weekly')].filter(
    (entry) => entry !== undefined,
  )

  return {
    credits: {
      monthly,
      purchased,
      free,
      total: monthly + purchased + free,
      belowThreshold: credits.belowThreshold === true,
      creditThreshold: num(credits.creditThreshold),
    },
    windows,
    limited: limits.limited === true,
    exceeded: typeof limits.exceeded === 'string' ? limits.exceeded : null,
    sandboxAccess: root.sandboxAccess === true,
    sandboxMinutes: typeof root.sandboxMinutes === 'number' ? root.sandboxMinutes : null,
  }
}

/**
 * Shape the `GET /alpha/billing/subscriptions` payload.
 * This endpoint is soft-fail: `null` is a normal answer meaning "unknown plan".
 * @param payload - parsed JSON body; any shape is accepted.
 * @returns the plan facts, or null when the payload carries no subscription.
 */
export function normalizeSubscription(payload) {
  const root = payload !== null && typeof payload === 'object' ? payload : {}
  const data = root.data !== null && typeof root.data === 'object' ? root.data : null
  if (data === null) return null
  const planId = typeof data.planId === 'string' && data.planId.length > 0 ? data.planId : null
  return {
    planId,
    planLabel: humanizePlanId(planId ?? undefined),
    status: typeof data.status === 'string' ? data.status : null,
    currentPeriodEnd: typeof data.currentPeriodEnd === 'string' ? data.currentPeriodEnd : null,
    cancelAtPeriodEnd: data.cancelAtPeriodEnd === true,
  }
}

/**
 * Derive the one-line summary the compact indicator shows.
 *
 * The weekly window is the primary budget; the five-hour window is reported
 * beside it only when it is the tighter of the two, because that is the case
 * where it is actually what will stop the next request. A bare
 * `fiveHour < 100%` test — the obvious alternative — is true after any usage
 * at all, so it reports a second number that never changes the decision. When
 * neither window exists (a pure provider-credit plan) the available balance is
 * the summary.
 *
 * @param snapshot - result of {@link buildSnapshot}.
 * @returns the summary text and the primary remaining percentage.
 */
export function summarize(snapshot) {
  const fiveHour = snapshot.windows.find((entry) => entry.key === 'fiveHour')
  const weekly = snapshot.windows.find((entry) => entry.key === 'weekly')
  const primary = weekly ?? fiveHour

  if (primary === undefined) {
    return { text: formatCredits(snapshot.credits.total), primaryRemainingPercent: null }
  }

  const parts = [`${primary.remainingPercent.toFixed(0)}%`]
  if (weekly !== undefined && fiveHour !== undefined && fiveHour.remainingPercent < weekly.remainingPercent) {
    parts.push(`(${fiveHour.remainingPercent.toFixed(0)}%)`)
  }
  let text = parts.join(' ')
  if (snapshot.credits.purchased > 0) text += ` ${formatCredits(snapshot.credits.purchased)}`

  return { text, primaryRemainingPercent: primary.remainingPercent }
}

/**
 * Merge the two billing responses into the single snapshot the UI renders.
 * @param input - raw credits payload, optional subscription payload, and clock.
 * @returns the normalized account snapshot.
 */
export function buildSnapshot(input) {
  const now = typeof input.now === 'number' ? input.now : Date.now()
  const credits = normalizeCredits(input.credits)
  const plan = normalizeSubscription(input.subscription ?? null)
  const snapshot = {
    ...credits,
    plan,
    fetchedAt: new Date(now).toISOString(),
  }
  return { ...snapshot, summary: summarize(snapshot) }
}

/**
 * Keep only models CommandCode serves over `POST /chat/completions`.
 *
 * A `llm-pi-ai` route speaks exactly one protocol, so a catalog entry that only
 * advertises `/messages` (the Claude family) would fail as `UNKNOWN_MODEL` on
 * the OpenAI-compatible route and must not be declared on it.
 *
 * @param models - catalog entries from `GET {providerBase}/models`.
 * @returns entries that list `/chat/completions`, or entries with no endpoint list.
 */
export function chatCompletionModels(models) {
  if (!Array.isArray(models)) return []
  return models.filter((model) => {
    const endpoints = model?.supported_endpoints
    if (!Array.isArray(endpoints) || endpoints.length === 0) return true
    return endpoints.includes('/chat/completions')
  })
}

/**
 * Shape catalog entries into `llm-pi-ai` route model declarations.
 * @param models - already-filtered catalog entries.
 * @returns route `models` entries with stable id/name/contextWindow.
 */
export function routeModels(models) {
  return models.map((model) => {
    const entry = { id: String(model.id), name: typeof model.name === 'string' && model.name.length > 0 ? model.name : String(model.id) }
    const contextWindow = num(model.context_length)
    if (contextWindow > 0) entry.contextWindow = contextWindow
    return entry
  })
}

/**
 * Compare a declared route against the catalog so a refresh only writes when
 * something actually changed.
 * @param declared - the route currently in the profile, if any.
 * @param wanted - the route this plugin would declare.
 * @returns true when they already agree on every field this plugin owns.
 */
export function routeMatches(declared, wanted) {
  if (declared === null || typeof declared !== 'object') return false
  if (declared.api !== wanted.api) return false
  if (declared.baseURL !== wanted.baseURL) return false
  if (declared.apiKeyEnv !== wanted.apiKeyEnv) return false
  const current = Array.isArray(declared.models) ? declared.models : null
  if (current === null) return false
  if (current.length !== wanted.models.length) return false
  const byId = new Map(current.map((entry) => [entry?.id, entry]))
  for (const model of wanted.models) {
    const existing = byId.get(model.id)
    if (existing === undefined) return false
    if ((existing.contextWindow ?? null) !== (model.contextWindow ?? null)) return false
  }
  return true
}

/**
 * Merge one route into a `llm-pi-ai` config without touching its siblings.
 *
 * The `providers` dictionary is shared with every other route the profile
 * declares, so the write must be a per-key merge rather than a replacement.
 *
 * @param current - the entry's current raw config.
 * @param routeKey - provider key to write.
 * @param route - the route declaration to write.
 * @returns a new config object.
 */
export function upsertRoute(current, routeKey, route) {
  const base = current !== null && typeof current === 'object' ? current : {}
  const providers = base.providers !== null && typeof base.providers === 'object' ? base.providers : {}
  return { ...base, providers: { ...providers, [routeKey]: route } }
}
