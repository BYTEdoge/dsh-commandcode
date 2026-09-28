import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Minimal React stand-in.
 *
 * The Client half only needs `createElement`, `useState`, `useSyncExternalStore`
 * and `useEffect`, so a real React install is unnecessary to prove that the
 * module loads, registers its slots, and renders the account data.
 */
function makeReact() {
  let cursor = 0
  const state = []
  return {
    reset() {
      cursor = 0
    },
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined) }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], (next) => { state[index] = next }]
    },
    useSyncExternalStore(_subscribe, get) {
      return get()
    },
    useEffect() {},
  }
}

/** Bumped per load: an ESM URL with a fresh query is a fresh module instance. */
let loadCount = 0

/**
 * Load `client.js` against a stubbed module table.
 *
 * The query suffix matters: the module body registers itself once at import
 * time, and a cached instance would not run it again for the next test.
 *
 * @returns the module the factory produced, plus the React stand-in.
 */
async function loadClientModule() {
  const react = makeReact()
  let captured
  globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
  loadCount += 1
  await import(`../client.js?case=${loadCount}`)
  assert.ok(captured, 'client.js must register itself with the module loader')
  assert.equal(captured.id, 'dsh-commandcode', 'the factory id must equal the package name')
  return { module: captured.factory((name) => (name === 'react' ? react : (() => { throw new Error(`unexpected require("${name}")`) }))), react }
}

/**
 * Build a plugin context that records slot registrations.
 * @returns the context, the registration log, and a disposer for its effects.
 */
function makeCtx() {
  const registrations = []
  const cleanups = []
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
    locale: {
      register() {},
      bind: () => (key) => key,
    },
    slots: {
      inject(_key, callback) {
        callback()
      },
      register(options, component) {
        registrations.push({ options, component })
      },
    },
  }
  return {
    ctx,
    registrations,
    dispose() {
      for (const cleanup of cleanups) cleanup()
    },
  }
}

/** Account snapshot shaped exactly like the Host half sends it. */
const SNAPSHOT = {
  plan: { planId: 'individual-goat', planLabel: 'Command Code · GOAT', status: 'active', currentPeriodEnd: '2026-10-17T12:47:21.000Z', cancelAtPeriodEnd: false },
  credits: { monthly: 61.48327073, purchased: 0, free: 0, total: 61.48327073, belowThreshold: false, creditThreshold: 0 },
  windows: [
    { key: 'fiveHour', used: 0.586188554, cap: 14, remaining: 13.413811446, remainingPercent: 95.8, exceeded: false, resetAt: null },
    { key: 'weekly', used: 2.085095061, cap: 35, remaining: 32.914904939, remainingPercent: 94, exceeded: false, resetAt: null },
  ],
  summary: { text: '94%', primaryRemainingPercent: 94 },
  fetchedAt: '2026-09-28T00:00:00.000Z',
}

/**
 * Walk an element tree, invoking function components, and collect all text.
 * @param node - element, array, or primitive.
 * @returns the concatenated visible text.
 */
function textOf(node) {
  if (node === null || node === undefined || node === true || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return `${node} `
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type({ ...node.props, children: node.children }))
  return (node.children ?? []).map(textOf).join('')
}

/**
 * Build the store the plugin injects, by running `apply` and reading it back.
 *
 * The polling effect is disposed immediately: these tests drive the store
 * directly, and a live warm-up timer would fire a real `fetch` after the test
 * ended.
 *
 * @returns the store, its translator, the registration log, and the fake React.
 */
async function storeFromApply() {
  const { module, react } = await loadClientModule()
  const { ctx, registrations, dispose } = makeCtx()
  module.apply(ctx)
  assert.equal(registrations.length, 2, 'the plugin registers exactly two slots')
  dispose()
  const injected = registrations[0].options.inject()
  return { store: injected.store, t: injected.t, registrations, react }
}

