import { expect, type Locator, type Page } from '@playwright/test'

export async function openAgentChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Day Panel' }).click()
  await page.getByRole('tab', { name: 'Agent', exact: true }).click()

  const enableButton = page.getByRole('button', { name: 'Enable Agent chat' })
  const agentChat = page.getByRole('region', { name: 'Agent chat' })
  await expect
    .poll(
      async () =>
        (await enableButton.isVisible().catch(() => false)) ||
        (await agentChat.isVisible().catch(() => false)),
      { timeout: 30_000 }
    )
    .toBe(true)

  if (await enableButton.isVisible().catch(() => false)) {
    await enableButton.click()
  }
  await expect(agentChat).toBeVisible()
}

export function getAgentComposer(page: Page): Locator {
  return page.getByRole('textbox', {
    name: 'Ask Memry anything. @ to use mention file'
  })
}

export async function enableManualAgentToolApproval(page: Page): Promise<void> {
  await page.evaluate(() => window.api.agent.setPreferences({ toolApprovalMode: 'ask' }))
}

export async function approveAgentToolCall(page: Page, toolName: string | RegExp): Promise<void> {
  const agentChat = page.getByRole('region', { name: 'Agent chat' })
  const toolCall = agentChat.getByRole('button', { name: toolName })
  await expect(toolCall).toBeVisible({ timeout: 20_000 })
  await toolCall.click()
  await agentChat.getByRole('button', { name: 'Allow once' }).click()
}
