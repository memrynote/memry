import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ringCss from './mind-map-canvas.css?raw'

// The ring's fade is `fill-mode: forwards` ending on `opacity: 0`, and base.css cuts every
// animation to 0.01ms under the app's Reduce motion setting, so only a rule that drops the
// animation keeps the mark. jsdom resolves a stylesheet's declarations for the element.
describe('mind map focus ring under Reduce motion', () => {
  let style: HTMLStyleElement
  let ring: HTMLElement

  beforeEach(() => {
    style = document.createElement('style')
    style.textContent = ringCss
    document.head.append(style)
    ring = document.createElement('div')
    ring.className = 'mind-map-focus-ring'
    document.body.append(ring)
  })

  afterEach(() => {
    style.remove()
    ring.remove()
    document.documentElement.removeAttribute('data-reduce-motion')
  })

  it('fades out by default', () => {
    expect(getComputedStyle(ring).animationName).toBe('mind-map-focus-flash')
  })

  it('stays visible, without the fade, when the app reduces motion', () => {
    document.documentElement.setAttribute('data-reduce-motion', 'on')

    const computed = getComputedStyle(ring)

    expect(computed.animationName).toBe('none')
    expect(computed.opacity).toBe('1')
  })
})
