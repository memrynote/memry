// What the sync server stores for one note, as a diagram (diagram.html). The ciphertext is real:
// the note's payload (docs/protocol/13-payload-schemas.md §13.7.1) sealed with XChaCha20-Poly1305
// under a fresh random key, nonce first (04-record-envelope.md §4.3). The columns shown are the
// plaintext ones of sync_items (apps/sync-server/migrations/0001_baseline.sql:162-183); title,
// body, tags and folder live only inside the encrypted payload.
// The page clock runs SLOW times slower than real time and the take plays back SLOW times faster
// (see e2e-explainer), so every time here and every `dur` is film time.
import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import sodium from 'libsodium-wrappers-sumo'

const SLOW = 3
const N = JSON.parse(fs.readFileSync(new URL('narration.json', import.meta.url), 'utf8'))
const NOTE = {
  folder: 'Meetings',
  title: 'Weekly sync with Sam',
  prop: ['tag', 'meeting'],
  body: 'Sam needs the hero assets by Thursday. [[Homepage Ideas]] approved for build.'
}

async function seal(payload) {
  await sodium.ready
  const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen()
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(payload, null, null, nonce, key)
  const bytes = new Uint8Array([...nonce, ...sealed])
  return { bytes: bytes.length, b64: sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL) }
}

let focus = {}

export async function setup({ page }) {
  await page.addStyleTag({ content: '#__tut_cursor { display: none }' })
  const payload = JSON.stringify({
    title: NOTE.title,
    content: NOTE.body,
    tags: ['meeting'],
    folderPath: NOTE.folder
  })
  const { bytes, b64 } = await seal(payload)
  const data = {
    ...NOTE,
    cipher: b64,
    id: `${randomUUID().slice(0, 8)}…`,
    type: 'note',
    size: String(bytes),
    changed: String(Math.floor(Date.now() / 1000)),
    device: `${randomUUID().slice(0, 8)}…`
  }
  focus = await page.evaluate(
    ([slow, data]) => {
      window.SLOW = slow
      window.ss.init(data)
      return Object.fromEntries(
        ['payload', 'top', 'middle', 'note'].map((n) => [n, window.ss.focus(n)])
      )
    },
    [SLOW, data]
  )
}

const steps = {
  async hook({ at, zoom }) {
    await at(0.4)
    zoom(...focus.note, 1.5)
  },
  async send({ page, at, unzoom }) {
    unzoom()
    await at(0.3)
    await page.evaluate(() => window.ss.send())
    await page.evaluate(() => window.ss.fill())
  },
  async meta({ page, at, zoom }) {
    zoom(...focus.top, 1.6)
    await at(0.6)
    for (const f of ['id', 'type', 'size', 'changed', 'device']) {
      await page.evaluate((f) => window.ss.reveal(f), f)
    }
  },
  async never({ page, at, unzoom }) {
    unzoom()
    await at(0.4)
    await page.evaluate(() => window.ss.never())
  }
}

export const scenes = Object.fromEntries(
  N.scenes.map(({ id, dur }, i) => [
    id,
    async (ctx) => {
      if (i === 0) ctx.rec.speed(SLOW)
      const at = (s) => ctx.at(s * SLOW)
      await steps[id]?.({ ...ctx, at, sleep: (ms) => ctx.sleep(ms * SLOW) })
      if (id === 'end') ctx.unzoom()
      await at(dur)
    }
  ])
)
