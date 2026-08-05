import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  destroyElectronApp,
  launchElectronWithWindow,
  type LaunchedElectron
} from './utils/electron-lifecycle'
import {
  approveAgentToolCall,
  enableManualAgentToolApproval,
  getAgentComposer,
  getAgentModelTrigger,
  openAgentChat
} from './utils/agent-chat-helpers'
import {
  createNote,
  navigateTo,
  waitForAppReady,
  waitForVaultReady
} from './utils/electron-helpers'

const AGENT_TASK_CREATE_TIMEOUT_MS = process.env.CI ? 60_000 : 20_000

test.describe('Agent chat Codex create-task flow', () => {
  let launched: LaunchedElectron | null = null
  let testVaultPath = ''

  test.beforeEach(async () => {
    testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-agent-codex-e2e-'))
    fs.mkdirSync(path.join(testVaultPath, '.memry'), { recursive: true })
    fs.mkdirSync(path.join(testVaultPath, 'notes'), { recursive: true })
    fs.mkdirSync(path.join(testVaultPath, 'journal'), { recursive: true })

    const stubDir = path.resolve(__dirname, 'fixtures')
    launched = await launchElectronWithWindow({
      testVaultPath,
      extraEnv: {
        PATH: `${stubDir}:${process.env.PATH ?? ''}`
      }
    })
  })

  test.afterEach(async () => {
    if (launched) {
      const dirs = [launched.userDataDir]
      if (launched.resolvedUserDataDir !== launched.userDataDir) {
        dirs.push(launched.resolvedUserDataDir)
      }
      await destroyElectronApp(launched.app, dirs)
    }
    if (testVaultPath) {
      fs.rmSync(testVaultPath, { recursive: true, force: true })
    }
    launched = null
    testVaultPath = ''
  })

  test('creates a task through the Codex approval gate from an active note', async () => {
    if (!launched) throw new Error('Electron app was not launched')
    const { page } = launched

    await waitForAppReady(page)
    await waitForVaultReady(page)
    await createNote(page, 'Agent source note', 'Remember to buy milk after work.')
    await enableManualAgentToolApproval(page)

    await openAgentChat(page)
    await getAgentModelTrigger(page).click()
    await page.getByRole('menuitem', { name: /codex/i }).click()

    const composer = getAgentComposer(page)
    await expect(composer).toBeEnabled()
    await composer.fill('Create a task from the current note')
    await composer.press('Enter')

    await approveAgentToolCall(page, /Creating task.*Awaiting approval/i)

    await expect
      .poll(
        async () => {
          const tasks = await page.evaluate(() => window.api.tasks.list({ limit: 100 }))
          return tasks.tasks.some((task) => task.title === 'Buy milk')
        },
        { timeout: AGENT_TASK_CREATE_TIMEOUT_MS }
      )
      .toBe(true)

    await navigateTo(page, 'tasks')
    await page.getByRole('tab', { name: /^All\b/ }).click()
    await expect(page.getByRole('button', { name: 'Task: Buy milk' })).toBeVisible()
  })
})
