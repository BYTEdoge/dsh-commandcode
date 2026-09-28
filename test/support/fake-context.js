/**
 * A Host context stand-in for testing the plugin's `apply` without a Harness.
 *
 * `get` answers `undefined` for every optional service, which is the
 * degradation path a profile without a credentials store or a config editor
 * takes, so the same object also covers the "nothing available" case.
 *
 * @module test/support/fake-context
 */

import assert from 'node:assert/strict'

/**
 * Build a context that records what the plugin registers.
 * @returns the context, the registered tools, the web routes, and the effects.
 */
export function makeCtx() {
  const registrations = []
  const routes = []
  const effects = []

  const toolCtx = {
    effect(fn) {
      const cleanup = fn()
      effects.push(cleanup)
      return () => {}
    },
    tools: {
      register(definition) {
        registrations.push(definition)
        return () => {}
      },
    },
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    get: () => undefined,
    effect(fn, label) {
      effects.push({ label, cleanup: fn() })
      return () => {}
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['tools'], 'the tools are the plugin\u2019s only optional dependency')
      callback(toolCtx)
    },
  }

  return { ctx, registrations, routes, effects }
}

/**
 * Run `apply` and return the tools it registered.
 * @param apply - the plugin's Host entry point.
 * @returns the registered tool definitions.
 */
export function registeredTools(apply) {
  const { ctx, registrations } = makeCtx()
  apply(ctx, {})
  return registrations
}
