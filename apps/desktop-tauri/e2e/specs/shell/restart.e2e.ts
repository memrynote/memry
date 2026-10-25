import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { test, expect } from '../../harness/test'
import { appInfo, restart } from '../../harness/tauri-lifecycle'
import { readMainLog, waitForMainLog } from '../../harness/wait'

test('restart keeps the profile and starts a new process', async ({ app }) => {
  const marker = join(app.dirs.appDataDir, 'restart-marker.txt')
  mkdirSync(app.dirs.appDataDir, { recursive: true })
  writeFileSync(marker, 'still here')
  const pidBefore = (await appInfo(app)).pid

  await restart(app)

  expect(existsSync(marker)).toBe(true)
  const info = await appInfo(app)
  expect(info.pid).not.toBe(pidBefore)
  expect(info.appDataDir).toBe(app.dirs.appDataDir)
  expect(info.device).toBe(app.device)
  expect(await waitForMainLog(app, 'renderer started')).toBe(true)
  const starts = readMainLog(app.dirs.logDir).match(/starting \((?:dev|packaged)\)/g) ?? []
  expect(starts).toHaveLength(2)
})
