/**
 * Host half of `dsh-commandcode`.
 *
 * Two jobs, deliberately kept apart:
 *
 * 1. **Connect.** CommandCode is an OpenAI-compatible gateway
 *    (`https://api.commandcode.ai/provider/v1`), so it reaches the model layer
 *    through `llm-pi-ai`'s `providers` dictionary rather than through a new
 *    adapter. This plugin owns exactly one key of that dictionary and writes it
 *    through `configEditor`, which is the sanctioned path for persisting a
 *    profile config and reconciling the Loader. The write is a per-key merge and
 *    a no-op when the declared route already matches, so it is safe to repeat.
 * 2. **Report.** The account endpoints are read-only, so the panel is served by
 *    one authenticated same-origin route under {@link API_PREFIX}. The browser
 *    calls it; the credential never leaves this process.
 *
 * The Client half owns every pixel; see `./client.js`.
 *
 * @module dsh-commandcode
 */

import { CommandCodeError, discoverRouteModels, loadUsage } from './lib/commandcode-client.js'
import {
  DEFAULT_ACCOUNT_BASE_URL,
  DEFAULT_API_KEY_REF,
  DEFAULT_PROVIDER_BASE_URL,
  DEFAULT_ROUTE_API,
  DEFAULT_ROUTE_KEY,
  formatCountdown,
  formatCredits,
  routeMatches,
  upsertRoute,
} from './lib/usage.js'

/** Loader entry id of this plugin's Host row. */
export const name = 'commandcode'

/** Required services. Anything else is read with `ctx.get` so a profile without it still loads. */
export const inject = ['credentials', 'webServer']

/** Same-origin JSON endpoint the Client half posts to. */
const API_PREFIX = '/commandcode/api'

/** The plugin whose `providers` dictionary owns the route. */
const LLM_ROUTE_PLUGIN = 'llm-pi-ai'

/** Largest request body accepted, so a mistyped client cannot buffer without bound. */
const MAX_BODY_BYTES = 256 * 1024

/** Name of the agent-facing tool that reports the same data as the panel. */
const TOOL_NAME = 'commandcode_usage'

/** Name of the agent-facing tool that (re)writes the model route. */
const CONNECT_TOOL_NAME = 'commandcode_connect'

/**
 * Resolve the plugin's raw row config into the settings this module reads.
 * The row config is not schema-validated (this plugin ships no `Config`), so
 * every field falls back to its documented default instead of throwing at load.
 * @param config - raw `config` from the Loader row.
 * @returns resolved settings.
 */
function readSettings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const text = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback)
  return {
    accountBaseUrl: text(raw.accountBaseUrl, DEFAULT_ACCOUNT_BASE_URL),
    providerBaseUrl: text(raw.providerBaseUrl, DEFAULT_PROVIDER_BASE_URL),
    routeKey: text(raw.routeKey, DEFAULT_ROUTE_KEY),
    apiKeyRef: text(raw.apiKeyRef, DEFAULT_API_KEY_REF),
    routeApi: text(raw.routeApi, DEFAULT_ROUTE_API),
    displayName: text(raw.displayName, 'CommandCode'),
    timeoutMs: typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? raw.timeoutMs : 20_000,
  }
}

/**
 * Write one JSON response.
 * @param res - node response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/**
 * Read and parse a bounded JSON request body.
 * @param req - node request.
 * @returns the parsed body, or `{}` when the body is empty.
 * @throws Error when the body is too large or not JSON.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * Host half entry point.
 * @param ctx - plugin context.
 * @param config - raw row config.
 */