test('the Client half injects the services it needs', async () => {
  const { module } = await loadClientModule()
  assert.deepEqual(module.inject, ['slots', 'locale'])
  assert.equal(typeof module.apply, 'function')
})

test('apply registers the settings section and the sidebar chip', async () => {
  const { module } = await loadClientModule()
  const { ctx, registrations, dispose } = makeCtx()
  module.apply(ctx)

  const byName = new Map(registrations.map((entry) => [entry.options.name, entry]))
  assert.deepEqual([...byName.keys()].sort(), ['settings.section', 'sidebar.footer.action'])
  for (const entry of registrations) {
    assert.equal(entry.options.id, 'dsh-commandcode')
    assert.equal(typeof entry.component, 'function')
    assert.equal(typeof entry.options.label(), 'string')
  }
  assert.equal(byName.get('settings.section').options.order, 35)
  dispose()
})

test('apply arms and disarms its polling without leaking a timer', async () => {
  const { module } = await loadClientModule()
  const { ctx, dispose } = makeCtx()
  let cleared = 0
  const realClearTimeout = globalThis.clearTimeout
  const realClearInterval = globalThis.clearInterval
  // Count *and* really clear: an intercepted clear that skipped the real one
  // would leave the poll interval running and the test process alive.
  globalThis.clearTimeout = (id) => { cleared += 1; return realClearTimeout(id) }
  globalThis.clearInterval = (id) => { cleared += 1; return realClearInterval(id) }
  try {
    module.apply(ctx)
    dispose()
    assert.equal(cleared, 2, 'both the warm-up timeout and the poll interval are cleared')
  } finally {
    globalThis.clearTimeout = realClearTimeout
    globalThis.clearInterval = realClearInterval
  }
})

test('the panel renders the balance, the plan and both windows', async () => {
  const { store, t, registrations, react } = await storeFromApply()

  // Drive the panel from a loaded state, exactly as the Host response leaves it.
  const state = store.get()
  const patched = { ...state, snapshot: SNAPSHOT, key: { configured: true, writable: true }, route: { declared: true, routeKey: 'commandcode', modelCount: 73, baseURL: 'https://api.commandcode.ai/provider/v1', apiKeyRef: 'COMMANDCODE_API_KEY' }, loaded: true }

  const panel = registrations[0].component
  react.reset()
  const text = textOf(panel({ store: { subscribe: () => () => {}, get: () => patched }, t }))

  assert.match(text, /Command Code · GOAT/)
  assert.match(text, /\$61\.48/)
  // The stub translator echoes keys, so localized words appear as their key.
  assert.match(text, /96% remaining/)
  assert.match(text, /94% remaining/)
  assert.match(text, /73 models/)
  assert.match(text, /COMMANDCODE_API_KEY/)
  assert.match(text, /active/)
})

test('the panel explains an unconfigured key instead of showing a balance', async () => {
  const { t, registrations, react } = await storeFromApply()
  const panel = registrations[0].component
  react.reset()
  const text = textOf(
    panel({
      store: {
        subscribe: () => () => {},
        get: () => ({ loading: false, loaded: false, busy: null, error: null, notice: null, key: { configured: false, writable: true }, route: null, endpoints: null, snapshot: null, warnings: [] }),
      },
      t,
    }),
  )
  assert.match(text, /apiKeyUnset/)
  assert.match(text, /planUnknown/)
  assert.match(text, /never/)
})

test('the sidebar chip shows the summary text when the sidebar is wide', async () => {
  const { t, registrations, react } = await storeFromApply()
  const chip = registrations[1].component
  react.reset()
  const text = textOf(
    chip({
      store: {
        subscribe: () => () => {},
        get: () => ({ loading: false, loaded: true, busy: null, error: null, notice: null, key: { configured: true, writable: true }, route: null, endpoints: null, snapshot: SNAPSHOT, warnings: [] }),
      },
      t,
      wide: true,
    }),
  )
  assert.match(text, /94%/)
})
