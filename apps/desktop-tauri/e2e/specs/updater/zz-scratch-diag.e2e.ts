// Diagnostic for #3967 (not for merge): the offline-check click, repeated, with a layout timeline.
import { execFileSync } from 'node:child_process'
import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { invoke } from '../../harness/vault-commands'
import type { Page } from '../../harness/pw-compat/page'

test.use({ extraEnv: { MEMRY_TEST_UPDATER: 'scripted' } })

function record(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const w = window as unknown as { __diag: string[] }
    w.__diag = []
    const t0 = performance.now()
    const log = (s: string) => w.__diag.push(`${(performance.now() - t0).toFixed(0)} ${s}`)
    let last = ''
    const rect = (el: Element | null | undefined) => {
      if (!el) return '-'
      const r = el.getBoundingClientRect()
      return `${r.x.toFixed(0)},${r.y.toFixed(0)},${r.width.toFixed(0)}x${r.height.toFixed(0)}`
    }
    const sample = () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        /Check now|Checking/.test(b.textContent ?? '')
      )
      const sw = document.querySelector(
        '[role="switch"][aria-label="Automatically check for updates"]'
      )
      const vp = document.querySelector(
        '[data-testid="settings-view"] [data-radix-scroll-area-viewport]'
      )
      const cur = `win=${innerWidth}x${innerHeight} btn=${rect(btn)} sw=${rect(sw)} scroll=${vp ? `${vp.scrollTop}/${vp.scrollHeight}/${vp.clientHeight}` : '-'}`
      if (cur !== last) {
        log(cur)
        last = cur
      }
    }
    sample()
    setInterval(sample, 10)
    const describe = (n: Element) =>
      `<${n.tagName.toLowerCase()} testid=${n.getAttribute('data-testid') ?? ''} role=${n.getAttribute('role') ?? ''} class="${String(n.className).slice(0, 50)}"> ${rect(n)} "${(n.textContent ?? '').slice(0, 40)}"`
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) if (n instanceof Element) log(`+ ${describe(n)}`)
        for (const n of r.removedNodes) if (n instanceof Element) log(`- ${describe(n)}`)
        if (r.type === 'attributes' && r.target instanceof Element && r.attributeName === 'class')
          log(`class ${describe(r.target)}`)
      }
    }).observe(document.body, { childList: true, subtree: true })
    document.addEventListener(
      'scroll',
      (e) => log(`scroll ${e.target instanceof Element ? describe(e.target) : 'document'}`),
      true
    )
    for (const type of [
      'mousemove',
      'mousedown',
      'mouseup',
      'wheel',
      'keydown',
      'keyup',
      'dragstart',
      'dragover',
      'selectstart',
      'pointermove',
      'pointerdown',
      'pointerup',
      'touchstart',
      'contextmenu',
      'mouseover',
      'mouseout'
    ]) {
      window.addEventListener(
        type,
        (e) => {
          if (!e.isTrusted) return
          const m = e as MouseEvent & KeyboardEvent & WheelEvent
          log(
            `TRUSTED ${type} on ${describe(e.target as Element)} xy=${m.clientX},${m.clientY} buttons=${m.buttons} key=${m.key} dy=${m.deltaY} mode=${m.deltaMode}`
          )
        },
        true
      )
    }
    document.addEventListener('selectionchange', () => {
      const sel = document.getSelection()
      log(`selectionchange type=${sel?.type} anchor=${sel?.anchorNode?.nodeName}`)
    })
    window.addEventListener('resize', () => log(`resize ${innerWidth}x${innerHeight}`))
    document.addEventListener('focusin', (e) => log(`focusin ${describe(e.target as Element)}`))
    for (const type of ['mousedown', 'mouseup', 'click', 'pointerdown']) {
      window.addEventListener(
        type,
        (e) => {
          const el = e.target as Element
          const m = e as MouseEvent
          log(
            `${type} <${el.tagName.toLowerCase()} ${(el.textContent ?? '').slice(0, 24)}> at ${m.clientX},${m.clientY}`
          )
        },
        true
      )
    }
    return true
  })
}

async function dump(page: Page, label: string): Promise<void> {
  const diag = await page
    .evaluate(() => (window as unknown as { __diag?: string[] }).__diag ?? [])
    .catch(() => ['(page gone)'])
  const shifts = new Set(
    diag.filter((line) => line.includes('btn=1')).map((line) => line.replace(/^\d+ /, ''))
  ).size
  const full = label.includes('FAILED') || shifts > 3
  const lines = full ? diag : diag.filter((line) => /win=|mouse|click|resize/.test(line))
  console.log(
    `DIAG3967 ${label} shifts=${shifts}\n${lines.map((line) => `DIAG3967   ${line}`).join('\n')}`
  )
}

for (let round = 1; round <= 60; round += 1) {
  test(`diag round ${round}: an offline check from Settings, then the auto-check switch`, async ({
    app,
    page
  }) => {
    // Odd rounds park the X pointer off the window (1440x900 at 0,0 on a 1920x1080 screen).
    const park = round % 2 === 1 ? [1900, 1060] : [960, 540]
    if (process.platform === 'linux') {
      execFileSync('python3', [
        '-c',
        `import ctypes;x=ctypes.cdll.LoadLibrary('libX11.so.6');x.XOpenDisplay.restype=ctypes.c_void_p;d=x.XOpenDisplay(None);r=x.XDefaultRootWindow(ctypes.c_void_p(d));x.XWarpPointer(ctypes.c_void_p(d),0,ctypes.c_ulong(r),0,0,0,0,${park[0]},${park[1]});x.XFlush(ctypes.c_void_p(d))`
      ])
    }
    console.log(`DIAG3967 round ${round} pointer ${park.join(',')}`)
    await record(page)
    const windows = await invokeTest<{ label: string; width: number; height: number }[]>(
      app,
      'e2e_windows'
    )
    console.log(`DIAG3967 round ${round} e2e_windows ${JSON.stringify(windows)}`)
    let outcome = 'ok'
    try {
      await invoke(page, 'telemetry_set_enabled', { enabled: true })
      await expect
        .poll(async () => {
          const s = await invoke<{ lastCheckedAt: number | null; status: string }>(
            page,
            'updater_get_state'
          )
          return s.lastCheckedAt !== null && s.status !== 'checking'
        })
        .toBe(true)
      await invokeTest(app, 'e2e_updater_script', {
        steps: [
          { kind: 'fail', error: 'offline' },
          { kind: 'fail', error: 'offline' }
        ]
      })
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'General', exact: true }).click()
      await page.getByRole('button', { name: 'Check now' }).click()
      await expect
        .poll(async () => (await invoke<{ status: string }>(page, 'updater_get_state')).status, {
          timeout: 5_000
        })
        .toBe('error')
      await expect(page.getByText(/could not be resolved/).first()).toBeVisible()
      const autoCheck = page.getByRole('switch', { name: 'Automatically check for updates' })
      await autoCheck.click()
      await expect
        .poll(
          async () =>
            (await invoke<{ autoCheckEnabled: boolean }>(page, 'updater_get_state'))
              .autoCheckEnabled,
          { timeout: 5_000 }
        )
        .toBe(false)
    } catch (error) {
      outcome = `FAILED ${String(error).slice(0, 200)}`
    }
    await dump(page, `round ${round} ${outcome}`)
  })
}
