// Agent Chat asks before it writes: Maya asks for a Next steps checklist in "Weekly sync with
// Sam", the agent's edit shows up inside the note as a preview that is not saved yet, and it
// lands only when she presses Accept. The agent is the real Claude Code CLI (Sonnet, low effort),
// so its wording varies a little from take to take; the wait for it is played 4x faster and the
// caption says so.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'

const NOTE = 'Weekly sync with Sam'
const PROMPT = 'Add a Next steps checklist'

// The main process of this slot's app (clip.mjs put the slot's ports and TMPDIR in the env).
const mainEval = (expression) =>
  execFileSync(
    'node',
    [
      path.join(process.env.MEMRY_SOCIAL_APP, 'apps/desktop/scripts/agent-app.mjs'),
      'eval',
      expression
    ],
    {
      encoding: 'utf8'
    }
  ).trim()

const reviewBar = (page) => page.getByRole('region', { name: "Review the agent's suggestion" })
const composer = (page) => page.locator('[contenteditable=true]').last()

/** Off camera: pick a model in the composer's settings menu (Model or Effort submenu). */
async function pick(page, submenu, item) {
  await page.getByRole('button', { name: /Agent model settings/ }).click()
  await page.waitForTimeout(500)
  await page.getByText(submenu, { exact: true }).last().click()
  await page.waitForTimeout(600)
  await page.getByRole('menuitem', { name: item, exact: true }).first().click()
  await page.waitForTimeout(600)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

export async function setup({ page }) {
  // The CLI runs as Kaan's signed-in Claude Code; keep his own CLAUDE.md, rules and memory out of
  // the demo agent's turns, like a fresh install. Spawned CLIs inherit the main process env.
  mainEval(
    `Object.assign(process.env, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }) && 'ok'`
  )
  await open(page, NOTE)
  await closeOtherTabs(page, NOTE)
  await page.getByRole('tab', { name: 'Agent' }).click()
  await page.waitForTimeout(1500)
  const enable = page.getByRole('button', { name: 'Enable Agent chat' })
  if (await enable.count()) {
    await enable.click()
    await page.waitForTimeout(2500)
  }
  // Sonnet at low effort answers this in about 5 s; the default (Opus, extra high) takes longer.
  await pick(page, 'Model', 'Sonnet')
  await pick(page, 'Effort', 'Low')
  const chip = await page.getByRole('button', { name: /Agent model settings/ }).textContent()
  if (!/Sonnet/.test(chip) || !/Low/.test(chip)) throw new Error(`Model chip reads "${chip}"`)
  await settle(page, 1000, 700)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.6)
    const c = await rec.center(composer(page))
    await rec.glide(c.x - 40, c.y - 6, 1600)
  },
  async ask({ rec, page, zoom, sleep, at }) {
    // The composer is pinned to the bottom of the right pane, so the camera clamps to that
    // corner; the caption sits left of it.
    zoom(1440, 800, 1.8)
    await sleep(450)
    await rec.click(composer(page), { dx: -60 })
    await sleep(250)
    // Off the line being typed, so the prompt reads.
    await rec.glide(1460, 868, 450)
    await sleep(200)
    await rec.type(PROMPT, { cps: 11 })
    await at(4.4)
  },
  async draft({ rec, page, zoom, sleep }) {
    // The agent's edit appears inside the note, where Maya reviews it. The wait for the model
    // plays 4x faster, and the caption says so.
    await rec.key('Enter')
    zoom(789, 530, 1.6)
    await rec.glide(1000, 560, 800)
    rec.speed(4)
    await reviewBar(page).getByRole('button', { name: 'Accept' }).waitFor({ timeout: 120_000 })
    await sleep(400)
    rec.speedEnd()
    await rec.glide(780, 580, 700)
    await sleep(900)
  },
  async preview({ rec, page, zoom, sleep, at }) {
    // The agent's wording varies, so the bar's height does too: frame it from where it is, its
    // bottom at 70% of the frame, clear of the step caption.
    const bar = await reviewBar(page).boundingBox()
    const z = 1.85
    zoom(800, bar.y + bar.height - 0.7 * (900 / z) + 450 / z, z)
    await sleep(600)
    const reject = await rec.center(reviewBar(page).getByRole('button', { name: 'Reject' }))
    await rec.glide(reject.x, reject.y, 900)
    await sleep(700)
    const accept = await rec.center(reviewBar(page).getByRole('button', { name: 'Accept' }))
    await rec.glide(accept.x - 4, accept.y, 700)
    await at(3.8)
  },
  async accept({ rec, page, sleep, at }) {
    await rec.click(reviewBar(page).getByRole('button', { name: 'Accept' }), { dx: -4 })
    await page
      .locator('[data-testid="agent-review-surface"]')
      .waitFor({ state: 'detached', timeout: 15_000 })
    await sleep(500)
    await rec.glide(1000, 380, 900)
    await at(3.4)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

/** The note as the app saved it, in the vault copy the app runs on (agent-app's state file). */
function savedNote() {
  const { vaultPath } = JSON.parse(
    fs.readFileSync(path.join(os.tmpdir(), 'memry-agent-app.json'), 'utf8')
  )
  return fs.readFileSync(path.join(vaultPath, 'Meetings', `${NOTE}.md`), 'utf8')
}

export const checks = [
  [
    'the accepted checklist is saved in the note file',
    () => (/Next steps[\s\S]*- \[ \]/.test(savedNote()) ? null : savedNote())
  ]
]
