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
  createNote,
  navigateTo,
  waitForAppReady,
  waitForVaultReady
} from './utils/electron-helpers'

test.describe('Agent chat create-task flow', () => {
  let launched: LaunchedElectron | null = null
  let testVaultPath = ''

  test.beforeEach(async () => {
    testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-agent-e2e-'))
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

  test('creates a task through the approval gate from an active note', async () => {
    if (!launched) throw new Error('Electron app was not launched')
    const { page } = launched

    await waitForAppReady(page)
    await waitForVaultReady(page)
    await createNote(page, 'Agent source note', 'Remember to buy milk after work.')

    await page.getByRole('button', { name: 'Day Panel' }).click()
    await page.getByRole('tab', { name: 'Agent', exact: true }).click()
    await page.getByRole('button', { name: 'Enable Claude CLI chat' }).click()

    const composer = page.locator('textarea[placeholder="Ask Agent"]')
    await expect(composer).toBeEnabled()
    await composer.fill('Create a task from the current note')
    await composer.press('Enter')

    const agentChat = page.getByRole('region', { name: 'Agent chat' })
    await expect(agentChat.getByRole('button', { name: /vault_create_task/i })).toBeVisible()
    await agentChat.getByRole('button', { name: 'Allow once' }).click()

    await expect
      .poll(
        async () => {
          const tasks = await page.evaluate(() => window.api.tasks.list({ limit: 100 }))
          return tasks.tasks.some((task) => task.title === 'Buy milk')
        },
        { timeout: 20_000 }
      )
      .toBe(true)

    await navigateTo(page, 'tasks')
    await page.getByRole('tab', { name: /^All\b/ }).click()
    await expect(page.getByRole('button', { name: 'Task: Buy milk' })).toBeVisible()
  })
})
