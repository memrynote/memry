// Screencast recorder + human-like driver for the memry renderer.
import * as fs from 'node:fs'
import * as path from 'node:path'

const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M5 3 L5 21 L9.6 16.8 L12.8 23.6 L16 22.2 L12.9 15.5 L19 15.5 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`

export async function installCursor(page) {
  await page.evaluate((svg) => {
    if (document.getElementById('__tut_cursor')) return
    const c = document.createElement('div')
    c.id = '__tut_cursor'
    c.innerHTML = svg
    Object.assign(c.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '26px',
      height: '26px',
      zIndex: 2147483647,
      pointerEvents: 'none',
      transform: 'translate(-100px,-100px)',
      filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))'
    })
    document.documentElement.appendChild(c)
    const st = document.createElement('style')
    st.textContent = `@keyframes __tut_ring{from{transform:translate(-50%,-50%) scale(.3);opacity:.55}to{transform:translate(-50%,-50%) scale(1);opacity:0}}
      .__tut_ring{position:fixed;width:44px;height:44px;border-radius:50%;background:rgba(240,120,40,.35);border:2px solid rgba(240,120,40,.8);pointer-events:none;z-index:2147483646;animation:__tut_ring .45s ease-out forwards}`
    document.documentElement.appendChild(st)
    addEventListener(
      'mousemove',
      (e) => {
        c.style.transform = `translate(${e.clientX - 5}px,${e.clientY - 3}px)`
      },
      true
    )
    addEventListener(
      'mousedown',
      (e) => {
        const r = document.createElement('div')
        r.className = '__tut_ring'
        r.style.left = e.clientX + 'px'
        r.style.top = e.clientY + 'px'
        document.documentElement.appendChild(r)
        setTimeout(() => r.remove(), 500)
      },
      true
    )
  }, CURSOR_SVG)
}

export class Recorder {
  constructor(page, dir) {
    this.page = page
    this.dir = dir
    this.frames = []
    this.events = []
    this.mouse = { x: 700, y: 450 }
    this.spans = []
  }
  /** Plays what is recorded from now until speedEnd() `rate` times faster in the film. */
  speed(rate) {
    this.spans.push({ t0: this.now(), t1: Infinity, rate })
  }
  speedEnd() {
    this.spans.at(-1).t1 = this.now()
  }
  /** Recording time -> film time, with the fast-forward spans squeezed. */
  remap(t) {
    let cut = 0
    for (const s of this.spans)
      if (t > s.t0) cut += (Math.min(t, s.t1) - s.t0) * (1 - 1 / s.rate)
    return t - cut
  }
  async start() {
    fs.rmSync(this.dir, { recursive: true, force: true })
    fs.mkdirSync(this.dir, { recursive: true })
    this.cdp = await this.page.context().newCDPSession(this.page)
    this.cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
      const f = path.join(this.dir, `f${String(this.frames.length).padStart(6, '0')}.jpg`)
      fs.writeFileSync(f, Buffer.from(data, 'base64'))
      this.frames.push({ f, t: metadata.timestamp })
      this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    })
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 95,
      everyNthFrame: 1,
      maxWidth: 3840,
      maxHeight: 2160
    })
    this.t0 = Date.now() / 1000
    await this.page.mouse.move(this.mouse.x, this.mouse.y)
  }
  now() {
    return Date.now() / 1000 - this.t0
  }
  mark(type, extra = {}) {
    this.events.push({ t: this.now(), type, x: this.mouse.x, y: this.mouse.y, ...extra })
  }
  async stop() {
    await this.cdp.send('Page.stopScreencast')
    await this.cdp.detach()
    const t0 = this.t0
    fs.writeFileSync(
      path.join(this.dir, 'frames.json'),
      JSON.stringify(this.frames.map((x) => ({ ...x, t: this.remap(x.t - t0) })))
    )
    fs.writeFileSync(
      path.join(this.dir, 'events.json'),
      JSON.stringify(
        this.events.map((e) => ({ ...e, t: this.remap(e.t) })),
        null,
        1
      )
    )
  }
  // Eased glide, one real mousemove per ~frame so hover states fire like a human's.
  async glide(x, y, ms) {
    const { x: x0, y: y0 } = this.mouse
    const dist = Math.hypot(x - x0, y - y0)
    ms ??= Math.min(900, 250 + dist * 0.6)
    // Position follows the wall clock: each CDP mouse move costs a round trip, so a fixed
    // number of steps ran 2-3x longer than `ms` and pushed actions past their words.
    const start = Date.now()
    for (let k = 0; k < 1;) {
      k = Math.min(1, (Date.now() - start) / ms)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      const arc = Math.sin(k * Math.PI) * Math.min(40, dist * 0.08)
      await this.page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e - arc)
      if (k < 1) await sleep(8)
    }
    this.mouse = { x, y }
  }
  async center(locator) {
    const b = await locator.boundingBox()
    if (!b) throw new Error('no box for ' + locator)
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  async click(locator, { dx = 0, dy = 0, pause = 180 } = {}) {
    const c = await this.center(locator)
    await this.glide(c.x + dx, c.y + dy)
    await sleep(pause)
    this.mark('click')
    await this.page.mouse.down()
    await sleep(70)
    await this.page.mouse.up()
  }
  async type(text, { cps = 14 } = {}) {
    this.mark('type-start', { text })
    for (const ch of text) {
      await this.page.keyboard.type(ch)
      await sleep((1000 / cps) * (0.6 + Math.random() * 0.8) + (ch === ' ' ? 40 : 0))
    }
    this.mark('type-end')
  }
  async key(k) {
    this.mark('key', { key: k })
    await this.page.keyboard.press(k)
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
