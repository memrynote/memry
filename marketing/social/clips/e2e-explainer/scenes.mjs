// End-to-end encryption as a diagram (diagram.html). A line typed on Maya's laptop is sealed there
// with XChaCha20-Poly1305 (docs/protocol/04-record-envelope.md:123-146) under a key the server
// never gets (01-identity-and-keys.md:222-226); the sealed copy crosses to the sync server, which
// stores it without a key; her phone, which holds the key, opens it. The ciphertext on screen is
// real: the line encrypted here with libsodium under a fresh random key, nonce first.
//
// A busy machine screencasts the page at about 15 fps, and motion at 15 fps judders. So the page
// clock runs SLOW times slower than real time and the take plays back SLOW times faster
// (rec.speed): 45 fps of film. Every time here, and every `dur` in narration.json, is film time.
import * as fs from 'node:fs'
import sodium from 'libsodium-wrappers-sumo'

const SLOW = 3
const N = JSON.parse(fs.readFileSync(new URL('narration.json', import.meta.url), 'utf8'))
const LINE = "Nervous about Friday's pitch."
// Other items already on the server; only their ciphertext is ever on screen.
const OTHERS = ['Lisbon in May?', 'Call Lea about the brand workshop', 'Book tram 28 tickets']

async function encrypt(text) {
  // oxlint-disable-next-line import/no-named-as-default-member -- libsodium populates its named exports only after `ready`; the default export is the instance the tests mock
  await sodium.ready
  const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen()
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(text, null, null, nonce, key)
  // oxlint-disable-next-line import/no-named-as-default-member -- libsodium populates its named exports only after `ready`; the default export is the instance the tests mock
  return sodium.to_base64(new Uint8Array([...nonce, ...sealed]), sodium.base64_variants.ORIGINAL)
}

// Page px of each station's centre, from the page (it scales its stage to the frame).
let stations = {}

export async function setup({ page }) {
  await page.addStyleTag({ content: '#__tut_cursor { display: none }' })
  const sealed = await encrypt(LINE)
  const others = await Promise.all(OTHERS.map(encrypt))
  stations = await page.evaluate(
    ([slow, line, sealedText, otherItems]) => {
      window.SLOW = slow
      window.e2e.init(line, sealedText, otherItems)
      return Object.fromEntries(['laptop', 'server', 'phone'].map((n) => [n, window.e2e.focus(n)]))
    },
    [SLOW, LINE, sealed, others]
  )
}

const LAPTOP = () => [...stations.laptop, 1.7]
const SERVER = () => [...stations.server, 1.8]
const PHONE = () => [...stations.phone, 1.8]

const steps = {
  async hook({ page, at, zoom }) {
    await at(0.4)
    const typing = page.evaluate(() => window.e2e.type(12))
    await at(1.6)
    zoom(...LAPTOP())
    await typing
  },
  async seal({ page, at }) {
    await at(0.3)
    await page.evaluate(() => window.e2e.seal())
  },
  async travel({ page, at, unzoom }) {
    unzoom()
    await at(0.5)
    await page.evaluate(() => window.e2e.send())
  },
  async server({ page, at, zoom }) {
    zoom(...SERVER())
    await at(0.9)
    await page.evaluate(() => window.e2e.noKey())
  },
  async phone({ page, at, zoom, unzoom }) {
    unzoom()
    await at(0.5)
    const flight = page.evaluate(() => window.e2e.deliver())
    await at(1.7)
    zoom(...PHONE())
    await flight
    await at(2.6)
    await page.evaluate(() => window.e2e.unlock())
  },
  async end({ unzoom }) {
    unzoom()
  }
}

// Each scene in film time: `at` and `sleep` scaled by SLOW, and the scene held for its `dur`.
export const scenes = Object.fromEntries(
  N.scenes.map(({ id, dur }, i) => [
    id,
    async (ctx) => {
      if (i === 0) ctx.rec.speed(SLOW)
      const at = (s) => ctx.at(s * SLOW)
      await steps[id]?.({ ...ctx, at, sleep: (ms) => ctx.sleep(ms * SLOW) })
      await at(dur)
    }
  ])
)
