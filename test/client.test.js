import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CommandCodeError, FAILURE, discoverRouteModels, loadUsage, requestJson } from '../lib/commandcode-client.js'

const CREDITS_BODY = JSON.stringify({
  credits: { monthlyCredits: 10 },
  windowLimits: { fiveHour: { used: 1, cap: 14, resetAt: 1_790_580_173_758 } },
})

/**
 * Build a fetch stand-in that answers by URL substring.
 * @param routes - map of URL substring to `{ status, body }` or a function.
 * @returns a fetch implementation recording every call.
 */
function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const match = Object.keys(routes).find((key) => url.includes(key))
    if (match === undefined) throw new TypeError(`unexpected url ${url}`)
    const route = routes[match]
    const resolved = typeof route === 'function' ? await route(url, init) : route
    if (resolved instanceof Error) throw resolved
    return {
      ok: resolved.status >= 200 && resolved.status < 300,
      status: resolved.status,
      text: async () => resolved.body,
    }
  }
  impl.calls = calls
  return impl
}

test('requestJson refuses to call out without a credential', async () => {
  const fetchImpl = fakeFetch({})
  await assert.rejects(
    () => requestJson('https://api.commandcode.ai/x', { apiKey: '', fetchImpl }),
    (error) => error instanceof CommandCodeError && error.code === FAILURE.MISSING_KEY,
  )
  assert.equal(fetchImpl.calls.length, 0)
})

test('requestJson sends a bearer credential and parses JSON', async () => {
  const fetchImpl = fakeFetch({ '/credits': { status: 200, body: CREDITS_BODY } })
  const body = await requestJson('https://api.commandcode.ai/alpha/billing/credits', { apiKey: 'user_secret', fetchImpl })
  assert.equal(body.credits.monthlyCredits, 10)
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer user_secret')
  assert.equal(fetchImpl.calls[0].init.redirect, 'error')
})

test('a rejected credential surfaces as AUTH with the status', async () => {
  const fetchImpl = fakeFetch({ '/credits': { status: 401, body: 'unauthorized' } })
  await assert.rejects(
    () => requestJson('https://api.commandcode.ai/alpha/billing/credits', { apiKey: 'user_x', fetchImpl }),
    (error) => error.code === FAILURE.AUTH && error.status === 401 && !error.message.includes('user_x'),
  )
})

test('other HTTP failures keep their status', async () => {
  const fetchImpl = fakeFetch({ '/credits': { status: 503, body: 'busy' } })
  await assert.rejects(
    () => requestJson('https://api.commandcode.ai/alpha/billing/credits', { apiKey: 'user_x', fetchImpl }),
    (error) => error.code === FAILURE.HTTP && error.status === 503,
  )
})

test('a non-JSON body is reported as INVALID_JSON', async () => {
  const fetchImpl = fakeFetch({ '/credits': { status: 200, body: '<html>' } })
  await assert.rejects(
    () => requestJson('https://api.commandcode.ai/alpha/billing/credits', { apiKey: 'user_x', fetchImpl }),
    (error) => error.code === FAILURE.INVALID_JSON,
  )
})

test('a transport error is reported without the credential', async () => {
  const fetchImpl = fakeFetch({ '/credits': () => new TypeError('socket hang up') })
  await assert.rejects(
    () => requestJson('https://api.commandcode.ai/alpha/billing/credits', { apiKey: 'user_x', fetchImpl }),
    (error) => error.code === FAILURE.TRANSPORT && !error.message.includes('user_x'),
  )
})

test('a stalled request is cut off by the deadline', async () => {
  const fetchImpl = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  await assert.rejects(
    () => requestJson('https://api.commandcode.ai/alpha/billing/credits', { apiKey: 'user_x', fetchImpl, timeoutMs: 20 }),
    (error) => error.code === FAILURE.TIMEOUT,
  )
})

test('loadUsage keeps the balance when only the plan lookup fails', async () => {
  const fetchImpl = fakeFetch({
    '/alpha/billing/credits': { status: 200, body: CREDITS_BODY },
    '/alpha/billing/subscriptions': { status: 500, body: 'boom' },
  })
  const { snapshot, warnings } = await loadUsage({ apiKey: 'user_x', fetchImpl, now: 0 })
  assert.equal(snapshot.credits.total, 10)
  assert.equal(snapshot.plan, null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].message, /Plan lookup failed/)
})

test('loadUsage reports the plan when both endpoints answer', async () => {
  const fetchImpl = fakeFetch({
    '/alpha/billing/credits': { status: 200, body: CREDITS_BODY },
    '/alpha/billing/subscriptions': { status: 200, body: JSON.stringify({ data: { planId: 'individual-goat' } }) },
  })
  const { snapshot, warnings } = await loadUsage({ apiKey: 'user_x', fetchImpl, now: 0 })
  assert.equal(snapshot.plan.planLabel, 'Command Code · GOAT')
  assert.deepEqual(warnings, [])
})

test('discoverRouteModels filters the catalog down to the route protocol', async () => {
  const fetchImpl = fakeFetch({
    '/models': {
      status: 200,
      body: JSON.stringify({
        data: [
          { id: 'claude-opus-5', name: 'Claude Opus 5', context_length: 1_000_000, supported_endpoints: ['/messages'] },
          { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context_length: 1_000_000, supported_endpoints: ['/chat/completions'] },
        ],
      }),
    },
  })
  const result = await discoverRouteModels({ apiKey: 'user_x', fetchImpl })
  assert.equal(result.catalogSize, 2)
  assert.equal(result.skipped, 1)
  assert.deepEqual(result.models, [{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000 }])
})

test('the provider base URL is composed from the option', async () => {
  const fetchImpl = fakeFetch({ 'acme.test/provider/v1/models': { status: 200, body: '{"data":[]}' } })
  await discoverRouteModels({ apiKey: 'user_x', fetchImpl, providerBaseUrl: 'https://acme.test/provider/v1/' })
  assert.equal(fetchImpl.calls[0].url, 'https://acme.test/provider/v1/models')
})
