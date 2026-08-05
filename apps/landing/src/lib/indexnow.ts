import { getIndexablePaths, toAbsoluteUrl } from './crawl-files'
import { BASE_URL } from './seo'

// IndexNow key. Public on purpose: ownership is proven by serving this exact
// string at /<key>.txt, so it is not a secret and never belongs in a vault.
// Changing it here changes the file the build emits, so the two cannot drift.
export const INDEXNOW_KEY = '447fc8aee969724993dddaa121890a8e'

export const INDEXNOW_KEY_FILENAME = `${INDEXNOW_KEY}.txt`
export const INDEXNOW_KEY_LOCATION = `${BASE_URL}/${INDEXNOW_KEY_FILENAME}`

// Any participating engine shares the submission with the rest (Bing, Yandex,
// Seznam, Naver, Yep), so one generic endpoint is enough.
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'

export interface IndexNowPayload {
  host: string
  key: string
  keyLocation: string
  urlList: string[]
}

// The key file must contain the key and nothing else — no trailing newline.
export function buildIndexNowKeyFile(): string {
  return INDEXNOW_KEY
}

export function buildIndexNowPayload(
  paths: readonly string[] = getIndexablePaths()
): IndexNowPayload {
  return {
    host: new URL(BASE_URL).host,
    key: INDEXNOW_KEY,
    keyLocation: INDEXNOW_KEY_LOCATION,
    urlList: paths.map(toAbsoluteUrl)
  }
}
