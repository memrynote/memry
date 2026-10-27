// The app window remembers its size and position across a restart (inv09#3).
import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { restart } from '../../harness/tauri-lifecycle'

interface E2eWindow {
  label: string
  x: number
  y: number
  width: number
  height: number
}

// The rect fits a 1024x768 display: the OS shrinks a window that does not fit its screen, and
// hosted runners have small displays.
test.use({ keepWindowRect: true })

test('a resized window reopens at its saved size and position', async ({ app }) => {
  await invokeTest(app, 'e2e_set_window_rect', {
    label: 'main',
    x: 20,
    y: 40,
    width: 900,
    height: 600
  })
  // The write is debounced by 1.5 s.
  await new Promise((resolve) => setTimeout(resolve, 2500))

  await restart(app)

  await expect
    .poll(
      async () => {
        const windows = await invokeTest<E2eWindow[]>(app, 'e2e_windows')
        const main = windows.find((window) => window.label === 'main')!
        return [main.width, main.height, main.x, main.y]
      },
      { timeout: 30_000 }
    )
    .toEqual([900, 600, 20, 40])
})
