// The macOS traffic lights sit where Electron put them (inv09 #5, Electron's
// `trafficLightPosition: { x: 12, y: 12 }`): the close button's frame at (12, 12) points from the
// window's top-left corner, the other two beside it on the same row.
import { appReady } from '../../harness/app-ready'
import { invokeTest } from '../../harness/invoke-test'
import { test, expect } from '../../harness/test'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const tops = (rects: Rect[]) => rects.map((rect) => rect.y)

test('macOS: the close button sits at (12, 12), and stays there after a resize', async ({
  app,
  page
}) => {
  test.skip(process.platform !== 'darwin', 'only macOS draws native traffic lights')
  await appReady(page)
  const lights = () => invokeTest<Rect[]>(app, 'e2e_traffic_lights')

  const [close] = await lights()
  expect({ x: close.x, y: close.y }).toEqual({ x: 12, y: 12 })
  expect(tops(await lights())).toEqual([12, 12, 12])

  // AppKit lays the title bar out again on a resize, and the inset is applied again after it.
  await invokeTest(app, 'e2e_set_window_rect', {
    label: 'main',
    x: 120,
    y: 120,
    width: 1100,
    height: 760
  })
  await expect.poll(async () => tops(await lights())).toEqual([12, 12, 12])
  expect((await lights())[0].x).toBe(12)
})
