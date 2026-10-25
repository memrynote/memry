import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { test, expect } from '../../harness/test'
import { appInfo } from '../../harness/tauri-lifecycle'

test('instances A and B share nothing: pid, port, dirs, device, files and localStorage', async ({
  app,
  appB,
  page,
  pageB
}) => {
  const a = await appInfo(app)
  const b = await appInfo(appB)
  expect(a.pid).not.toBe(b.pid)
  expect(a.webdriverPort).not.toBe(b.webdriverPort)
  expect(a.appDataDir).not.toBe(b.appDataDir)
  expect(a.logDir).not.toBe(b.logDir)
  expect(a.device).not.toBe(b.device)
  expect(a.device.endsWith('-A')).toBe(true)
  expect(b.device.endsWith('-B')).toBe(true)

  mkdirSync(a.appDataDir, { recursive: true })
  writeFileSync(join(a.appDataDir, 'marker-a.txt'), 'a')
  expect(existsSync(join(b.appDataDir, 'marker-a.txt'))).toBe(false)

  await page.evaluate(() => localStorage.setItem('isolation-a', '1'))
  await pageB.evaluate(() => localStorage.setItem('isolation-b', '1'))
  expect(await page.evaluate(() => localStorage.getItem('isolation-b'))).toBeNull()
  expect(await pageB.evaluate(() => localStorage.getItem('isolation-a'))).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('isolation-a'))).toBe('1')
})
