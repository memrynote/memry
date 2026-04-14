// @ts-nocheck - E2E tests inject globals (window.__hintClicks) for introspection.
/**
 * Hint Mode E2E Tests
 *
 * Covers the Vim-style hint navigation feature end-to-end:
 *   - Activation shortcuts: Alt+F (universal), F when no editor focused
 *   - Editor suppression: F inside contenteditable / input / textarea types normally
 *   - Overlay + HINT status indicator rendering via portal into document.body
 *   - Hint label assignment (single-char mnemonic; two-char fallback on first-letter collision)
 *   - Badge opacity narrowing + indicator echoing typed chars
 *   - Backspace to undo narrowing
 *   - Unique-full-match auto-click + deactivation
 *   - Escape to deactivate
 *   - Non-matching chars silently ignored
 *
 * Strategy: inject controlled DOM (`data-hint` buttons, textarea) so tests don't
 * depend on sidebar labels that shift as features are added. Match each badge to
 * its source element by comparing screen rects (badges render at rect.top - 6,
 * rect.left - 6), which survives any change to the label-assignment algorithm.
 */

import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

const OVERLAY_ID = 'hint-mode-overlay'
const INDICATOR_TEXT = 'HINT'
const TARGET_TESTID = 'hint-e2e-target'
const EDITOR_ID = 'hint-e2e-editor'
const HOST_BUTTON_ID = 'hint-e2e-host-button'

type InjectedButton = {
  label: string
  top: number
  left: number
}

async function activate(page): Promise<void> {
  await page.keyboard.press('Alt+f')
  await page.waitForSelector(`#${OVERLAY_ID}`, { timeout: 2000 })
}

async function isOverlayGone(page): Promise<void> {
  await expect(page.locator(`#${OVERLAY_ID}`)).toHaveCount(0)
}

async function injectButton(page, button: InjectedButton, index = 0): Promise<void> {
  await page.evaluate(
    ({ label, top, left, index, testid }) => {
      const btn = document.createElement('button')
      btn.setAttribute('data-hint', '')
      btn.setAttribute('data-testid', `${testid}-${index}`)
      btn.setAttribute('aria-label', label)
      btn.dataset.hintE2eIndex = String(index)
      btn.textContent = label
      Object.assign(btn.style, {
        position: 'fixed',
        top: `${top}px`,
        left: `${left}px`,
        width: '140px',
        height: '44px',
        zIndex: '10000',
        background: '#1e293b',
        color: '#f8fafc',
        border: '1px solid #334155'
      })
      if (typeof (window as any).__hintClicks !== 'object') {
        ;(window as any).__hintClicks = {}
      }
      ;(window as any).__hintClicks[String(index)] = 0
      btn.addEventListener('click', () => {
        ;(window as any).__hintClicks[String(index)] += 1
      })
      document.body.appendChild(btn)
    },
    { label: button.label, top: button.top, left: button.left, index, testid: TARGET_TESTID }
  )
}

async function cleanupInjected(page): Promise<void> {
  await page.evaluate(
    ({ testid, editorId, hostId }) => {
      document
        .querySelectorAll(`[data-testid^="${testid}"], #${editorId}, #${hostId}`)
        .forEach((el) => el.remove())
      delete (window as any).__hintClicks
    },
    { testid: TARGET_TESTID, editorId: EDITOR_ID, hostId: HOST_BUTTON_ID }
  )
}

/**
 * Returns every rendered hint badge's label, opacity, and bounding rect.
 * Badges are the direct <span> children of the #hint-mode-overlay portal.
 */
async function readBadges(
  page
): Promise<Array<{ label: string; opacity: number; top: number; left: number }>> {
  return page.evaluate((id) => {
    const overlay = document.getElementById(id)
    if (!overlay) return []
    return Array.from(overlay.querySelectorAll(':scope > span')).map((badge) => {
      const rect = (badge as HTMLElement).getBoundingClientRect()
      return {
        label: badge.textContent ?? '',
        opacity: parseFloat(getComputedStyle(badge as HTMLElement).opacity),
        top: rect.top,
        left: rect.left
      }
    })
  }, OVERLAY_ID)
}

