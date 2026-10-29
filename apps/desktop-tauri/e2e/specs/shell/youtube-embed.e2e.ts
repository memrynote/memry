// The YouTube embed page served from the loopback server (inv09 #47 #48).
import { appReady } from '../../harness/app-ready'
import { invokeTest } from '../../harness/invoke-test'
import { test, expect } from '../../harness/test'

test('the YouTube embed page loads in the app and its player is not sent to the browser', async ({
  app,
  page
}) => {
  await appReady(page)
  const shell = await page.evaluate(() => window.__MEMRY_SHELL__)
  const src = `${shell!.loopbackOrigin}/e/${shell!.loopbackToken}/youtube/dQw4w9WgXcQ`
  // The page nests the player, so a loaded page has one subframe; the count is readable across
  // origins.
  const frames = await page.evaluate(
    (url) =>
      new Promise<number>((resolve) => {
        const frame = document.createElement('iframe')
        frame.src = url
        document.body.append(frame)
        const started = Date.now()
        const poll = setInterval(() => {
          const count = frame.contentWindow?.length ?? 0
          if (count > 0 || Date.now() - started > 15000) {
            clearInterval(poll)
            resolve(count)
          }
        }, 100)
      }),
    src
  )
  expect(frames).toBe(1)
  expect(await invokeTest<string[]>(app, 'e2e_os_opens')).toEqual([])
})
