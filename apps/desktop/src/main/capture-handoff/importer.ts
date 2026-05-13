import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import { ExtensionCaptureEnvelopeSchema } from '@memry/contracts/extension-capture-api'
import type { InboxCaptureResponse } from '@memry/domain-inbox'
import { getStatus as getVaultStatus } from '../vault'
import { createLogger } from '../lib/logger'
import { createDesktopInboxDomain } from '../inbox/domain'

const logger = createLogger('CaptureHandoff')
const WATCH_INTERVAL_MS = 1500

class InvalidCaptureHandoffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCaptureHandoffError'
  }
}

type CaptureDomain = Partial<{
  captureClip(input: {
    html?: string
    text: string
    sourceUrl: string
    sourceTitle: string
    tags?: string[]
    source: 'browser-extension'
  }): Promise<InboxCaptureResponse>
  captureLink(input: {
    url: string
    tags?: string[]
    source: 'browser-extension'
  }): Promise<InboxCaptureResponse>
  captureImage(input: {
    data: Buffer
    filename: string
    mimeType: string
    tags?: string[]
    source: 'browser-extension'
  }): Promise<InboxCaptureResponse>
}>

export interface CaptureHandoffImportResult {
  imported: number
  failed: number
  skipped: boolean
}

export interface CaptureHandoffImportOptions {
  captureDir?: string
  isVaultOpen?: () => boolean
  domain?: CaptureDomain
}

let watcherTimer: NodeJS.Timeout | null = null
let importInFlight = false

export function getCaptureHandoffDir(): string {
  return join(app.getPath('userData'), 'capture-inbox', 'pending')
}

function getFailedCaptureDir(captureDir: string): string {
  return join(dirname(captureDir), 'failed')
}

function defaultIsVaultOpen(): boolean {
  return getVaultStatus().isOpen
}

function getDomain(domain?: CaptureDomain): CaptureDomain {
  return domain ?? createDesktopInboxDomain()
}

async function moveToFailed(filePath: string, captureDir: string): Promise<void> {
  const failedDir = getFailedCaptureDir(captureDir)
  await mkdir(failedDir, { recursive: true })
  await rename(filePath, join(failedDir, `${Date.now()}-${basename(filePath)}`))
}

async function importCaptureFile(filePath: string, domain: CaptureDomain): Promise<boolean> {
  const raw = await readFile(filePath, 'utf8')
  const envelope = (() => {
    try {
      return ExtensionCaptureEnvelopeSchema.parse(JSON.parse(raw))
    } catch (error) {
      throw new InvalidCaptureHandoffError(
        error instanceof Error ? error.message : 'Invalid extension capture handoff'
      )
    }
  })()
  const capture = envelope.capture

  let result: InboxCaptureResponse

  switch (capture.kind) {
    case 'clip':
    case 'page': {
      if (!domain.captureClip) throw new Error('Clip capture is not available')
      result = await domain.captureClip({
        html: capture.html,
        text: capture.text,
        sourceUrl: capture.sourceUrl,
        sourceTitle: capture.sourceTitle,
        tags: capture.tags,
        source: 'browser-extension'
      })
      break
    }
    case 'link': {
      if (!domain.captureLink) throw new Error('Link capture is not available')
      result = await domain.captureLink({
        url: capture.url,
        tags: capture.tags,
        source: 'browser-extension'
      })
      break
    }
    case 'file': {
      if (!domain.captureImage) throw new Error('File capture is not available')
      result = await domain.captureImage({
        data: Buffer.from(capture.dataBase64, 'base64'),
        filename: capture.filename,
        mimeType: capture.mimeType,
        tags: capture.tags,
        source: 'browser-extension'
      })
      break
    }
  }

  if (!result.success) {
    throw new Error(result.error ?? 'Capture import failed')
  }

  await unlink(filePath)
  return true
}

export async function importPendingCaptureHandoff(
  options: CaptureHandoffImportOptions = {}
): Promise<CaptureHandoffImportResult> {
  const isVaultOpen = options.isVaultOpen ?? defaultIsVaultOpen
  if (!isVaultOpen()) {
    return { imported: 0, failed: 0, skipped: true }
  }

  const captureDir = options.captureDir ?? getCaptureHandoffDir()
  if (!existsSync(captureDir)) {
    return { imported: 0, failed: 0, skipped: false }
  }

  const files = (await readdir(captureDir))
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => join(captureDir, file))

  const domain = getDomain(options.domain)
  let imported = 0
  let failed = 0

  for (const filePath of files) {
    try {
      if (await importCaptureFile(filePath, domain)) imported++
    } catch (error) {
      failed++
      logger.warn('Failed to import extension capture handoff', {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      })

      if (error instanceof InvalidCaptureHandoffError) {
        try {
          await moveToFailed(filePath, captureDir)
        } catch (moveError) {
          logger.warn('Failed to move bad extension capture handoff aside', moveError)
        }
      }
    }
  }

  if (imported > 0 || failed > 0) {
    logger.info(`Imported extension captures: ${imported} imported, ${failed} failed`)
  }

  return { imported, failed, skipped: false }
}

export function startCaptureHandoffWatcher(): void {
  if (watcherTimer) return

  const tick = (): void => {
    if (importInFlight) return
    importInFlight = true
    importPendingCaptureHandoff()
      .catch((error) => logger.warn('Capture handoff import tick failed', error))
      .finally(() => {
        importInFlight = false
      })
  }

  tick()
  watcherTimer = setInterval(tick, WATCH_INTERVAL_MS)
  watcherTimer.unref?.()
}

export function stopCaptureHandoffWatcher(): void {
  if (!watcherTimer) return
  clearInterval(watcherTimer)
  watcherTimer = null
}
