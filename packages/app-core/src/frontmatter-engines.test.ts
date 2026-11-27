import assert from 'node:assert/strict'
import test from 'node:test'

import matter from 'gray-matter'

// Vault files written by someone else reach gray-matter, which picks its engine
// from the text after the opening `---`. patches/gray-matter@4.0.3.patch makes
// the `javascript` engine refuse, so that text is never run.
const probe = globalThis as { __frontmatterProbe?: number }

for (const opener of ['---js', '--- javascript', '---JS', '---Javascript ']) {
  test(`gray-matter refuses ${JSON.stringify(opener)} frontmatter without running it`, () => {
    delete probe.__frontmatterProbe
    const raw = `${opener}\n(globalThis.__frontmatterProbe = 1, { title: 'x' })\n---\nbody`

    assert.throws(() => matter(raw), /frontmatter language "javascript" is not supported/)
    assert.throws(() => matter(raw, {}), /frontmatter language "javascript" is not supported/)
    assert.equal(probe.__frontmatterProbe, undefined)
  })
}

test('gray-matter still parses YAML frontmatter', () => {
  assert.deepEqual(matter('---\ntitle: x\n---\nbody', {}).data, { title: 'x' })
})
