// Tells IndexNow (Bing, Yandex, Seznam, Naver, Yep) which pages changed.
// Run after a production deploy, once the new dist is actually live — the
// endpoint fetches the key file over HTTP to verify the submission.
//
//   node --import tsx scripts/indexnow-ping.ts            # every indexable page
//   node --import tsx scripts/indexnow-ping.ts /changelog # just these paths
//   node --import tsx scripts/indexnow-ping.ts --dry-run
import process from 'node:process'

import { buildIndexNowPayload, INDEXNOW_ENDPOINT } from '../src/lib/indexnow.ts'

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const paths = args.filter((arg) => arg.startsWith('/'))

  const payload = buildIndexNowPayload(paths.length > 0 ? paths : undefined)

  console.log(`IndexNow: ${payload.urlList.length} URL(s) for ${payload.host}`)
  for (const url of payload.urlList) {
    console.log(`  ${url}`)
  }

  if (dryRun) {
    console.log('\nDry run — nothing submitted.')
    return
  }

  const response = await fetch(INDEXNOW_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload)
  })

  // 200 accepted, 202 accepted but the key file has not been fetched yet.
  if (response.status === 200 || response.status === 202) {
    console.log(`\nSubmitted (HTTP ${response.status}).`)
    return
  }

  const body = await response.text().catch(() => '')
  throw new Error(`IndexNow rejected the batch: HTTP ${response.status} ${body}`.trim())
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
