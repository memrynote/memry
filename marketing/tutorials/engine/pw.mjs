import { chromium } from 'playwright'
export async function connect() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes('renderer/index.html'))
  return { browser, page }
}
