import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  destroyElectronApp,
  launchElectronWithWindow,
  type LaunchedElectron
} from './utils/electron-lifecycle'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const editShortcut = (key: string): string => `${modifier}+${key}`

test.describe('Agent chat prompt native text editing', () => {
  let launched: LaunchedElectron | null = null
  let testVaultPath = ''

  test.beforeEach(async () => {
    testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-agent-editing-e2e-'))
    fs.mkdirSync(path.join(testVaultPath, '.memry'), { recursive: true })
    fs.mkdirSync(path.join(testVaultPath, 'notes'), { recursive: true })
    fs.mkdirSync(path.join(testVaultPath, 'journal'), { recursive: true })

    launched = await launchElectronWithWindow({ testVaultPath })
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

  test('supports select all, copy, cut, and paste in the composer', async () => {
    if (!launched) throw new Error('Electron app was not launched')
    const { app, page } = launched

    await waitForAppReady(page)
    await waitForVaultReady(page)

    await page.getByRole('button', { name: 'Day Panel' }).click()
    await page.getByRole('tab', { name: 'Agent', exact: true }).click()
    await page.getByRole('button', { name: 'Enable Agent chat' }).click()

    const composer = page.locator('textarea[placeholder="Ask Agent"]')
    await expect(composer).toBeEnabled()

    await composer.fill('first prompt')
    await composer.focus()
    await page.keyboard.press(editShortcut('A'))
    await page.keyboard.type('replacement prompt')
    await expect(composer).toHaveValue('replacement prompt')

    await page.keyboard.press(editShortcut('A'))
    await page.keyboard.press(editShortcut('C'))
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('replacement prompt')

    await page.keyboard.press(editShortcut('X'))
    await expect(composer).toHaveValue('')

    await app.evaluate(({ clipboard }) => clipboard.writeText('pasted prompt'))
    await page.keyboard.press(editShortcut('V'))
    await expect(composer).toHaveValue('pasted prompt')
  })
})
