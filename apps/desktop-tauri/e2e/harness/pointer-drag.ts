// dnd-kit's PointerSensor drags, sent as in-page pointer events. The WebDriver pointer actions of
// the Tauri driver reach WKWebView as mouse events only, with `buttons` 0 on every move, so a
// PointerSensor never activates (seen on the app rail and the sidebar sections, #3547 30h).
// Each event goes to the element under the point and bubbles to the document, where dnd-kit
// listens once the press is down.
import type { Page } from './pw-compat/page'

export interface Point {
  x: number
  y: number
}

type Phase = 'pointerdown' | 'pointermove' | 'pointerup'

function send(page: Page, phase: Phase, at: Point): Promise<void> {
  return page.evaluate(
    ({ type, x, y }: { type: Phase; x: number; y: number }) => {
      const target = document.elementFromPoint(x, y) ?? document.body
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: type === 'pointermove' ? -1 : 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: x,
          clientY: y
        })
      )
    },
    { type: phase, ...at }
  )
}

/** A pointer drag that stays pressed between calls: `press`, any number of `glide`s, `release`. */
export class PointerDrag {
  private at: Point

  private constructor(
    private readonly page: Page,
    start: Point
  ) {
    this.at = start
  }

  static async press(page: Page, start: Point): Promise<PointerDrag> {
    await send(page, 'pointerdown', start)
    return new PointerDrag(page, start)
  }

  /** Moves to `to` in `steps` moves, as Playwright's `mouse.move(x, y, { steps })`. */
  async glide(to: Point, steps: number): Promise<void> {
    const from = this.at
    for (let step = 1; step <= steps; step++) {
      const t = step / steps
      await send(this.page, 'pointermove', {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t
      })
      // One frame per move, so dnd-kit measures between moves as it does for a real pointer.
      await this.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    }
    this.at = to
  }

  release(): Promise<void> {
    return send(this.page, 'pointerup', this.at)
  }
}
