import { describe, expect, it } from 'vitest'

import manifest from '../registry-manifest.json'
import { createMemrySchema } from '../schema'
import { createServerBlockSpecs, createServerInlineSpecs } from '../server'

/**
 * FR-040 parity: the enumerated registry in spec.md is derived from the shared
 * schema, and a test must fail when a type exists in the registry but not in
 * the requirement.
 *
 * The requirement's list is checked in as `registry-manifest.json` so this test
 * compares two artefacts rather than a list against itself. Both directions are
 * asserted: a type the schema grew and the list does not name, and a name the
 * list carries that the schema no longer produces.
 *
 * The schema is built from the SERVER specs because those are the ones this
 * package can construct without React. The renderer hands `createMemrySchema`
 * its own block specs, but `key ≡ config.type` is enforced for both at
 * construction (`src/schema.ts:74-75`), so the node-name set is the same.
 */
describe('FR-040 registry parity', () => {
  const schema = createMemrySchema({
    blocks: createServerBlockSpecs(),
    inline: createServerInlineSpecs()
  })

  const actual = {
    blocks: Object.keys(schema.blockSchema).sort(),
    inline: Object.keys(schema.inlineContentSchema).sort(),
    styles: Object.keys(schema.styleSchema).sort()
  }

  const declared = {
    blocks: [...manifest.blocks].sort(),
    inline: [...manifest.inline].sort(),
    styles: [...manifest.styles].sort()
  }

  for (const group of ['blocks', 'inline', 'styles'] as const) {
    it(`${group}: the schema produces exactly the declared types`, () => {
      const missingFromManifest = actual[group].filter((t) => !declared[group].includes(t))
      const missingFromSchema = declared[group].filter((t) => !actual[group].includes(t))

      expect(
        missingFromManifest,
        `${group} present in the schema but absent from registry-manifest.json and spec.md FR-040`
      ).toEqual([])
      expect(
        missingFromSchema,
        `${group} named by registry-manifest.json but no longer produced by createMemrySchema`
      ).toEqual([])
      expect(actual[group]).toEqual(declared[group])
    })
  }

  it('the registry totals 36 types, as FR-040 states', () => {
    expect(actual.blocks.length + actual.inline.length + actual.styles.length).toBe(36)
  })
})
