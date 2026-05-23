import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const source = readFileSync(new URL('./VideoScene.tsx', import.meta.url), 'utf8')

describe('VideoScene expanded playback', () => {
  it('keeps the fullscreen video interactive and prevents inline transfer pauses from pausing the demo', () => {
    assert.match(
      source,
      /const handleInlinePause = \(\) => {[\s\S]*if \(!expanded\) {[\s\S]*onPlaybackChange\?\.\(false\)[\s\S]*}/
    )
    assert.match(source, /const handleModalPause = \(\) => {[\s\S]*onPlaybackChange\?\.\(false\)/)
    assert.match(
      source,
      /<video[\s\S]*ref={modalVideoRef}[\s\S]*controls[\s\S]*onPlay={handleModalPlay}[\s\S]*onPause={handleModalPause}/
    )

    const modalVideoBlock = source.match(/<video[\s\S]*?ref={modalVideoRef}[\s\S]*?\/>/)?.[0] ?? ''
    assert.doesNotMatch(modalVideoBlock, /pointer-events-none/)
  })

  it('provides an app-level seek target for the fullscreen player', () => {
    assert.match(source, /const seekModalFromPointer = \(event: PointerEvent<HTMLDivElement>\)/)
    assert.match(
      source,
      /video\.currentTime = nextTime[\s\S]*videoRef\.current\.currentTime = nextTime/
    )
    assert.match(source, /onProgressChange\?\.\(nextProgress\)/)
    assert.match(
      source,
      /aria-hidden="true"[\s\S]*onPointerDown={handleModalSeekPointerDown}[\s\S]*onPointerMove={handleModalSeekPointerMove}[\s\S]*bg-transparent/
    )
    assert.doesNotMatch(source, /modalProgress/)
    assert.doesNotMatch(source, /Jump fullscreen demo video/)
  })

  it('does not reset native fullscreen seeks from stale inline time', () => {
    assert.match(
      source,
      /const syncInlineTimeFromModal = \(modalVideo: HTMLVideoElement\) => {[\s\S]*inlineVideo\.currentTime = modalVideo\.currentTime/
    )
    assert.match(
      source,
      /if \(video === modalVideoRef\.current\) {[\s\S]*syncInlineTimeFromModal\(video\)[\s\S]*}/
    )
    assert.match(
      source,
      /modalVideo\.currentTime = inlineVideo\.currentTime[\s\S]*}, \[expanded, src\]\)/
    )
    assert.match(
      source,
      /if \(playing\) {[\s\S]*modalVideo\.play\(\)\.catch\(\(\) => {}\)[\s\S]*}, \[expanded, playing\]\)/
    )
    assert.doesNotMatch(source, /\}, \[expanded, playing, src\]\)/)
  })
})
