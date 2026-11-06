// Diagnostic for #3967 (not for merge): the offline-check click, repeated, with a layout timeline.
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
    for (const type of ['mousedown', 'click']) {
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
  console.log(`DIAG3967 ${label}\n${diag.map((line) => `DIAG3967   ${line}`).join('\n')}`)
}

for (let round = 1; round <= 12; round += 1) {
  test(`diag round ${round}: an offline check from Settings, then the auto-check switch`, async ({
    app,
    page
  }) => {
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
