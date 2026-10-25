// The timing budgets of apps/desktop/config/playwright.config.ts, shared by the wdio configs and
// the pw-compat polling.
const isCi = process.env.CI === 'true' || process.env.CI === '1'

export const TEST_TIMEOUT_MS = isCi ? 180_000 : 60_000
/** `expect` polling and every action's actionability wait. */
export const EXPECT_TIMEOUT_MS = isCi ? 60_000 : 20_000
export const GRACEFUL_CLOSE_MS = 8_000
export const IS_CI = isCi
