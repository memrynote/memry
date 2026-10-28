import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { isAlive } from '../../harness/app-process'
import { startFakeSessionManager, type FakeSessionManager } from '../../harness/session-manager'
import { pollUntil, readMainLog, waitForMainLog } from '../../harness/wait'

// On macOS this posts the real NSWorkspace notifications, so the observers are under test; on
// Windows and Linux it publishes on the monitor, and the VM rows cover the OS side (suspend and
// resume log lines, logoff).
test('sleep, wake and power-off reach the power monitor and the log', async ({ app }) => {
  await invokeTest(app, 'e2e_post_power_event', { kind: 'sleep' })
  expect(await waitForMainLog(app, 'system suspend')).toBe(true)

  await invokeTest(app, 'e2e_post_power_event', { kind: 'wake' })
  expect(await waitForMainLog(app, 'system resume')).toBe(true)

  await invokeTest(app, 'e2e_post_power_event', { kind: 'poweroff' })
  expect(await waitForMainLog(app, 'session ending')).toBe(true)
})

test('an unknown event kind is refused', async ({ app }) => {
  let refused = false
  await invokeTest(app, 'e2e_post_power_event', { kind: 'explode' }).catch(() => {
    refused = true
  })
  expect(refused).toBe(true)
})

// Windows asks the main window with WM_QUERYENDSESSION, then sends WM_ENDSESSION to every
// top-level window of the process, and tao's hidden event target answers it with
// process::exit(0). Either window may be asked first, and neither may let the process end before
// the quit sequence has run.
for (const target of ['event-target', 'main']) {
  test(`a sign-out announced to the ${target} window runs the quit sequence to its end`, async ({
    app
  }) => {
    test.skip(process.platform !== 'win32', 'WM_ENDSESSION is Windows-only')

    await invokeTest(app, 'e2e_send_session_end', { target })

    expect(await waitForMainLog(app, 'starting graceful shutdown', 5_000)).toBe(true)
    expect(await waitForMainLog(app, 'cleanup complete', 5_000)).toBe(true)
    expect(readMainLog(app.dirs.logDir)).not.toContain('the session ended before the quit sequence')
  })
}

// At a real sign-out the WebView2 processes get their own WM_ENDSESSION and end themselves a few
// milliseconds after the app's quit sequence starts. An edit only the page holds (a note's
// unsaved markdown, here the e2e held edit, which reaches main only through the save registry's
// flush) must still be on disk, and the sign-out must not wait on a page that is gone.
for (const hidden of [false, true]) {
  test(`an edit only the page holds survives a sign-out that ends the webview (${
    hidden ? 'hidden to the tray' : 'window shown'
  })`, async ({ app }) => {
    test.skip(process.platform !== 'win32', 'WM_QUERYENDSESSION is Windows-only')

    if (hidden) expect(await invokeTest<boolean>(app, 'e2e_hide_to_tray')).toBe(true)
    const edit = `held-${Date.now()}`
    await app.executor.execute('window.__memryE2eHoldEdit(arguments[0])', edit)
    const startedAt = Date.now()
    await invokeTest(app, 'e2e_send_session_end', { target: 'main', killWebview: true })

    const exited = await pollUntil(() => !isAlive(app.pid), { timeoutMs: 10_000, intervalMs: 50 })
    expect(exited).toBe(true)
    // Windows ends a process about five seconds into a sign-out.
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(readFileSync(join(app.dirs.appDataDir, 'e2e-held-edit.txt'), 'utf8')).toBe(edit)
    const log = readMainLog(app.dirs.logDir)
    expect(log).toContain('cleanup complete')
    expect(log).not.toContain('flush of window main timed out')
  })
}

// A Linux logout quits the session manager and the display server with it, and Xlib's IO error
// handler then ends the app with _exit(1); logind announces nothing. The session manager asks
// its registered clients first and keeps the display up until each has answered EndSession, so
// by that answer the edit the page holds must be on disk. The fake ends the app with SIGKILL as
// soon as it answers, as the display going away does; an app that has already exited closed its
// connection, which both session managers count as an answer. GNOME and Xfce speak the same
// protocol under their own bus names.
for (const desktop of ['gnome', 'xfce'] as const) {
  const logoutTest = test.extend<{ sessionManager: FakeSessionManager }>({
    sessionManager: async (_deps, use) => {
      const manager = await startFakeSessionManager(desktop)
      try {
        await use(manager)
      } finally {
        manager.stop()
      }
    }
  })
  const linuxTest = process.platform === 'linux' ? logoutTest : logoutTest.skip
  linuxTest(
    `an edit only the page holds survives a ${desktop} logout`,
    async ({ sessionManager, app }) => {
      // Apps of specs in other workers register with the fake too.
      await sessionManager.waitFor('registered', (e) => e.pid === app.pid)
      const edit = `held-${Date.now()}`
      await app.executor.execute('window.__memryE2eHoldEdit(arguments[0])', edit)

      sessionManager.logout(app.pid)
      const over = await sessionManager.waitFor('over')

      expect(['answered', 'disconnected']).toContain(over.reason)
      // GNOME counts a client that has not answered QueryEndSession within a second as blocking
      // the logout.
      const [query, answer] = ['sent', 'answered'].map((event) =>
        sessionManager.events.find((e) => e.event === event)
      )
      expect(query?.signal).toBe('QueryEndSession')
      expect(Number(answer?.ms) - Number(query?.ms)).toBeLessThan(1_000)
      expect(await pollUntil(() => !isAlive(app.pid), { timeoutMs: 10_000, intervalMs: 50 })).toBe(
        true
      )
      expect(readFileSync(join(app.dirs.appDataDir, 'e2e-held-edit.txt'), 'utf8')).toBe(edit)
      expect(readMainLog(app.dirs.logDir)).toContain('cleanup complete')
    }
  )
}
