// FLAKE-7C probe (#3967), not for merge. Hypothesis: the `/` menu closes when the OS window comes
// to the front after the editor took DOM focus while another window held OS focus (no `focus`
// event before, so window-focus-plugin's `focused` flag is false and the first `focus` is replayed
// to TipTap/BlockNote). A foreground stealer (notepad on Windows) emulates another app window.
import { spawn } from 'node:child_process'

import { openNewNote, typeInEditor } from '../../harness/editor'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test } from '../../harness/test'
import { sleep } from '../../harness/wait'

const ROUNDS = 14

async function installRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __f7: string[]; __f7t0: number; __f7on?: boolean }
    w.__f7 = []
    w.__f7t0 = performance.now()
    if (w.__f7on) return
    w.__f7on = true
    const log = (what: string): void => {
      const ed = document.querySelector('.ProseMirror[contenteditable="true"]')
      w.__f7.push(
        `${Math.round(performance.now() - w.__f7t0)}:${what}:hf=${document.hasFocus() ? 1 : 0}:ae=${
          ed && document.activeElement === ed ? 1 : 0
        }:ex=${ed?.getAttribute('aria-expanded') ?? '-'}`
      )
    }
    document.addEventListener(
      'focus',
      (e) => log(`focus<${(e.target as Element)?.nodeName}>`),
      true
    )
    document.addEventListener('blur', (e) => log(`blur<${(e.target as Element)?.nodeName}>`), true)
    window.addEventListener('focus', () => log('WIN-focus'))
    window.addEventListener('blur', () => log('WIN-blur'))
    document.addEventListener('beforeinput', () => log('beforeinput'), true)
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.attributeName === 'aria-expanded') log('aria-expanded-changed')
      }
    }).observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ['aria-expanded']
    })
  })
}

async function readRecorder(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __f7: string[] }).__f7.join(' | '))
}

async function menuOpen(page: Page): Promise<boolean> {
  return page.evaluate(
    (sel: string) => document.querySelector(sel)?.getAttribute('aria-expanded') === 'true',
    NOTE_EDITOR
  )
}

function stealForeground(holdMs: number): void {
  if (process.platform !== 'win32') return
  const child = spawn('notepad.exe', [], { stdio: 'ignore', windowsHide: false })
  child.on('error', () => undefined)
  setTimeout(() => {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
  }, holdMs)
}

// [delay before the click, delay between click and typing, hold time of the stealer]
const SCHEDULES: Array<[number, number, number]> = [
  [0, 0, 900],
  [200, 0, 900],
  [400, 100, 900],
  [100, 300, 1200],
  [600, 0, 1200],
  [0, 500, 900],
  [300, 200, 1500]
]

for (const [index, schedule] of SCHEDULES.entries()) {
  test(`FLAKE7C probe schedule ${index} ${schedule.join('/')}`, async ({ page }) => {
    const [beforeClick, beforeType, hold] = schedule
    await vaultOpen(page)
    await installRecorder(page)
    let closed = 0
    for (let round = 0; round < ROUNDS; round += 1) {
      await openNewNote(page, `F7 ${index}-${round} ${Date.now()}`)
      await installRecorder(page)
      stealForeground(hold)
      await sleep(beforeClick)
      await page.locator(NOTE_EDITOR).first().click()
      await sleep(beforeType)
      await typeInEditor(page, '/quote')
      const early = await menuOpen(page)
      await sleep(hold + 600)
      const late = await menuOpen(page)
      const trace = await readRecorder(page)
      if (!late) closed += 1
      console.log(
        `FLAKE7C s=${index} r=${round} open_after_type=${early} open_after_restore=${late}${
          late ? '' : ` TRACE ${trace}`
        }`
      )
    }
    console.log(`FLAKE7C s=${index} summary closed=${closed}/${ROUNDS}`)
  })
}
