import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NotInSubset, wrapPage } from './wd-page.mjs'

/** A PwBrowser that records what the page sends and answers every script with null. */
function fakeBrowser() {
  const sent = { actions: [], scripts: [] }
  return {
    sent,
    execute: async (script, ...args) => {
      sent.scripts.push({ script, args })
      return null
    },
    executeAsync: async (script, ...args) => {
      sent.scripts.push({ script, args })
      return { ok: true, undef: true, value: null }
    },
    performActions: async (actions) => {
      sent.actions.push(actions)
    },
    releaseActions: async () => {},
    takeScreenshot: async () => '',
    getUrl: async () => 'tauri://localhost/',
    getTitle: async () => ''
  }
}

test('a call outside the subset throws NotInSubset naming the call', () => {
  const page = wrapPage(fakeBrowser())
  assert.throws(
    () => page.context(),
    (error) => error instanceof NotInSubset && error.message === 'NotInSubset: page.context'
  )
  assert.throws(() => page.keyboard.sendCharacter, /NotInSubset: page\.keyboard\.sendCharacter/)
  assert.throws(() => page.mouse.dblclick, /NotInSubset: page\.mouse\.dblclick/)
  // pw-compat implements these, but no scene uses them, so they stay outside the subset.
  assert.throws(() => page.reload, /NotInSubset: page\.reload/)
  const button = page.getByRole('button', { name: 'Save' }).first()
  assert.throws(() => button.selectOption, /NotInSubset: locator\.selectOption/)
  assert.throws(() => button.dragTo, /NotInSubset: locator\.dragTo/)
})

test('locators chain through the guard and can be awaited from an async function', async () => {
  const page = wrapPage(fakeBrowser())
  const locator = page.locator('.row').filter({ hasText: 'Inbox' }).nth(2).getByText('Open')
  assert.equal(typeof locator.click, 'function')
  assert.match(String(locator), /locator\("\.row"\)\.filter\(\{ hasText: "Inbox" \}\)\.nth\(2\)/)
  // A promise that resolves to a locator reads its `then`; that must not throw.
  const resolved = await (async () => page.getByTestId('save'))()
  assert.equal(typeof resolved.waitFor, 'function')
})

test('pointer and key input are W3C actions in viewport CSS px', async () => {
  const browser = fakeBrowser()
  const page = wrapPage(browser)
  await page.mouse.move(10.4, 20.6)
  await page.mouse.down()
  await page.mouse.up()
  await page.mouse.wheel(0, 120)
  await page.keyboard.press('Shift+Enter')
  const [move, down, up, wheel, key] = browser.sent.actions
  assert.deepEqual(move, [
    {
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions: [{ type: 'pointerMove', x: 10, y: 21, origin: 'viewport' }]
    }
  ])
  assert.deepEqual(down[0].actions, [{ type: 'pointerDown', button: 0 }])
  assert.deepEqual(up[0].actions, [{ type: 'pointerUp', button: 0 }])
  assert.deepEqual(wheel, [
    {
      type: 'wheel',
      id: 'wheel',
      actions: [
        { type: 'scroll', x: 10, y: 21, deltaX: 0, deltaY: 120, duration: 0, origin: 'viewport' }
      ]
    }
  ])
  assert.deepEqual(key, [
    {
      type: 'key',
      id: 'keyboard',
      actions: [
        { type: 'keyDown', value: '\uE008' },
        { type: 'keyDown', value: '\uE007' },
        { type: 'keyUp', value: '\uE007' },
        { type: 'keyUp', value: '\uE008' }
      ]
    }
  ])
})

test('mouse.move with steps moves in even steps from the last position', async () => {
  const browser = fakeBrowser()
  const page = wrapPage(browser)
  await page.mouse.move(0, 0)
  await page.mouse.move(100, 50, { steps: 4 })
  const points = browser.sent.actions.map(([source]) => [source.actions[0].x, source.actions[0].y])
  assert.deepEqual(points, [
    [0, 0],
    [25, 13],
    [50, 25],
    [75, 38],
    [100, 50]
  ])
})

test('addStyleTag and goto run in the page', async () => {
  const browser = fakeBrowser()
  // The second probe sees a new document.
  let probes = 0
  browser.execute = async (script, ...args) => {
    browser.sent.scripts.push({ script, args })
    return script.includes('readyState') ? ++probes > 1 : null
  }
  const page = wrapPage(browser)
  await page.addStyleTag({ content: '#__tut_cursor { display: none }' })
  assert.ok(
    browser.sent.scripts.some(
      ({ script, args }) =>
        script.includes('createElement') && args[1] === '#__tut_cursor { display: none }'
    )
  )
  await page.goto('https://example.com/')
  assert.ok(
    browser.sent.scripts.some(
      ({ script, args }) => script.includes('location.assign') && args[1] === 'https://example.com/'
    )
  )
  assert.equal(probes, 2)
  await assert.rejects(
    page.addStyleTag({ url: 'x.css' }),
    /NotInSubset: page\.addStyleTag without content/
  )
})

test('arguments pw-compat would ignore or misread throw NotInSubset', () => {
  const page = wrapPage(fakeBrowser())
  assert.throws(
    () => page.getByRole('row').filter({ has: page.locator('b') }),
    /NotInSubset: locator\.filter\(\{ has \}\)/
  )
  assert.throws(
    () => page.locator('xpath=self::*'),
    /NotInSubset: page\.locator\("xpath=self::\*"\)/
  )
  assert.throws(() => page.locator('div >> text=Save'), /NotInSubset/)
  assert.throws(
    () => page.locator('span.chip', { hasText: 'x' }),
    /NotInSubset: page\.locator\("span\.chip", options\)/
  )
  assert.throws(
    () => page.getByRole('checkbox', { checked: true }),
    /NotInSubset: page\.getByRole\(\{ checked \}\)/
  )
  assert.throws(() => page.getByText('x', { includeHidden: true }), /NotInSubset/)
  // pw-compat's CSS adds these three.
  assert.equal(typeof page.locator('button:has-text("Save"):visible').first().click, 'function')
  assert.equal(typeof page.locator('li:has(> b)').filter({ hasText: 'x' }).click, 'function')
})
