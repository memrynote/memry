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

// Windows and Linux draw classic scrollbars, so a page taller than its frame shows one beside
// the player.
test('the YouTube embed page fits its frame without scrolling', async ({ page }) => {
  await appReady(page)
  const shell = await page.evaluate(() => window.__MEMRY_SHELL__)
  const src = `${shell!.loopbackOrigin}/e/${shell!.loopbackToken}/youtube/dQw4w9WgXcQ`
  // The page refuses a fetch from the app's origin, so the runner reads it. The player is
  // swapped for a blank frame: the layout does not depend on what loads in it.
  const html = (await (await fetch(src)).text()).replace(/src="https:[^"]*"/, 'src="about:blank"')
  // The page in a same-origin frame of the player's size, so its layout is readable.
  const [scrollHeight, clientHeight] = await page.evaluate(async (markup) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-same-origin')
    frame.style.cssText = 'position:fixed;left:0;top:0;width:480px;height:270px;border:0'
    frame.srcdoc = markup
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }))
    document.body.append(frame)
    await loaded
    const root = frame.contentDocument!.documentElement
    const size = [root.scrollHeight, root.clientHeight]
    frame.remove()
    return size
  }, html)
  expect(scrollHeight).toBe(clientHeight)
})