/**
 * Finds the label assigned to the injected test button at `index` by matching
 * the badge's rendered position (rect.top - 6, rect.left - 6) to the button's
 * bounding rect. Tolerance accounts for sub-pixel rounding.
 */
async function labelForInjectedButton(page, index: number): Promise<string | null> {
  return page.evaluate(
    ({ id, selector }) => {
      const overlay = document.getElementById(id)
      if (!overlay) return null
      const target = document.querySelector(selector) as HTMLElement | null
      if (!target) return null
      const tr = target.getBoundingClientRect()
      const badges = Array.from(overlay.querySelectorAll(':scope > span')) as HTMLElement[]
      for (const badge of badges) {
        const br = badge.getBoundingClientRect()
        if (Math.abs(br.top - (tr.top - 6)) < 3 && Math.abs(br.left - (tr.left - 6)) < 3) {
          return badge.textContent
        }
      }
      return null
    },
    { id: OVERLAY_ID, selector: `[data-testid="${TARGET_TESTID}-${index}"]` }
  )
}

async function clickCount(page, index: number): Promise<number> {
  return page.evaluate((i) => (window as any).__hintClicks?.[i] ?? 0, String(index))
}

test.describe('Hint Mode', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test.afterEach(async ({ page }) => {
    // Ensure no overlay bleeds into the next test. Escape is a no-op if mode is off.
    await page.keyboard.press('Escape').catch(() => {})
    await cleanupInjected(page)
  })

  test('Alt+F activates: overlay portal, HINT indicator, and badges all render', async ({
    page
  }) => {
    await injectButton(page, { label: 'ZEBRA', top: 180, left: 200 })

    await activate(page)

    await expect(page.locator(`#${OVERLAY_ID}`)).toBeVisible()
    await expect(page.getByText(INDICATOR_TEXT, { exact: true })).toBeVisible()

    const badges = await readBadges(page)
    expect(badges.length).toBeGreaterThan(0)

    const injectedLabel = await labelForInjectedButton(page, 0)
    expect(injectedLabel).toBeTruthy()
  })

  test('Escape deactivates and removes overlay + indicator', async ({ page }) => {
    await injectButton(page, { label: 'ZEBRA', top: 180, left: 200 })
    await activate(page)
    await expect(page.locator(`#${OVERLAY_ID}`)).toBeVisible()

    await page.keyboard.press('Escape')

    await isOverlayGone(page)
    await expect(page.getByText(INDICATOR_TEXT, { exact: true })).toHaveCount(0)
  })

  test('typing a prefix narrows hints: non-matching badges dim, indicator echoes typed char', async ({
    page
  }) => {
    // Two buttons sharing first letter X → label assigner MUST produce two-char
    // codes both beginning with X (e.g. XR, XE). Typing X keeps 2 hints active;
    // no auto-click yet.
    await injectButton(page, { label: 'XRAY', top: 180, left: 200 }, 0)
    await injectButton(page, { label: 'XENON', top: 260, left: 200 }, 1)

    await activate(page)
    const before = await readBadges(page)
    const xPrefixedBefore = before.filter((b) => b.label.startsWith('X'))
    expect(xPrefixedBefore.length).toBeGreaterThanOrEqual(2)

    await page.keyboard.press('x')

    // Indicator echoes typed char via <kbd>.
    await expect(page.locator('kbd', { hasText: 'X' })).toBeVisible()

    // HintBadge uses `transition: opacity 100ms ease`, so computed opacity
    // interpolates. Poll until dimmed badges settle at their 0.3 target rather
    // than hard-coding a sleep that may be too short on slow CI runners.
    await expect
      .poll(
        async () => {
          const after = await readBadges(page)
          const dimmed = after.filter((b) => !b.label.startsWith('X'))
          return dimmed.every((b) => b.opacity < 0.5)
        },
        { timeout: 2000 }
      )
      .toBe(true)

    const after = await readBadges(page)
    const bright = after.filter((b) => b.label.startsWith('X'))
    for (const b of bright) expect(b.opacity).toBeGreaterThan(0.9)

    // Overlay still active (2+ candidates, no unique full match yet).
    await expect(page.locator(`#${OVERLAY_ID}`)).toBeVisible()
  })

  test('backspace removes the last typed char and restores full hint set', async ({ page }) => {
    await injectButton(page, { label: 'XRAY', top: 180, left: 200 }, 0)
    await injectButton(page, { label: 'XENON', top: 260, left: 200 }, 1)

    await activate(page)
    await page.keyboard.press('x')
    await expect(page.locator('kbd', { hasText: 'X' })).toBeVisible()

    await page.keyboard.press('Backspace')

    // When typedChars is empty, indicator renders no <kbd>.
    await expect(page.locator('kbd', { hasText: 'X' })).toHaveCount(0)
    // HINT badge itself still shown.
    await expect(page.getByText(INDICATOR_TEXT, { exact: true })).toBeVisible()

    // All badges back to full opacity — wait past the 100ms transition.
    await expect
      .poll(
        async () => {
          const badges = await readBadges(page)
          return badges.every((b) => b.opacity > 0.9)
        },
        { timeout: 2000 }
      )
      .toBe(true)
  })

  test('typing a full unique label clicks the target element and deactivates', async ({ page }) => {
    await injectButton(page, { label: 'QUEBEC', top: 180, left: 200 }, 0)

    await activate(page)
    const label = await labelForInjectedButton(page, 0)
    expect(label).toBeTruthy()
    expect(label!.length).toBeGreaterThan(0)

    // Type each char of the assigned label. The last keystroke that completes
    // the full label must trigger auto-click + deactivate (single exact match).
    for (const ch of label!) {
      await page.keyboard.press(ch.toLowerCase())
    }

    await isOverlayGone(page)
    await expect(page.getByText(INDICATOR_TEXT, { exact: true })).toHaveCount(0)

    const clicks = await clickCount(page, 0)
    expect(clicks).toBe(1)
  })

  test('non-matching character is silently ignored; overlay remains active with no typed chars', async ({
    page
  }) => {
    await injectButton(page, { label: 'ZEBRA', top: 180, left: 200 })
    await activate(page)

    // Digits can't be labels — scanClickableElements + label-assigner only emit ASCII letters.
    await page.keyboard.press('9')

    await expect(page.locator(`#${OVERLAY_ID}`)).toBeVisible()
    // Indicator must NOT show a typed-chars kbd because typeChar rejected the input.
    await expect(page.locator('kbd', { hasText: '9' })).toHaveCount(0)
  })

  test('F alone activates when focus is on a non-editor element', async ({ page }) => {
    // Inject a plain button (not in CLICKABLE_SELECTOR for label purposes, just a focus host),
    // focus it, then press F. The activation hook's editor detector should pass.
    await page.evaluate(
      ({ hostId }) => {
        const host = document.createElement('button')
        host.id = hostId
        host.textContent = 'Focus host'
        Object.assign(host.style, {
          position: 'fixed',
          top: '20px',
          left: '20px',
          width: '140px',
          height: '44px',
          zIndex: '10000'
        })
        document.body.appendChild(host)
        host.focus()
      },
      { hostId: HOST_BUTTON_ID }
    )
    await injectButton(page, { label: 'ZEBRA', top: 180, left: 200 })

    await page.keyboard.press('f')

    await expect(page.locator(`#${OVERLAY_ID}`)).toBeVisible()
    await expect(page.getByText(INDICATOR_TEXT, { exact: true })).toBeVisible()
  })

  test('F inside a focused editor does NOT activate hint mode (passes through as typing)', async ({
    page
  }) => {
    await page.evaluate(
      ({ editorId }) => {
        const ta = document.createElement('textarea')
        ta.id = editorId
        Object.assign(ta.style, {
          position: 'fixed',
          top: '20px',
          left: '20px',
          width: '240px',
          height: '80px',
          zIndex: '10000'
        })
        document.body.appendChild(ta)
        ta.focus()
      },
      { editorId: EDITOR_ID }
    )

    await page.keyboard.press('f')

    await isOverlayGone(page)
    const value = await page.locator(`#${EDITOR_ID}`).inputValue()
    expect(value).toBe('f')
  })

  test('Alt+F still activates even when editor has focus (editor-override shortcut)', async ({
    page
  }) => {
    await page.evaluate(
      ({ editorId }) => {
        const ta = document.createElement('textarea')
        ta.id = editorId
        Object.assign(ta.style, {
          position: 'fixed',
          top: '20px',
          left: '20px',
          width: '240px',
          height: '80px',
          zIndex: '10000'
        })
        document.body.appendChild(ta)
        ta.focus()
      },
      { editorId: EDITOR_ID }
    )
    await injectButton(page, { label: 'ZEBRA', top: 180, left: 240 })

    await page.keyboard.press('Alt+f')

    await expect(page.locator(`#${OVERLAY_ID}`)).toBeVisible()
    await expect(page.getByText(INDICATOR_TEXT, { exact: true })).toBeVisible()

    // And the textarea must not have received 'f' (hook called preventDefault).
    const value = await page.locator(`#${EDITOR_ID}`).inputValue()
    expect(value).toBe('')
  })

  test('disabled elements and elements outside viewport do not receive hint badges', async ({
    page
  }) => {
    // Visible + enabled → labeled.
    await injectButton(page, { label: 'VISIBLE_ONE', top: 200, left: 200 }, 0)

    // Disabled button at a visible position → must be skipped by scanner.
    await page.evaluate(() => {
      const btn = document.createElement('button')
      btn.setAttribute('data-hint', '')
      btn.setAttribute('data-testid', 'hint-e2e-disabled')
      btn.setAttribute('aria-label', 'DISABLED_ONE')
      btn.disabled = true
      btn.textContent = 'DISABLED_ONE'
      Object.assign(btn.style, {
        position: 'fixed',
        top: '280px',
        left: '200px',
        width: '140px',
        height: '44px',
        zIndex: '10000'
      })
      document.body.appendChild(btn)
    })

    // Off-screen button (negative coordinates) → must be skipped by isInViewport.
    await page.evaluate(() => {
      const btn = document.createElement('button')
      btn.setAttribute('data-hint', '')
      btn.setAttribute('data-testid', 'hint-e2e-offscreen')
      btn.setAttribute('aria-label', 'OFFSCREEN_ONE')
      btn.textContent = 'OFFSCREEN_ONE'
      Object.assign(btn.style, {
        position: 'fixed',
        top: '-500px',
        left: '-500px',
        width: '140px',
        height: '44px',
        zIndex: '10000'
      })
      document.body.appendChild(btn)
    })

    await activate(page)

    const badges = await readBadges(page)
    const labels = badges.map((b) => b.label)

    // No label on disabled/off-screen buttons regardless of the codes chosen.
    // Verify indirectly: the visible injected button has a badge, the others
    // don't. We compare badge positions against each injected rect.
    const positions = await page.evaluate(() => {
      const pick = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { top: r.top - 6, left: r.left - 6 }
      }
      return {
        visible: pick('[data-testid="hint-e2e-target-0"]'),
        disabled: pick('[data-testid="hint-e2e-disabled"]'),
        offscreen: pick('[data-testid="hint-e2e-offscreen"]')
      }
    })

    const hasBadgeAt = (p: { top: number; left: number } | null) =>
      !!p && badges.some((b) => Math.abs(b.top - p.top) < 3 && Math.abs(b.left - p.left) < 3)

    expect(hasBadgeAt(positions.visible)).toBe(true)
    expect(hasBadgeAt(positions.disabled)).toBe(false)
    expect(hasBadgeAt(positions.offscreen)).toBe(false)

    // Cleanup the extra injected DOM.
    await page.evaluate(() => {
      document
        .querySelectorAll('[data-testid="hint-e2e-disabled"], [data-testid="hint-e2e-offscreen"]')
        .forEach((el) => el.remove())
    })
    // Leave nothing typed, sequence length of `labels` was just for debug context.
    expect(labels.length).toBeGreaterThan(0)
  })
})
