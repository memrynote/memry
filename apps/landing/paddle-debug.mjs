// throwaway diagnostic — delete after use
import { Paddle, Environment } from '@paddle/paddle-node-sdk'
import { readFileSync } from 'node:fs'

const env = {}
for (const line of readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const i = t.indexOf('=')
  if (i === -1) continue
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim()
}

const raw = env.PADDLE_SANDBOX_API_KEY || env.PADDLE_API_KEY || ''
const key = raw
  .replace(/^(['"])(.*)\1$/, '$2')
  .replace(/^(authorization:\s*)?bearer\s+/i, '')
  .trim()

console.log('PADDLE_ENVIRONMENT =', env.PADDLE_ENVIRONMENT)
console.log('key: len', key.length, 'prefix', key.slice(0, 16), 'suffix', key.slice(-4))

const paddle = new Paddle(key, { environment: Environment.sandbox })
const dump = (e) => {
  try {
    return JSON.stringify(e, Object.getOwnPropertyNames(e), 2)
  } catch {
    return String(e)
  }
}
async function probe(label, fn) {
  try {
    const r = await fn()
    console.log(`OK   ${label}`)
    return r
  } catch (e) {
    console.log(`FAIL ${label}\n${dump(e)}`)
  }
}

await probe('products.list (needs product.read)', async () => {
  const page = await paddle.products.list().next()
  console.log('     products returned:', page.length)
})
const priceId = env.PADDLE_PRICE_PLUS_MONTHLY
await probe(`prices.get(${priceId}) (needs price.read)`, () => paddle.prices.get(priceId))
await probe('transactions.create (needs transaction.write)', () =>
  paddle.transactions.create({
    collectionMode: 'automatic',
    items: [{ priceId, quantity: 1 }],
    customData: {
      app: 'memry',
      entitlement: 'sync',
      plan: 'plus',
      cadence: 'monthly',
      userId: 'debug'
    }
  })
)
