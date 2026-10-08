import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OcrLanguage } from '@memry/contracts/ocr-languages-api'

const DATA = vi.hoisted(() => ({ deu: 'German model bytes', fra: 'French model bytes' }))

const env = vi.hoisted(() => ({
  userData: '',
  locale: 'en',
  stored: null as OcrLanguage[] | null,
  answer: (_url: string): Promise<Response> => Promise.reject(new Error('offline'))
}))
const fetches = vi.hoisted(() => [] as string[])

vi.mock('electron', () => ({
  app: { getPath: () => env.userData },
  net: {
    fetch: (url: string) => {
      fetches.push(url)
      return env.answer(url)
    }
  }
}))
vi.mock('../lib/main-i18n', () => ({
  getMainI18n: () => ({ language: env.locale, on: () => {} })
}))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('@memry/sync-client/sync-server-url', () => ({
  resolveSyncServerUrl: () => 'https://sync.memry.test'
}))
vi.mock('../store', () => ({
  getStoredOcrLanguages: () => env.stored,
  setStoredOcrLanguages: (languages: OcrLanguage[]) => {
    env.stored = languages
  }
}))
vi.mock('./ocr-language-data', async () => {
  const { createHash } = await import('crypto')
  const pin = (text: string) => ({
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex')
  })
  return { OCR_LANGUAGE_DATA: { deu: pin(DATA.deu), fra: pin(DATA.fra) } }
})

type Module = typeof import('./ocr-languages')
let ocr: Module

const serve = (bodies: Partial<Record<string, string>>) => (url: string) => {
  const lang = path.basename(url).split('.')[0]
  const body = bodies[lang]
  return body === undefined
    ? Promise.reject(new TypeError('net::ERR_CONNECTION_REFUSED'))
    : Promise.resolve(new Response(body))
}

const codes = () => ocr.ocrLanguageSet().codes
const dataFiles = () => fs.readdirSync(path.join(env.userData, 'ocr-languages')).sort()

describe('OCR languages', () => {
  beforeEach(async () => {
    env.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-ocr-languages-'))
    env.locale = 'en'
    env.stored = null
    env.answer = serve(DATA)
    fetches.length = 0
    vi.resetModules()
    ocr = await import('./ocr-languages')
  })

  afterEach(() => {
    fs.rmSync(env.userData, { recursive: true, force: true })
  })

  it('chooses the app language plus English until the user chooses, English alone for English', async () => {
    expect(ocr.getOcrLanguagesState().selected).toEqual(['eng'])

    env.locale = 'de'
    expect(ocr.getOcrLanguagesState().selected).toEqual(['eng', 'deu'])
    await ocr.syncOcrLanguages()

    expect(codes()).toEqual(['eng', 'deu'])
    expect(fetches).toEqual(['https://sync.memry.test/ocr/v1/deu.traineddata.gz'])
  })

  it('reads with a chosen language once its download matches the pinned sha256', async () => {
    const changed = vi.fn()
    ocr.onActiveOcrLanguagesChanged(changed)

    ocr.setOcrLanguages(['deu'])
    await ocr.syncOcrLanguages()

    expect(ocr.getOcrLanguagesState()).toEqual({
      selected: ['eng', 'deu'],
      statuses: { eng: { state: 'ready' }, deu: { state: 'ready' } }
    })
    expect(codes()).toEqual(['eng', 'deu'])
    expect(
      fs.readFileSync(path.join(ocr.ocrLanguageSet().downloadDir, 'deu.traineddata'), 'utf8')
    ).toBe(DATA.deu)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('never keeps a download whose sha256 differs from the pinned one', async () => {
    env.answer = serve({ deu: DATA.deu.replace('G', 'X') })

    ocr.setOcrLanguages(['eng', 'deu'])
    await ocr.syncOcrLanguages()

    expect(ocr.getOcrLanguagesState().statuses.deu).toEqual({
      state: 'failed',
      error: 'errors:ocrLanguages.corrupt'
    })
    expect(codes()).toEqual(['eng'])
    expect(dataFiles()).toEqual([])
  })

  it('keeps reading with the languages it has when a download fails, and retries when asked', async () => {
    env.answer = serve({ deu: DATA.deu })

    ocr.setOcrLanguages(['deu', 'fra'])
    await ocr.syncOcrLanguages()

    expect(ocr.getOcrLanguagesState().statuses.fra).toEqual({
      state: 'failed',
      error: 'errors:ocrLanguages.unreachable'
    })
    expect(codes()).toEqual(['eng', 'deu'])

    env.answer = serve(DATA)
    await ocr.syncOcrLanguages()
    expect(codes()).toEqual(['eng', 'deu'])

    ocr.retryOcrLanguages()
    await ocr.syncOcrLanguages()
    expect(codes()).toEqual(['eng', 'deu', 'fra'])
    expect(fetches.filter((url) => url.endsWith('/fra.traineddata.gz'))).toHaveLength(2)
  })

  it('deletes a removed language and does not download it again', async () => {
    ocr.setOcrLanguages(['deu'])
    await ocr.syncOcrLanguages()
    const changed = vi.fn()
    ocr.onActiveOcrLanguagesChanged(changed)

    ocr.setOcrLanguages(['eng'])
    await ocr.syncOcrLanguages()

    expect(codes()).toEqual(['eng'])
    expect(dataFiles()).toEqual([])
    expect(fetches).toHaveLength(1)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('finds a language downloaded in an earlier run without fetching it again', async () => {
    ocr.setOcrLanguages(['deu'])
    await ocr.syncOcrLanguages()

    vi.resetModules()
    ocr = await import('./ocr-languages')
    await ocr.syncOcrLanguages()

    expect(codes()).toEqual(['eng', 'deu'])
    expect(fetches).toHaveLength(1)
  })
})
