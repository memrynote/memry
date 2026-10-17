import { chromium } from 'playwright'
// agent-app.mjs reads the same variable, so a second app can run beside the first on its own port.
export async function connect() {
  const port = process.env.MEMRY_AGENT_CDP_PORT ?? 9222
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes('renderer/index.html'))
  return { browser, page }
}
