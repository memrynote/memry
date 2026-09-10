import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const source = readFileSync(new URL('./CliWidget.tsx', import.meta.url), 'utf8')

describe('CliWidget session-replay noise', () => {
  it('auto-types into a non-recorded span, never into the input', () => {
    // rrweb records one input event per character when the demo drives the <input>,
    // which pinned every landing recording's activity_score to 100.
    const autoPlay = source.match(/const type = \(\) => {[\s\S]*?const takeOver/)?.[0] ?? ''
    assert.notEqual(autoPlay, '')
    assert.match(autoPlay, /setDemo\(cmd\.slice\(0, charRef\.current\)\)/)
    assert.doesNotMatch(autoPlay, /setInput\(/)
  })

  it('blocks the typing surface from the recorder with posthog default blockClass', () => {
    assert.match(source, /className="ph-no-capture[^"]*"[\s\S]*?>\s*{demo}/)
  })

  it('still binds the composer input to the user-owned value', () => {
    assert.match(source, /<input[\s\S]*?value={input}[\s\S]*?onChange={\(event\) => {/)
    assert.match(source, /aria-label="Type a memrynote command"/)
  })
})
