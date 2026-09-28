import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../index.js'
import { makeCtx, registeredTools } from './support/fake-context.js'

test('the Host half declares its services and name', () => {
  assert.equal(name, 'commandcode')
  assert.deepEqual(inject, ['credentials', 'webServer'])
})

test('apply registers both agent tools, with no Harness import', () => {
  const registrations = registeredTools(apply)

  assert.deepEqual(
    registrations.map((definition) => definition.name).sort(),
    ['commandcode_connect', 'commandcode_usage'],
  )

  for (const definition of registrations) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40, 'a tool description must teach the model when to call it')
    assert.deepEqual(definition.parameters, { type: 'object', properties: {} }, 'both tools take no arguments')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output?.render, 'function')
  }
})

test('the tool output schemas are plain JSON Schema the registry accepts', () => {
  for (const definition of registeredTools(apply)) {
    const schema = definition.output.schema
    assert.equal(schema.type, 'object')
    assert.equal(schema.additionalProperties, false)
    assert.ok(Array.isArray(schema.required), 'required must be the standard array form, not per-property flags')
    for (const key of schema.required) {
      assert.ok(key in schema.properties, `required key "${key}" must exist in properties`)
      assert.equal('required' in schema.properties[key], false, 'a property must not carry its own required flag')
    }
  }
})

test('apply registers the same-origin JSON route', () => {
  const { ctx, routes } = makeCtx()
  apply(ctx, {})

  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/commandcode/api')
  assert.equal(typeof routes[0].handler, 'function')
})

test('apply tolerates a profile with no credentials store and no config editor', () => {
  const { ctx } = makeCtx()
  assert.doesNotThrow(() => apply(ctx, {}))
})

test('the usage tool reports a missing credential instead of calling out', async () => {
  const usage = registeredTools(apply).find((definition) => definition.name === 'commandcode_usage')
  await assert.rejects(
    () => usage.execute(),
    (error) => error.code === 'MISSING_CREDENTIAL' && /COMMANDCODE_API_KEY/.test(error.message),
  )
})

test('the connect tool refuses to write without a config editor', async () => {
  const connect = registeredTools(apply).find((definition) => definition.name === 'commandcode_connect')
  await assert.rejects(() => connect.execute(), /no config editor/i)
})

test('the tool renderers produce a readable report', () => {
  const usage = registeredTools(apply).find((definition) => definition.name === 'commandcode_usage')
  const blocks = usage.output.render({}, {
    plan: 'Command Code · GOAT',
    status: 'active',
    summary: '94%',
    monthlyCredits: 61.48327073,
    purchasedCredits: 0,
    freeCredits: 0,
    availableCredits: 61.48327073,
    windows: [
      { label: 'Weekly', remainingPercent: 94, remaining: 32.91, cap: 35, exceeded: false, resetsAt: '', resetsIn: '3d 4h' },
    ],
    warnings: [],
    fetchedAt: '2026-09-28T00:00:00.000Z',
  })

  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /Command Code · GOAT \(active\)/)
  assert.match(blocks[0].text, /\$61\.48/)
  assert.match(blocks[0].text, /Weekly: 94% left \(\$32\.91 of \$35\.00, resets in 3d 4h\)/)
})

test('the connect renderer explains an idempotent no-op', () => {
  const connect = registeredTools(apply).find((definition) => definition.name === 'commandcode_connect')
  const [block] = connect.output.render({}, { changed: false, modelCount: 73, previousModelCount: 73, catalogSize: 82, skipped: 9 })
  assert.match(block.text, /already matches the catalog \(73 models\); nothing was written/)
})
