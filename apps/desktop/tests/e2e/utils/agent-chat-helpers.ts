import { expect, type Locator, type Page } from '@playwright/test'

import { ensureDayPanelOpen } from './electron-helpers'

const AGENT_CHAT_OPEN_TIMEOUT_MS = process.env.CI ? 60_000 : 30_000

export async function openAgentChat(page: Page): Promise<void> {
  await ensureDayPanelOpen(page)

  const agentTab = page.getByRole('tab', { name: 'Agent', exact: true })
  const enableButton = page.getByRole('button', { name: 'Enable Agent chat' })
  const agentChat = page.getByRole('region', { name: 'Agent chat' })
  await expect
    .poll(
      async () => {
        await agentTab.click().catch(() => {})
        return (
          (await enableButton.isVisible().catch(() => false)) ||
          (await agentChat.isVisible().catch(() => false))
        )
      },
      { timeout: AGENT_CHAT_OPEN_TIMEOUT_MS }
    )
    .toBe(true)

  if (await enableButton.isVisible().catch(() => false)) {
    await enableButton.click()
  }
  await expect(agentChat).toBeVisible()
}

export function getAgentComposer(page: Page): Locator {
  return page.getByTestId('agent-composer-input')
}

/** Opens the model menu. Its label carries the provider and model names, both product copy. */
export function getAgentModelTrigger(page: Page): Locator {
  return page.getByTestId('agent-model-trigger')
}

/**
 * Pick a model from the composer's settings menu.
 *
 * Three steps rather than one now: the model and reasoning controls moved out of
 * the composer row into a settings menu, and the model list behind it became
 * searchable. The search box is what makes the click unambiguous — the open list
 * carries every provider's models at once, so a bare name can match more than
 * one row.
 */
export async function selectAgentModel(
  page: Page,
  query: string,
  name: RegExp | string
): Promise<void> {
  await getAgentModelTrigger(page).click()
  await page.getByTestId('agent-model-submenu-trigger').click()
  await page.getByRole('textbox', { name: /search models/i }).fill(query)
  await page.getByRole('menuitem', { name }).first().click()
}

export async function enableManualAgentToolApproval(page: Page): Promise<void> {
  await page.evaluate(() => window.api.agent.setPreferences({ toolApprovalMode: 'ask' }))
}

export async function approveAgentToolCall(page: Page, toolName: string | RegExp): Promise<void> {
  const agentChat = page.getByRole('region', { name: 'Agent chat' })
  // Scoped to the individual call: once a turn makes two or more tool calls
  // they collapse under a group summary row that repeats the same label and
  // status, which would otherwise make this locator ambiguous.
  const toolCall = agentChat
    .getByTestId('agent-tool-call')
    .and(agentChat.getByRole('button', { name: toolName }))
  await expect(toolCall).toBeVisible({ timeout: 20_000 })
  await toolCall.click()
  await agentChat.getByRole('button', { name: 'Allow once' }).click()
}
