/**
 * Cross-check the hand-written tool definitions against the installed
 * `@deepseek-ai/dsh-tools` registry helpers.
 *
 * The plugin deliberately imports nothing from a Harness package, so the two
 * tool definitions are hand-written. This test feeds them to the very
 * validators the registry would run, which is the only way to catch a typo in
 * a schema that no local test would otherwise notice.
 *
 * It needs the real installation, so it is skipped unless `DSH_TOOLS_PATH`
 * points at `@deepseek-ai/dsh-tools/lib/index.js`:
 *
 *   $env:DSH_TOOLS_PATH = 'C:\...\app\node_modules\@deepseek-ai\dsh-tools\lib\index.js'
 *   node --test
 *
 * @module test/dsh-schema
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { apply } from '../index.js'
import { registeredTools } from './support/fake-context.js'

const toolsPath = process.env.DSH_TOOLS_PATH
const available = typeof toolsPath === 'string' && toolsPath.length > 0 && existsSync(toolsPath)
const skip = available ? false : 'set DSH_TOOLS_PATH to the installed @deepseek-ai/dsh-tools/lib/index.js'

test('the registered tool schemas satisfy the real registry validators', { skip }, async () => {
  const dshTools = await import(pathToFileURL(toolsPath).href)

  for (const definition of registeredTools(apply)) {
    assert.doesNotThrow(
      () => dshTools.assertObjectJsonSchema(definition.parameters),
      `${definition.name}: parameters must be an object JSON Schema`,
    )
    assert.doesNotThrow(
      () => dshTools.assertSupportedJsonSchema(definition.output.schema),
      `${definition.name}: the output schema must use only supported keywords`,
    )
  }
})

test('the hand-written argument schema matches what defineTool produces for no arguments', { skip }, async () => {
  const dshTools = await import(pathToFileURL(toolsPath).href)

  // `defineTool` accepts a compact spec, not finished JSON Schema, so the only
  // faithful equivalence to assert is between what it produces and what the
  // plugin hand-wrote for the identical (empty) argument list.
  //
  // The probe's own output schema must declare `additionalProperties`
  // explicitly: the registry rejects an object schema that leaves it implied.
  const built = dshTools.defineTool({
    name: 'probe',
    description: 'probe',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
    execute: () => ({}),
  })

  for (const definition of registeredTools(apply)) {
    assert.deepEqual(
      definition.parameters,
      built.parameters,
      `${definition.name}: no-argument parameters must equal defineTool's empty-argument schema`,
    )
  }

  assert.deepEqual(
    registeredTools(apply)
      .map((definition) => definition.name)
      .sort(),
    ['commandcode_connect', 'commandcode_usage'],
  )
})
