import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'

test('test-13-stress: 500-char typing latency p95 < 50ms', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('.bn-editor').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  // Pre-fill 500 chars via real typing (warm-up)
  const prefill = 'Lorem ipsum dolor sit amet. '.repeat(18)
  await page.keyboard.type(prefill, { delay: 0 })
  await page.waitForTimeout(300)

  // Measure typing latency for 480 additional chars
  const latencies: number[] = []
  const additional = 'XYZXYZXYZXYZXYZXYZXYZXYZ'.repeat(20)

  for (const ch of additional) {
    const start = Date.now()
    await page.keyboard.type(ch)
    latencies.push(Date.now() - start)
  }

  latencies.sort((a, b) => a - b)
  const p50 = latencies[Math.floor(latencies.length * 0.5)]
  const p95 = latencies[Math.floor(latencies.length * 0.95)]
  console.log(`[test-13] Typing latency p50=${p50}ms p95=${p95}ms (samples=${latencies.length})`)

  writeFileSync(
    '/tmp/s1-test-13-latency.json',
    JSON.stringify({
      p50,
      p95,
      samples: latencies.length,
      threshold_p95_ms: 50,
      all_samples: latencies
    })
  )

  expect(p95).toBeLessThan(50)
})
