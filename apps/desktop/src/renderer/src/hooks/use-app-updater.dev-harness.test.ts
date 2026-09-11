import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { toUpdatePresentation } from '@/components/updater/update-presentation'
import { buildUpdatePreset, type UpdatePresetName } from './use-app-updater'

// The renderer test project runs in jsdom, where `import.meta.url` is an http URL,
// so the source is located from the package root instead.
const SOURCE_PATH = resolve(process.cwd(), 'src/renderer/src/hooks/use-app-updater.ts')
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')

function fullState(override: Partial<import('@memry/contracts/ipc-updater').AppUpdateState>) {
  return {
    currentVersion: '2026.700.1',
    status: 'idle' as const,
    updateSupported: false,
    availableVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    releaseNotesHtml: null,
    downloadProgressPercent: null,
    lastCheckedAt: null,
    error: null,
    autoDownloadEnabled: false,
    autoCheckEnabled: true,
    installFailed: null,
    ...override
  }
}

describe('dev update harness', () => {
  it('resolves its own source, so a moved file fails loudly instead of silently passing', () => {
    expect(existsSync(SOURCE_PATH)).toBe(true)
  })

  it('registers window.memryUpdate under DEV', () => {
    expect(typeof (window as unknown as { memryUpdate?: unknown }).memryUpdate).toBe('function')
  })

  it('registers window.memryUpdate only under import.meta.env.DEV', () => {
    // The guard is what keeps the harness out of production bundles; asserting it
    // structurally is the only way to check the stripped build from a dev-mode test.
    const guard = SOURCE.indexOf('if (import.meta.env.DEV) {')
    expect(guard).toBeGreaterThan(-1)
    expect(SOURCE.indexOf('win.memryUpdate = apply')).toBeGreaterThan(guard)
    expect(SOURCE.match(/win\.memryUpdate\s*=/g)).toHaveLength(1)
  })

  it.each<[UpdatePresetName, string]>([
    ['available', 'available'],
    ['downloading', 'downloading'],
    ['ready', 'ready'],
    ['installing', 'installing'],
    ['failed', 'failed']
  ])('preset %s surfaces as %s', (preset, kind) => {
    const override = buildUpdatePreset(preset, '2026.700.1')
    expect(override).not.toBeNull()
    expect(toUpdatePresentation(fullState(override!)).kind).toBe(kind)
  })

  it('leaves auto-download off so available and downloading are not swallowed', () => {
    expect(buildUpdatePreset('available', '2026.700.1')?.autoDownloadEnabled).toBe(false)
    expect(buildUpdatePreset('downloading', '2026.700.1')?.autoDownloadEnabled).toBe(false)
  })

  it('carries the real current version and demo release notes', () => {
    const override = buildUpdatePreset('ready', '2026.701.4')
    expect(override?.currentVersion).toBe('2026.701.4')
    expect(override?.availableVersion).toBe('2026.999.9')
    expect(override?.releaseNotesHtml).toContain('Full Changelog')
  })

  it('honours an explicit download percent', () => {
    expect(buildUpdatePreset('downloading', '2026.700.1', { percent: 91 })).toMatchObject({
      downloadProgressPercent: 91
    })
  })

  it('clears the override on reset', () => {
    expect(buildUpdatePreset('reset', '2026.700.1')).toBeNull()
  })
})
