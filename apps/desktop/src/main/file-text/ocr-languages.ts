/**
 * The OCR languages of this machine: which ones the user chose, and their data.
 *
 * English ships in out/main/tessdata. Every other language is downloaded from
 * the sync server on demand into userData/ocr-languages, never synced. OCR
 * reads a downloaded file only once its sha256 matched the one this build pins
 * (ocr-language-data.ts) in this run: right after the download, or when the
 * first pass of a run checks the file an earlier run left.
 *
 * `syncOcrLanguages` converges the folder on the choice: it deletes data of
 * languages no longer chosen and downloads the chosen ones it lacks, one at a
 * time. A failed download stays failed until the next app start or a retry.
 */
import { app, net } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import { mkdir, open, readdir, rename, rm } from 'fs/promises'
import path from 'path'
import { LocaleSchema } from '@memry/contracts/locale-api'
import {
  BUNDLED_OCR_LANGUAGE,
  OCR_LANGUAGE_BY_LOCALE,
  OcrLanguagesChannels,
  type OcrLanguage,
  type OcrLanguageStatus,
  type OcrLanguagesState
} from '@memry/contracts/ocr-languages-api'
import { resolveSyncServerUrl } from '@memry/sync-client/sync-server-url'
import { createLogger } from '../lib/logger'
import { getMainI18n } from '../lib/main-i18n'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { getStoredOcrLanguages, setStoredOcrLanguages } from '../store'
import { OCR_LANGUAGE_DATA } from './ocr-language-data'
import type { OcrLanguageSet } from './ocr-protocol'

const logger = createLogger('OcrLanguages')

type DownloadedLanguage = keyof typeof OCR_LANGUAGE_DATA

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const PROGRESS_INTERVAL_MS = 250
const READY: OcrLanguageStatus = { state: 'ready' }

/** Display text or an `errors:` key the settings row shows. */
class OcrLanguageDownloadError extends Error {}

/** Languages whose file matched its pinned sha256 in this run. */
const verified = new Set<DownloadedLanguage>()
/** Languages whose download ran this run and is not ready: downloading or failed. */
const statuses = new Map<DownloadedLanguage, OcrLanguageStatus>()
const listeners = new Set<() => void>()
let running: Promise<void> | null = null
let rerun = false
let download: { lang: DownloadedLanguage; controller: AbortController } | null = null
let lastProgressAt = 0

/** asar-unpacked in a packaged build: Tesseract reads it with plain fs. */
function bundledDir(): string {
  return path.join(__dirname, 'tessdata').replace('app.asar', 'app.asar.unpacked')
}

function dataDir(): string {
  return path.join(app.getPath('userData'), 'ocr-languages')
}

/** The name tesseract.js looks up in its cachePath; the bytes stay gzipped. */
function dataFileName(lang: DownloadedLanguage): string {
  return `${lang}.traineddata`
}

const isDownloaded = (lang: OcrLanguage): lang is DownloadedLanguage =>
  lang !== BUNDLED_OCR_LANGUAGE

/** English first, then the user's choice, or the app language until they choose. */
function selectedLanguages(): OcrLanguage[] {
  const locale = LocaleSchema.safeParse(getMainI18n().language)
  const chosen = getStoredOcrLanguages() ?? [
    OCR_LANGUAGE_BY_LOCALE[locale.success ? locale.data : 'en']
  ]
  return [...new Set<OcrLanguage>([BUNDLED_OCR_LANGUAGE, ...chosen])]
}

function statusOf(lang: OcrLanguage): OcrLanguageStatus {
  if (!isDownloaded(lang)) return READY
  if (verified.has(lang)) return READY
  return (
    statuses.get(lang) ?? {
      state: 'downloading',
      receivedBytes: 0,
      totalBytes: OCR_LANGUAGE_DATA[lang].bytes
    }
  )
}

/** What OCR reads with now: English and every chosen language whose data checked out. */
export function ocrLanguageSet(): OcrLanguageSet {
  return {
    codes: selectedLanguages().filter((lang) => statusOf(lang).state === 'ready'),
    bundledDir: bundledDir(),
    downloadDir: dataDir()
  }
}

export function getOcrLanguagesState(): OcrLanguagesState {
  const selected = selectedLanguages()
  return { selected, statuses: Object.fromEntries(selected.map((lang) => [lang, statusOf(lang)])) }
}

/** Called when the languages OCR reads with change. */
export function onActiveOcrLanguagesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const activeKey = (): string => ocrLanguageSet().codes.join('+')

/** Apply a change, tell the windows, and tell OCR when its languages moved. */
function publish(change: () => void = () => {}): void {
  const before = activeKey()
  change()
  broadcastToAllWindows(OcrLanguagesChannels.events.CHANGED, getOcrLanguagesState())
  if (activeKey() === before) return
  for (const listener of listeners) listener()
}

function setStatus(lang: DownloadedLanguage, status: OcrLanguageStatus | null): void {
  publish(() => {
    if (status) statuses.set(lang, status)
    else statuses.delete(lang)
  })
}

export function setOcrLanguages(languages: OcrLanguage[]): OcrLanguagesState {
  publish(() =>
    setStoredOcrLanguages([...new Set<OcrLanguage>([BUNDLED_OCR_LANGUAGE, ...languages])])
  )
  if (download && !selectedLanguages().includes(download.lang)) download.controller.abort()
  void syncOcrLanguages()
  return getOcrLanguagesState()
}

