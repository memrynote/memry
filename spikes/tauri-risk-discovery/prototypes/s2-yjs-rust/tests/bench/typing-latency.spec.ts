import { test } from '@playwright/test'
import { writeFileSync } from 'node:fs'

// S2 Test 6 (Proto B): typing latency measurement.
//
// LIMITATION: runs against Vite HMR only (no Tauri runtime), so Rust IPC cost
// is NOT captured. What this measures is the renderer-side overhead of
// shadow Y.Doc + event listener handlers. Real B latency requires manual
// measurement via `pnpm tauri dev`.

test('s2-typing-latency-B: 500-char per-keystroke latency', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('.bn-editor')
  await editor.waitFor({ timeout: 10000 })
  await editor.click()

  const latencies: number[] = []
  const text = 'XYZXYZXYZXYZXYZXYZXYZXYZ'.repeat(21)

  for (const ch of text) {
    const start = performance.now()
    await page.keyboard.type(ch)
    latencies.push(performance.now() - start)
  }

  latencies.sort((a, b) => a - b)
  const p50 = latencies[Math.floor(latencies.length * 0.5)]
  const p95 = latencies[Math.floor(latencies.length * 0.95)]
  const min = latencies[0]
  const max = latencies[latencies.length - 1]

  const payload = {
    prototype: 'B',
    test: 'typing-latency',
    harness: 'playwright-webkit-vite-only',
    note: 'No Tauri runtime; Rust IPC not measured.',
    samples: latencies.length,
    p50,
    p95,
    min,
    max,
    unit: 'ms'
  }

  writeFileSync('/tmp/s2-B-typing-latency.json', JSON.stringify(payload, null, 2))
  console.log(`[s2-B-typing] p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`)
})
