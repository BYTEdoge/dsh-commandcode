/**
 * HTTP access to the CommandCode account and model endpoints.
 *
 * Every function here is transport-only: it fetches, validates that the body is
 * JSON, and shapes the outcome into a stable error code. Shaping account data
 * into the UI snapshot lives in `./usage.js`.
 *
 * @module dsh-commandcode/client
 */

import {
  DEFAULT_ACCOUNT_BASE_URL,
  DEFAULT_PROVIDER_BASE_URL,
  buildSnapshot,
  chatCompletionModels,
  routeModels,
} from './usage.js'

/** Stable failure codes callers switch on instead of parsing messages. */
export const FAILURE = {
  MISSING_KEY: 'MISSING_CREDENTIAL',
  AUTH: 'AUTH',
  TIMEOUT: 'TIMEOUT',
  TRANSPORT: 'TRANSPORT',
  INVALID_JSON: 'INVALID_JSON',
  HTTP: 'HTTP',
}

/** Failure carrying a stable `code`, the HTTP status when there was one, and no key material. */
export class CommandCodeError extends Error {
  /**
   * @param message - operator-facing message; never includes the credential.
   * @param code - one of {@link FAILURE}.
   * @param status - HTTP status when the failure came from a response.
   */
  constructor(message, code, status = undefined) {
    super(message)
    this.name = 'CommandCodeError'
    this.code = code
    this.status = status
  }
}

/**
 * Turn a non-2xx response into a stable failure.
 * @param status - HTTP status.
 * @param body - response text, used only for a short excerpt.
 * @returns the failure to throw.
 */
function httpFailure(status, body) {
  if (status === 401 || status === 403) {
    return new CommandCodeError(
      `CommandCode rejected the API key (HTTP ${status}). Check the stored credential.`,
      FAILURE.AUTH,
      status,
    )
  }
  const excerpt = typeof body === 'string' && body.length > 0 ? `: ${body.slice(0, 200)}` : ''
  return new CommandCodeError(`CommandCode request failed with HTTP ${status}${excerpt}`, FAILURE.HTTP, status)
}

/**
 * GET one JSON document with a bearer credential and a hard deadline.
 * @param url - absolute URL.
 * @param options - credential, fetch implementation, deadline, and caller signal.
 * @returns the parsed JSON body.
 * @throws CommandCodeError with a stable code.
 */
export async function requestJson(url, options) {
  const apiKey = options.apiKey
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new CommandCodeError('No CommandCode API key is configured.', FAILURE.MISSING_KEY)
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new CommandCodeError('This runtime has no fetch implementation.', FAILURE.TRANSPORT)
  }

  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 20_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const callerSignal = options.signal
  const onAbort = () => controller.abort()
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener('abort', onAbort, { once: true })
  }

  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
  } catch (error) {
    if (callerSignal?.aborted) throw error
    if (error?.name === 'AbortError') {
      throw new CommandCodeError(`CommandCode request timed out after ${timeoutMs} ms.`, FAILURE.TIMEOUT)
    }
    throw new CommandCodeError(`CommandCode request could not be sent: ${error?.message ?? String(error)}`, FAILURE.TRANSPORT)
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onAbort)
  }

  const text = await response.text()
  if (!response.ok) throw httpFailure(response.status, text)

  try {
    return JSON.parse(text)
  } catch {
    throw new CommandCodeError('CommandCode returned a body that is not valid JSON.', FAILURE.INVALID_JSON)
  }
}

/**
 * Read the credit buckets and rate-limit windows.
 * @param options - credential, account base URL, fetch implementation, deadline.
 * @returns the parsed credits payload.
 */
export function fetchCredits(options) {
  const base = (options.accountBaseUrl ?? DEFAULT_ACCOUNT_BASE_URL).replace(/\/+$/, '')
  return requestJson(`${base}/alpha/billing/credits`, options)
}

/**
 * Read the current subscription. Soft-fail by design: an error here costs the
 * plan label only, never the balance.
 * @param options - credential, account base URL, fetch implementation, deadline.
 * @returns the parsed subscriptions payload.
 */
export function fetchSubscription(options) {
  const base = (options.accountBaseUrl ?? DEFAULT_ACCOUNT_BASE_URL).replace(/\/+$/, '')
  return requestJson(`${base}/alpha/billing/subscriptions`, options)
}

/**
 * Read the model catalog the inference route serves.
 * @param options - credential, provider base URL, fetch implementation, deadline.
 * @returns the parsed catalog payload.
 */
export function fetchModelCatalog(options) {
  const base = (options.providerBaseUrl ?? DEFAULT_PROVIDER_BASE_URL).replace(/\/+$/, '')
  return requestJson(`${base}/models`, options)
}

/**
 * Load everything the account panel shows in one pass.
 *
 * A subscription failure is reported as a warning and leaves `plan: null`; only
 * a credits failure is fatal, because it is the balance itself.
 *
 * @param options - credential, endpoints, fetch implementation, deadline, clock.
 * @returns the account snapshot plus non-fatal warnings.
 */
export async function loadUsage(options) {
  const credits = await fetchCredits(options)

  let subscription = null
  const warnings = []
  try {
    subscription = await fetchSubscription(options)
  } catch (error) {
    warnings.push({ code: error?.code ?? FAILURE.TRANSPORT, message: `Plan lookup failed: ${error?.message ?? String(error)}` })
  }

  return { snapshot: buildSnapshot({ credits, subscription, now: options.now }), warnings }
}

/**
 * Discover the models that can be declared on the OpenAI-compatible route.
 * @param options - credential, provider base URL, fetch implementation, deadline.
 * @returns route-ready model entries and the raw catalog size.
 */
export async function discoverRouteModels(options) {
  const catalog = await fetchModelCatalog(options)
  const all = Array.isArray(catalog?.data) ? catalog.data : Array.isArray(catalog?.models) ? catalog.models : []
  const usable = chatCompletionModels(all)
  return { models: routeModels(usable), catalogSize: all.length, skipped: all.length - usable.length }
}