export function retryOcrLanguages(): OcrLanguagesState {
  for (const [lang, status] of statuses) {
    if (status.state === 'failed') statuses.delete(lang)
  }
  void syncOcrLanguages()
  return getOcrLanguagesState()
}

/** Start converging, or converge once more after the pass in progress. Never rejects. */
export function syncOcrLanguages(): Promise<void> {
  if (running) {
    rerun = true
    return running
  }
  running = (async () => {
    do {
      rerun = false
      await reconcile().catch((error: unknown) =>
        logger.warn('OCR language pass failed', { error: errorText(error) })
      )
    } while (rerun)
  })().finally(() => {
    running = null
  })
  return running
}

/** Download what the app language needs at start, and again when the app language changes. */
export function startOcrLanguages(): void {
  getMainI18n().on('languageChanged', () => {
    publish()
    void syncOcrLanguages()
  })
  void syncOcrLanguages()
}

async function reconcile(): Promise<void> {
  const selected = selectedLanguages()
  const keep = new Set(selected.filter(isDownloaded).map(dataFileName))
  const names = await readdir(dataDir()).catch(() => [] as string[])
  for (const name of names) {
    if (!keep.has(name)) await rm(path.join(dataDir(), name), { force: true })
  }
  for (const lang of new Set([...verified, ...statuses.keys()])) {
    if (selected.includes(lang)) continue
    publish(() => {
      verified.delete(lang)
      statuses.delete(lang)
    })
  }

  for (const lang of selected) {
    if (!isDownloaded(lang) || statusOf(lang).state !== 'downloading') continue
    if (!selectedLanguages().includes(lang)) continue
    if (names.includes(dataFileName(lang)) && (await matchesPin(lang))) {
      publish(() => verified.add(lang))
      continue
    }
    await downloadLanguage(lang)
  }
}

async function matchesPin(lang: DownloadedLanguage): Promise<boolean> {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path.join(dataDir(), dataFileName(lang)))) {
      hash.update(chunk)
    }
  } catch (error) {
    logger.warn('Could not read OCR language data', { lang, error: errorText(error) })
    return false
  }
  return hash.digest('hex') === OCR_LANGUAGE_DATA[lang].sha256
}

async function downloadLanguage(lang: DownloadedLanguage): Promise<void> {
  const controller = new AbortController()
  download = { lang, controller }
  try {
    await fetchVerified(lang, controller.signal)
    publish(() => {
      verified.add(lang)
      statuses.delete(lang)
    })
    logger.info('OCR language downloaded', { lang })
  } catch (error) {
    if (controller.signal.aborted) {
      setStatus(lang, null)
      return
    }
    logger.warn('OCR language download failed', { lang, error: errorText(error) })
    const message =
      error instanceof OcrLanguageDownloadError ? error.message : 'errors:ocrLanguages.saveFailed'
    setStatus(lang, { state: 'failed', error: message })
  } finally {
    download = null
  }
}

/** Stream into a temp file, check size and sha256, then move it under its final name. */
async function fetchVerified(lang: DownloadedLanguage, signal: AbortSignal): Promise<void> {
  const { bytes, sha256 } = OCR_LANGUAGE_DATA[lang]
  setStatus(lang, { state: 'downloading', receivedBytes: 0, totalBytes: bytes })
  let response: Response
  try {
    response = await net.fetch(`${resolveSyncServerUrl()}/ocr/v1/${lang}.traineddata.gz`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
    })
  } catch {
    throw new OcrLanguageDownloadError('errors:ocrLanguages.unreachable')
  }
  if (!response.ok || !response.body) {
    throw new OcrLanguageDownloadError(
      response.status === 404
        ? 'errors:ocrLanguages.unavailable'
        : 'errors:ocrLanguages.unreachable'
    )
  }

  await mkdir(dataDir(), { recursive: true })
  const temp = path.join(dataDir(), `${lang}.${randomUUID()}.part`)
  const file = await open(temp, 'w')
  try {
    const hash = createHash('sha256')
    let received = 0
    try {
      for await (const chunk of response.body) {
        received += chunk.byteLength
        if (received > bytes) throw new OcrLanguageDownloadError('errors:ocrLanguages.corrupt')
        hash.update(chunk)
        await file.write(chunk)
        reportProgress(lang, received, bytes)
      }
    } catch (error) {
      if (error instanceof OcrLanguageDownloadError || signal.aborted) throw error
      throw new OcrLanguageDownloadError('errors:ocrLanguages.unreachable')
    }
    await file.close()
    if (received !== bytes || hash.digest('hex') !== sha256) {
      throw new OcrLanguageDownloadError('errors:ocrLanguages.corrupt')
    }
    await rename(temp, path.join(dataDir(), dataFileName(lang)))
  } finally {
    await file.close().catch(() => {})
    await rm(temp, { force: true })
  }
}

function reportProgress(lang: DownloadedLanguage, receivedBytes: number, totalBytes: number): void {
  const now = Date.now()
  if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return
  lastProgressAt = now
  setStatus(lang, { state: 'downloading', receivedBytes, totalBytes })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
