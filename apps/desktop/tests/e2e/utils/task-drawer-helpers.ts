import { expect, type Locator, type Page } from '@playwright/test'

/**
 * The open task detail drawer, and nothing else.
 *
 * The drawer used to stay mounted when closed, behind `inert`, `aria-hidden`
 * and `width: 0`. A 1px border kept its box non-empty, so Playwright reported
 * it visible in both states and every `state: 'visible'` / `state: 'hidden'`
 * wait on it passed without proving anything (#1931). It now unmounts on close
 * and names its open state outright, so "closed" is a count of zero.
 *
 * Go through these helpers rather than rebuilding the locator in a spec. A bare
 * `[aria-label="Task details"]` invites the visibility wait straight back.
 */
const OPEN_TASK_DRAWER = 'aside[aria-label="Task details"][data-state="open"]'

/** By substring: a past-due row carries extra text after the title. */
export function taskRow(page: Page, titleFragment: string): Locator {
  return page
    .locator(`[role="button"][aria-label*="Task:"][aria-label*="${titleFragment}"]`)
    .first()
}

/**
 * Opens the row's drawer and returns it, scoped. `today-task-row.tsx` renders
 * the same interactive due-date and project badges inside list rows, so an
 * unscoped `Due: …` or `Project: …` locator can match several buttons.
 */
export async function openTaskDrawer(
  page: Page,
  titleFragment: string,
  timeout = 15_000
): Promise<Locator> {
  await taskRow(page, titleFragment).click()
  const drawer = page.locator(OPEN_TASK_DRAWER).first()
  await expect(drawer).toBeAttached({ timeout })
  return drawer
}

export async function expectTaskDrawerClosed(page: Page, timeout = 10_000): Promise<void> {
  await expect(page.locator(OPEN_TASK_DRAWER)).toHaveCount(0, { timeout })
}

export async function closeTaskDrawer(page: Page, timeout = 10_000): Promise<void> {
  await page.getByRole('button', { name: 'Close task details' }).click()
  await expectTaskDrawerClosed(page, timeout)
}
