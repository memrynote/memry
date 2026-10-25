import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { appInfo } from '../../harness/tauri-lifecycle'
import { readMainLog, waitForMainLog } from '../../harness/wait'

interface E2eWindow {
  label: string
  title: string
}

test('opens one window titled MemryNote and reports the control-file profile', async ({ app }) => {
  const windows = await invokeTest<E2eWindow[]>(app, 'e2e_windows')
  expect(windows).toHaveLength(1)
  expect(windows[0].title).toBe('MemryNote')

  const info = await appInfo(app)
  expect(info.appDataDir).toBe(app.dirs.appDataDir)
  expect(info.logDir).toBe(app.dirs.logDir)
  expect(info.device).toBe(app.device)
  expect(info.device).toMatch(/^e2e-/)
  expect(info.buildKind).toBe('e2e')
  expect(info.webdriverPort).toBe(app.port)
})

test('main.log carries the start marker and the renderer line', async ({ app }) => {
  expect(await waitForMainLog(app, 'renderer started')).toBe(true)
  const log = readMainLog(app.dirs.logDir)
  expect(log).toMatch(/starting \((dev|packaged)\)/)
})
