import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const source = readFileSync(new URL('./FounderStory.tsx', import.meta.url), 'utf8')

describe('FounderStory section', () => {
  it('uses the founder photo instead of the placeholder initial avatar', () => {
    assert.match(source, /from '..\/..\/assets\/kaan-founder\.webp'/)
    assert.doesNotMatch(source, /from '..\/..\/..\/kaan\.jpg'/)
    assert.match(source, /alt="Kaan, founder of memrynote"/)
    assert.match(source, /Yep, that's me\. Duck on shoulder\./)
    assert.match(source, /aspect-\[3\/4\]/)
    assert.match(source, /object-cover/)
    assert.match(source, /Hi, I'm Kaan, the developer behind memrynote/)
    assert.match(source, /local-first, privacy by design/)
    assert.match(source, /no\s+plugin maze and no\s+cloud lock-in/)
    assert.match(source, /Follow me on 𝕏/)
    assert.doesNotMatch(source, /border-dashed/)
    assert.doesNotMatch(source, />K<\/span>/)
  })
})
