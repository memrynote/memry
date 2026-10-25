import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'

interface E2eWindow {
  label: string
  visible: boolean
  width: number
  height: number
}

test('lists exactly the visible main window', async ({ app }) => {
  const windows = await invokeTest<E2eWindow[]>(app, 'e2e_windows')
  expect(windows.map((window) => window.label)).toEqual(['main'])
  expect(windows[0].visible).toBe(true)
})

test('a window rect set through e2e_set_window_rect reaches the renderer', async ({
  app,
  page
}) => {
  await invokeTest(app, 'e2e_set_window_rect', {
    label: 'main',
    x: 0,
    y: 0,
    width: 900,
    height: 600
  })

  // The native frame is exactly the rect. The page is as wide, and as tall minus a native title
  // bar (32 px on macOS), so the height only has an upper bound and a bar-sized margin.
  await expect
    .poll(async () => {
      const [main] = await invokeTest<E2eWindow[]>(app, 'e2e_windows')
      const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight])
      return (
        Math.abs(main.width - 900) <= 2 &&
        Math.abs(main.height - 600) <= 2 &&
        Math.abs(width - 900) <= 2 &&
        height <= 602 &&
        height >= 600 - 60
      )
    })
    .toBe(true)
})
