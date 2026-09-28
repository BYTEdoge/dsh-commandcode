import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSnapshot,
  chatCompletionModels,
  formatCountdown,
  formatCredits,
  humanizePlanId,
  normalizeCredits,
  normalizeSubscription,
  remainingPercent,
  routeMatches,
  routeModels,
  summarize,
  upsertRoute,
} from '../lib/usage.js'

/** Captured live response of `GET /alpha/billing/credits` (GOAT plan). */
const CREDITS = {
  credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 61.48327073, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0.586188554, cap: 14, exceeded: false, resetAt: 1790580173758 },
    weekly: { used: 2.085095061, cap: 35, exceeded: false, resetAt: 1790945896672 },
  },
  sandboxAccess: false,
  sandboxMinutes: null,
}

/** Captured live response of `GET /alpha/billing/subscriptions`. */
const SUBSCRIPTION = {
  success: true,
  data: {
    id: 'sub_example',
    status: 'active',
    planId: 'individual-goat',
    cancelAtPeriodEnd: false,
    currentPeriodStart: '2026-09-17T12:47:21.000Z',
    currentPeriodEnd: '2026-10-17T12:47:21.000Z',
  },
}

test('humanizePlanId maps known plans and title-cases unknown ones', () => {
  assert.equal(humanizePlanId('individual-goat'), 'Command Code · GOAT')
  assert.equal(humanizePlanId('team-pro'), 'Command Code · Team Pro')
  assert.equal(humanizePlanId('individual-max-20x'), 'Command Code · Max 20x')
  assert.equal(humanizePlanId('individual-ultra-plan'), 'Command Code · Ultra Plan')
  assert.equal(humanizePlanId(undefined), 'Command Code')
  assert.equal(humanizePlanId(''), 'Command Code')
})

test('remainingPercent clamps and treats a non-positive cap as unlimited', () => {
  assert.equal(remainingPercent(0.586188554, 14), (14 - 0.586188554) / 14 * 100)
  assert.equal(remainingPercent(20, 10), 0)
  assert.equal(remainingPercent(-5, 10), 100)
  assert.equal(remainingPercent(5, 0), 100)
  assert.equal(remainingPercent(undefined, undefined), 100)
})

test('formatCredits always shows two decimals', () => {
  assert.equal(formatCredits(61.48327073), '$61.48')
  assert.equal(formatCredits(0), '$0.00')
  assert.equal(formatCredits(undefined), '$0.00')
})

test('formatCountdown renders days, hours and minutes', () => {
  const now = Date.UTC(2026, 8, 28, 0, 0, 0)
  assert.equal(formatCountdown(now + 3 * 86400_000 + 4 * 3600_000, now), '3d 4h')
  assert.equal(formatCountdown(now + 4 * 3600_000 + 12 * 60_000, now), '4h 12m')
  assert.equal(formatCountdown(now + 12 * 60_000, now), '12m')
  assert.equal(formatCountdown(now - 1000, now), '-')
  assert.equal(formatCountdown(null, now), '-')
})

test('normalizeCredits reads both credit buckets and both windows', () => {
  const snapshot = normalizeCredits(CREDITS)
  assert.equal(snapshot.credits.monthly, 61.48327073)
  assert.equal(snapshot.credits.purchased, 0)
  assert.equal(snapshot.credits.free, 0)
  assert.equal(snapshot.credits.total, 61.48327073)
  assert.equal(snapshot.limited, true)
  assert.equal(snapshot.windows.length, 2)

  const [fiveHour, weekly] = snapshot.windows
  assert.equal(fiveHour.key, 'fiveHour')
  assert.equal(fiveHour.cap, 14)
  assert.equal(fiveHour.remaining, 14 - 0.586188554)
  assert.equal(fiveHour.resetAt, new Date(1790580173758).toISOString())
  assert.equal(weekly.key, 'weekly')
  assert.equal(weekly.cap, 35)
})

test('normalizeCredits tolerates a payload with no windows at all', () => {
  const snapshot = normalizeCredits({ credits: { monthlyCredits: 12 } })
  assert.deepEqual(snapshot.windows, [])
  assert.equal(snapshot.credits.total, 12)
})

test('normalizeCredits survives hostile input', () => {
  const snapshot = normalizeCredits({ credits: { monthlyCredits: 'lots' }, windowLimits: { fiveHour: 7 } })
  assert.equal(snapshot.credits.monthly, 0)
  assert.deepEqual(snapshot.windows, [])
  assert.equal(normalizeCredits(null).credits.total, 0)
  assert.equal(normalizeCredits('nope').credits.total, 0)
})

test('normalizeSubscription reports the plan and degrades to null', () => {
  assert.deepEqual(normalizeSubscription(SUBSCRIPTION), {
    planId: 'individual-goat',
    planLabel: 'Command Code · GOAT',
    status: 'active',
    currentPeriodEnd: '2026-10-17T12:47:21.000Z',
    cancelAtPeriodEnd: false,
  })
  assert.equal(normalizeSubscription({ data: {} }).planLabel, 'Command Code')
  assert.equal(normalizeSubscription(null), null)
  assert.equal(normalizeSubscription({}), null)
})