export function apply(ctx, config) {
  const settings = readSettings(config)
  const logger = ctx.logger

  /** The credentials service, when this profile mounts one. */
  const credentials = () => ctx.get('credentials')

  /** The config editor, which is what can persist a route into the profile. */
  const configEditorOf = () => ctx.get('configEditor')

  /**
   * Read the API key for one operation.
   * The credentials store is authoritative; the environment is the documented
   * fallback so a key can be exported without being written to disk.
   * @returns the credential literal, or undefined when none is configured.
   */
  async function readApiKey() {
    const store = credentials()
    if (store !== undefined) {
      const hit = await store.resolve(settings.apiKeyRef)
      const value = hit?.value
      if (typeof value === 'string' && value.length > 0) return value
    }
    const ambient = process.env[settings.apiKeyRef]
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
  }

  /**
   * Describe the credential without reading its value.
   * @returns whether a key is configured and whether it can be written here.
   */
  async function describeKey() {
    const store = credentials()
    if (store === undefined) {
      const ambient = process.env[settings.apiKeyRef]
      return { configured: typeof ambient === 'string' && ambient.length > 0, writable: false }
    }
    try {
      const info = await store.describe(settings.apiKeyRef)
      return { configured: info?.configured === true, writable: info?.writable !== false }
    } catch {
      return { configured: false, writable: false }
    }
  }

  /**
   * Find the Loader entry whose config owns the route dictionary.
   * @returns the entry, or undefined when `llm-pi-ai` is not mounted uniquely.
   */
  function findRouteEntry() {
    const editor = configEditorOf()
    if (editor === undefined) return undefined
    return editor.entries().find((entry) => entry?.options?.name === LLM_ROUTE_PLUGIN || entry?.options?.id === LLM_ROUTE_PLUGIN)
  }

  /**
   * The route currently declared on that entry, if any.
   * @returns the declared route object, or undefined.
   */
  function declaredRoute() {
    const providers = findRouteEntry()?.options?.config?.providers
    if (providers === null || typeof providers !== 'object') return undefined
    const route = providers[settings.routeKey]
    return route !== null && typeof route === 'object' ? route : undefined
  }

  /**
   * Report whether the inference route is in place.
   * @returns a plain status object for the panel.
   */
  function routeStatus() {
    const entry = findRouteEntry()
    const route = declaredRoute()
    return {
      entryFound: entry !== undefined,
      editorAvailable: configEditorOf() !== undefined,
      entryId: entry?.options?.id ?? null,
      routeKey: settings.routeKey,
      declared: route !== undefined,
      modelCount: Array.isArray(route?.models) ? route.models.length : 0,
      baseURL: typeof route?.baseURL === 'string' ? route.baseURL : null,
      api: typeof route?.api === 'string' ? route.api : null,
      apiKeyRef: typeof route?.apiKeyEnv === 'string' ? route.apiKeyEnv : null,
    }
  }

  /**
   * Read the key, then load the account snapshot.
   * @returns the snapshot plus non-fatal warnings.
   * @throws CommandCodeError MISSING_CREDENTIAL when no key is configured.
   */
  async function readUsage() {
    const apiKey = await readApiKey()
    if (apiKey === undefined) {
      throw new CommandCodeError(
        `No CommandCode API key is configured. Store ${settings.apiKeyRef} to connect the plan.`,
        'MISSING_CREDENTIAL',
      )
    }
    return loadUsage({
      apiKey,
      accountBaseUrl: settings.accountBaseUrl,
      providerBaseUrl: settings.providerBaseUrl,
      timeoutMs: settings.timeoutMs,
    })
  }

  /**
   * Discover the catalog and write the route when it differs from what is declared.
   * @returns the counts describing what the account plan offers and what was written.
   */
  async function connectRoute() {
    const editor = configEditorOf()
    if (editor === undefined) {
      throw new Error('This deployment has no config editor, so the route must be declared by hand in cordis.patch.yml.')
    }
    const entry = findRouteEntry()
    if (entry === undefined) {
      throw new Error(`No single "${LLM_ROUTE_PLUGIN}" row is active, so there is no providers dictionary to write.`)
    }

    const apiKey = await readApiKey()
    if (apiKey === undefined) {
      throw new CommandCodeError(
        `No CommandCode API key is configured. Store ${settings.apiKeyRef} before refreshing the model route.`,
        'MISSING_CREDENTIAL',
      )
    }

    const discovered = await discoverRouteModels({
      apiKey,
      providerBaseUrl: settings.providerBaseUrl,
      timeoutMs: settings.timeoutMs,
    })

    const wanted = {
      displayName: settings.displayName,
      apiKeyEnv: settings.apiKeyRef,
      api: settings.routeApi,
      baseURL: settings.providerBaseUrl,
      models: discovered.models,
    }

    const before = declaredRoute()
    const beforeCount = Array.isArray(before?.models) ? before.models.length : 0

    // The Loader row is the authority: compare against what it resolved, not
    // against a copy, so a route edited elsewhere is respected.
    if (routeMatches(before, wanted)) {
      return {
        changed: false,
        catalogSize: discovered.catalogSize,
        skipped: discovered.skipped,
        modelCount: wanted.models.length,
        previousModelCount: beforeCount,
      }
    }

    await editor.edit(entry, (current) => upsertRoute(current, settings.routeKey, wanted))
    logger?.info?.(
      `commandcode: route "${settings.routeKey}" written with ${wanted.models.length} models (was ${beforeCount})`,
    )
    return {
      changed: true,
      catalogSize: discovered.catalogSize,
      skipped: discovered.skipped,
      modelCount: wanted.models.length,
      previousModelCount: beforeCount,
    }
  }

  /** Methods the Client half may call; also the whole surface of this plugin. */
  const methods = {
    /** Everything the panel needs that needs no network call. */
    async status() {
      const [key, route] = [await describeKey(), routeStatus()]
      return { key, route, endpoints: { accountBaseUrl: settings.accountBaseUrl, providerBaseUrl: settings.providerBaseUrl } }
    },

    /** The account balance and plan usage. */
    async usage() {
      const { snapshot, warnings } = await readUsage()
      return { snapshot, warnings }
    },

    /** Write the route from the live catalog. Idempotent. */
    connect() {
      return connectRoute()
    },

    /** Store the API key through the credentials service. */
    async setKey(args) {
      const store = credentials()
      if (store === undefined) throw new Error('This deployment has no credentials service.')
      const value = typeof args?.apiKey === 'string' ? args.apiKey.trim() : ''
      if (value.length === 0) throw new Error('The API key is empty.')
      await store.set(settings.apiKeyRef, value)
      return { key: await describeKey() }
    },

    /** Forget the stored API key. */
    async clearKey() {
      const store = credentials()
      if (store === undefined) throw new Error('This deployment has no credentials service.')
      await store.unset(settings.apiKeyRef)
      return { key: await describeKey() }
    },
  }

  // --- the same-origin JSON route -------------------------------------------

  /**
   * Apply the Host/Origin fence and browser authentication.
   * @param req - node request.
   * @param res - node response, written when the request is refused.
   * @returns true when the caller owns the response and must stop.
   */
  function refused(req, res) {
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.requestRejection !== 'function') return false
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (refused(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'Use POST.' } })
            return
          }

          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : undefined
          if (method === undefined || method.includes('/')) {
            sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown CommandCode method.' } })
            return
          }
          const handler = methods[method]
          if (typeof handler !== 'function') {
            sendJson(res, 404, {
              ok: false,
              error: { code: 'NOT_FOUND', message: `Unknown CommandCode method "${method}".` },
            })
            return
          }

          try {
            const args = await readJsonBody(req)
            sendJson(res, 200, { ok: true, value: await handler(args) })
          } catch (error) {
            const code = error instanceof CommandCodeError ? error.code : 'FAILED'
            logger?.warn?.(`commandcode: ${method} failed (${code}): ${error?.message ?? String(error)}`)
            sendJson(res, 200, { ok: false, error: { code, message: error?.message ?? String(error) } })
          }
        },
      }),
    `commandcode: POST ${API_PREFIX}/<method>`,
  )

  // --- the agent-facing tools ----------------------------------------------

  // These definitions import nothing from a Harness package on purpose. A
  // locally installed bundle is linked into the profile, so Node resolves the
  // bundle's bare specifiers from the bundle's own directory — where
  // `@deepseek-ai/*` does not exist — and a native `import()` there fails. The
  // tools registry accepts plain JSON Schema, which is exactly the finished
  // shape its own `defineTool` helper produces, so the definitions below are
  // written directly in that shape and need no import at all.
  const definitions = [
    {
      name: TOOL_NAME,
      description:
        'Read the CommandCode account balance and plan usage: credit buckets and the five-hour and weekly rate-limit windows with their reset countdowns. Call this when the user asks about their CommandCode quota, balance, or remaining usage.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'plan',
            'status',
            'summary',
            'monthlyCredits',
            'purchasedCredits',
            'freeCredits',
            'availableCredits',
            'windows',
            'warnings',
            'fetchedAt',
          ],
          properties: {
            plan: { type: 'string', description: 'Plan display label.' },
            status: { type: 'string', description: 'Subscription status, or "unknown".' },
            summary: { type: 'string', description: 'One-line usage summary.' },
            monthlyCredits: { type: 'number' },
            purchasedCredits: { type: 'number' },
            freeCredits: { type: 'number' },
            availableCredits: { type: 'number' },
            windows: {
              type: 'array',
              description: 'Rate-limit windows, loosest budget last.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'remainingPercent', 'remaining', 'cap', 'exceeded', 'resetsAt', 'resetsIn'],
                properties: {
                  label: { type: 'string' },
                  remainingPercent: { type: 'number' },
                  remaining: { type: 'number' },
                  cap: { type: 'number' },
                  exceeded: { type: 'boolean' },
                  resetsAt: { type: 'string', description: 'ISO reset time, or "" when unknown.' },
                  resetsIn: { type: 'string', description: 'Countdown, or "-" when unknown.' },
                },
              },
            },
            warnings: { type: 'array', items: { type: 'string' } },
            fetchedAt: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderUsageText(value) }],
      },
      async execute() {
        const { snapshot, warnings } = await readUsage()
        return {
          plan: snapshot.plan?.planLabel ?? 'Command Code',
          status: snapshot.plan?.status ?? 'unknown',
          summary: snapshot.summary.text,
          monthlyCredits: snapshot.credits.monthly,
          purchasedCredits: snapshot.credits.purchased,
          freeCredits: snapshot.credits.free,
          availableCredits: snapshot.credits.total,
          windows: snapshot.windows.map((window) => ({
            label: window.key === 'fiveHour' ? '5 hours' : 'Weekly',
            remainingPercent: Number(window.remainingPercent.toFixed(1)),
            remaining: Number(window.remaining.toFixed(2)),
            cap: window.cap,
            exceeded: window.exceeded,
            resetsAt: window.resetAt ?? '',
            resetsIn: formatCountdown(window.resetAt, Date.parse(snapshot.fetchedAt)),
          })),
          warnings: warnings.map((warning) => warning.message),
          fetchedAt: snapshot.fetchedAt,
        }
      },
    },
    {
      name: CONNECT_TOOL_NAME,
      description:
        'Connect or refresh the CommandCode model route: read the live model catalog and write the OpenAI-compatible llm-pi-ai route so its models appear in the model picker. Idempotent — reports that nothing was written when the declared route already matches. Call this when CommandCode models are missing from the picker or the user asks to connect or refresh them. It needs an API key to be stored first; it never accepts or returns the key itself.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['changed', 'modelCount', 'previousModelCount', 'catalogSize', 'skipped'],
          properties: {
            changed: { type: 'boolean', description: 'Whether a write happened.' },
            modelCount: { type: 'number', description: 'Models now declared on the route.' },
            previousModelCount: { type: 'number', description: 'Models declared before the write.' },
            catalogSize: { type: 'number', description: 'Entries the catalog returned.' },
            skipped: { type: 'number', description: 'Catalog entries not served over /chat/completions.' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.changed
              ? `CommandCode route written: ${value.modelCount} models (was ${value.previousModelCount}); ${value.skipped} of ${value.catalogSize} catalog entries skipped because they do not serve /chat/completions.`
              : `CommandCode route already matches the catalog (${value.modelCount} models); nothing was written.`,
          },
        ],
      },
      execute: () => connectRoute(),
    },
  ]

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      const disposers = definitions.map((definition) => toolCtx.tools.register(definition))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'commandcode: usage and connect tools')
  })
}

/**
 * Render the usage tool result as the text block the conversation shows.
 * @param value - the tool's return value.
 * @returns a multi-line report.
 */
function renderUsageText(value) {
  const lines = [
    `CommandCode · ${value.plan} (${value.status})`,
    `Available ${formatCredits(value.availableCredits)} — monthly ${formatCredits(value.monthlyCredits)}, purchased ${formatCredits(value.purchasedCredits)}, granted ${formatCredits(value.freeCredits)}`,
    `Summary ${value.summary}`,
  ]
  for (const window of value.windows) {
    const reset = window.resetsIn === '-' ? '' : `, resets in ${window.resetsIn}`
    lines.push(`  ${window.label}: ${window.remainingPercent}% left (${formatCredits(window.remaining)} of ${formatCredits(window.cap)}${reset})`)
  }
  for (const warning of value.warnings) lines.push(`  warning: ${warning}`)
  return lines.join('\n')
}
