import { waitForAppReady, createNote } from '../../harness/app-helpers'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const CLICK_BUDGET_MS = 300

/** Replaces the app page with a small form and wires its behavior from the test side. */
async function showFixturePage(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.body.innerHTML = `
      <button id="inc" type="button">Count: 0</button>
      <input id="name" aria-label="Name" placeholder="Your name">
      <p id="hello"></p>
      <div id="hover-target" style="width:120px;height:40px;background:#ddd">Hover me</div>
      <input id="agree" type="checkbox" aria-label="Agree">
      <button id="off" type="button" disabled>Disabled</button>
      <button id="reveal" type="button">Reveal</button>
      <p id="late" hidden>Arrived</p>`
    document.documentElement.removeAttribute('class')
    const count = { value: 0 }
    const el = (id: string) => document.getElementById(id) as HTMLElement
    el('inc').addEventListener('click', () => {
      count.value += 1
      el('inc').textContent = `Count: ${count.value}`
    })
    const input = el('name') as HTMLInputElement
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') el('hello').textContent = `Hello, ${input.value}`
    })
    el('hover-target').addEventListener('mouseover', () => {
      el('hover-target').dataset.hovered = 'yes'
    })
    el('reveal').addEventListener('click', () => el('late').removeAttribute('hidden'))
  })
}

test('the app helpers run against the live app', async ({ page }) => {
  await waitForAppReady(page)
  await createNote(page, 'Harness note')
})

test('click, fill, press, hover and expect polling work on a page inside the app', async ({
  page
}) => {
  await showFixturePage(page)

  const started = Date.now()
  await page.getByRole('button', { name: /Count/ }).click()
  const clickMs = Date.now() - started
  await expect(page.locator('#inc')).toHaveText('Count: 1')
  expect(clickMs).toBeLessThan(CLICK_BUDGET_MS)

  await page.getByLabel('Name').fill('Ada')
  await expect(page.getByPlaceholder('Your name')).toHaveValue('Ada')
  await page.getByLabel('Name').press('Enter')
  await expect(page.locator('#hello')).toHaveText('Hello, Ada')

  await page.locator('#hover-target').hover()
  await expect(page.locator('#hover-target')).toHaveAttribute('data-hovered', 'yes')

  await page.getByLabel('Agree').check()
  await expect(page.getByLabel('Agree')).toBeChecked()

  await expect(page.locator('#off')).toBeDisabled()
  await expect(page.locator('#late')).toBeHidden()
  await page.getByRole('button', { name: 'Reveal' }).click()
  await expect(page.getByText('Arrived')).toBeVisible()
  await expect(page.locator('button')).toHaveCount(3)
  await expect.poll(() => page.locator('#inc').textContent()).toBe('Count: 1')
})

test('keyboard and mouse reach the page like Playwright', async ({ page }) => {
  await showFixturePage(page)
  await page.locator('#name').click()
  await page.keyboard.type('Grace')
  await page.keyboard.press('Enter')
  await expect(page.locator('#hello')).toHaveText('Hello, Grace')

  const box = await page.locator('#inc').boundingBox()
  expect(box).toBeTruthy()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await expect(page.locator('#inc')).toHaveText('Count: 1')
})