test('buildSnapshot composes credits, plan and summary', () => {
  const snapshot = buildSnapshot({ credits: CREDITS, subscription: SUBSCRIPTION, now: 1_790_000_000_000 })
  assert.equal(snapshot.plan.planLabel, 'Command Code · GOAT')
  assert.equal(snapshot.fetchedAt, new Date(1_790_000_000_000).toISOString())
  assert.equal(snapshot.summary.text, '94%')
  assert.equal(Math.round(snapshot.summary.primaryRemainingPercent), 94)
})

test('summarize falls back to the balance when there are no windows', () => {
  const snapshot = buildSnapshot({ credits: { credits: { monthlyCredits: 4.5, purchasedCredits: 1.25 } }, now: 0 })
  assert.equal(snapshot.summary.text, '$5.75')
  assert.equal(snapshot.summary.primaryRemainingPercent, null)
})

test('summarize surfaces the five-hour window only when it is the tighter one', () => {
  const throttled = buildSnapshot({
    credits: {
      credits: { monthlyCredits: 10 },
      windowLimits: {
        fiveHour: { used: 7, cap: 14, resetAt: 1_790_580_173_758 },
        weekly: { used: 2, cap: 35, resetAt: 1_790_945_896_672 },
      },
    },
    now: 0,
  })
  assert.equal(throttled.summary.text, '94% (50%)')
})

test('summarize omits a five-hour window that is looser than the week', () => {
  const relaxed = buildSnapshot({
    credits: {
      credits: { monthlyCredits: 10 },
      windowLimits: {
        fiveHour: { used: 0.5, cap: 14, resetAt: 1_790_580_173_758 },
        weekly: { used: 2, cap: 35, resetAt: 1_790_945_896_672 },
      },
    },
    now: 0,
  })
  assert.equal(relaxed.summary.text, '94%')
  assert.equal(Math.round(relaxed.summary.primaryRemainingPercent), 94)
})

test('chatCompletionModels drops models that only serve /messages', () => {
  const catalog = [
    { id: 'claude-opus-5', supported_endpoints: ['/messages'] },
    { id: 'deepseek/deepseek-v4.1-flash', supported_endpoints: ['/chat/completions', '/responses'] },
    { id: 'gpt-5.4-mini', supported_endpoints: ['/chat/completions'] },
    { id: 'mystery', supported_endpoints: [] },
  ]
  assert.deepEqual(
    chatCompletionModels(catalog).map((model) => model.id),
    ['deepseek/deepseek-v4.1-flash', 'gpt-5.4-mini', 'mystery'],
  )
  assert.deepEqual(chatCompletionModels(undefined), [])
})

test('routeModels keeps id, display name and context window', () => {
  assert.deepEqual(
    routeModels([{ id: 'a/b', name: 'A B', context_length: 1_000_000 }, { id: 'c', context_length: 0 }]),
    [{ id: 'a/b', name: 'A B', contextWindow: 1_000_000 }, { id: 'c', name: 'c' }],
  )
})

test('routeMatches ignores differences this plugin does not own', () => {
  const wanted = { api: 'openai-completions', baseURL: 'https://x/provider/v1', apiKeyEnv: 'COMMANDCODE_API_KEY', models: [{ id: 'a', name: 'A', contextWindow: 10 }] }
  assert.equal(routeMatches({ ...wanted, displayName: 'Anything', retryPolicy: { mode: 'normal' } }, wanted), true)
  assert.equal(routeMatches({ ...wanted, models: [{ id: 'a', name: 'Renamed', contextWindow: 10 }] }, wanted), true)
  assert.equal(routeMatches({ ...wanted, models: [{ id: 'a', contextWindow: 10 }, { id: 'b' }] }, wanted), false)
  assert.equal(routeMatches({ ...wanted, models: [{ id: 'a', contextWindow: 11 }] }, wanted), false)
  assert.equal(routeMatches({ ...wanted, baseURL: 'https://y/v1' }, wanted), false)
  assert.equal(routeMatches(null, wanted), false)
  assert.equal(routeMatches({ ...wanted, models: undefined }, wanted), false)
})

test('upsertRoute merges one route and leaves every sibling intact', () => {
  const current = {
    providers: { other: { api: 'openai-completions', baseURL: 'https://other/v1' } },
    someSharedField: true,
  }
  const next = upsertRoute(current, 'commandcode', { api: 'openai-completions', baseURL: 'https://cc/v1', models: [] })

  assert.equal(next.someSharedField, true)
  assert.deepEqual(next.providers.other, current.providers.other)
  assert.equal(next.providers.commandcode.baseURL, 'https://cc/v1')
  assert.deepEqual(current.providers, { other: current.providers.other })
})

test('upsertRoute builds a config from nothing', () => {
  const next = upsertRoute(undefined, 'commandcode', { models: [] })
  assert.deepEqual(next, { providers: { commandcode: { models: [] } } })
})
