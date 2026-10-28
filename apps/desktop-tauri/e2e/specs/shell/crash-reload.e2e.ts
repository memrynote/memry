// A web content process that dies leaves the window frozen (WebKit) or blank (WebView2). The
// shell reloads the page up to three times a minute and the page tells the user. Each death
// spends one reload: a second subscription to the same death would spend two (#3527 10h).
import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { pollUntil, readMainLog, sleep } from '../../harness/wait'

const RELOADED = 'reloading main after its web process ended'

const reloads = (logDir: string): number => readMainLog(logDir).split(RELOADED).length - 1

test('three page crashes in a minute are three reloads, each told to the user', async ({
  app,
  page
}) => {
  for (let crash = 1; crash <= 3; crash += 1) {
    await app.executor.execute('window.__memryBeforeCrash = true')
    await invokeTest(app, 'e2e_kill_page')
    // No WebDriver call until the shell has reloaded: on Windows a script in flight when the
    // renderer dies hangs the session past the toast's 10 s.
    const reloaded = await pollUntil(() => reloads(app.dirs.logDir) >= crash, {
      timeoutMs: 15_000,
      intervalMs: 100
    })
    expect(reloaded).toBe(true)

    const fresh = await pollUntil(
      async () => {
        try {
          return await app.executor.execute(
            "return window.__memryBeforeCrash === undefined && document.readyState === 'complete'"
          )
        } catch {
          // The new document is not up yet.
          return false
        }
      },
      { timeoutMs: 30_000, intervalMs: 250 }
    )
    expect(fresh).toBe(true)
    await expect(page.locator('body')).toContainText('MemryNote reloaded after a crash')
    // A second hook reporting the same death would log its reload by now.
    await sleep(1_000)
    expect(reloads(app.dirs.logDir)).toBe(crash)
  }
  expect(readMainLog(app.dirs.logDir)).not.toContain('reloads stopped')
})
