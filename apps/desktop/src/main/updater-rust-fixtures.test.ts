// The Rust updater (`crates/memry-desktop/src/updater/`) reads and writes the install marker, the
// install-health file and the updater preferences byte for byte as this code does. Its fixtures are the output of the
// real functions below at a fixed clock; this test fails when either side drifts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '2026.1015.1', getPath: () => mocks.userData }
}))
vi.mock('./lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
// The real module pulls the telemetry runtime, whose electron import ('net') the mock above does
// not provide.
vi.mock('./telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))

import { setAutoCheckPref, setAutoDownloadPref, setSkippedVersion } from './store'
import {
  UPDATE_INSTALL_MARKER_FILENAME,
  markUpdateInstallStarted
} from './telemetry/update-install-marker'
import {
  UPDATE_INSTALL_HEALTH_FILENAME,
  recordUpdateInstallFailure
} from './updater-install-health'

const FIXTURES = path.join(
  __dirname,
  '../../../../crates/memry-desktop/tests/fixtures/electron/updater'
)
const WRITTEN_AT = Date.UTC(2026, 10, 1, 9, 30, 15, 123)

const written = (name: string): string => fs.readFileSync(path.join(mocks.userData, name), 'utf-8')
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf-8')

describe('Rust updater fixtures', () => {
  beforeEach(() => {
    mocks.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-updater-fixtures-'))
    vi.useFakeTimers()
    vi.setSystemTime(WRITTEN_AT)
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(mocks.userData, { recursive: true, force: true })
  })

  it.each([
    ['velopack-handoff', 'update-install-attempt.velopack-handoff.json'],
    ['electron-updater', 'update-install-attempt.electron-updater.json'],
    ['velopack', 'update-install-attempt.velopack.json']
  ] as const)('the %s install marker matches its fixture', (installer, name) => {
    markUpdateInstallStarted('2026.1015.1', 'v2026-11-01', installer)
    expect(written(UPDATE_INSTALL_MARKER_FILENAME)).toBe(fixture(name))
  })

  it('a marker without an installer matches its fixture', () => {
    markUpdateInstallStarted('2026.1015.1')
    expect(written(UPDATE_INSTALL_MARKER_FILENAME)).toBe(
      fixture('update-install-attempt.no-installer.json')
    )
  })

  it('the install-health streak matches its fixtures', () => {
    recordUpdateInstallFailure('v2026-10-15', 'v2026-11-01')
    expect(written(UPDATE_INSTALL_HEALTH_FILENAME)).toBe(fixture('update-install-health.1.json'))
    recordUpdateInstallFailure('v2026-10-15', 'v2026-11-01')
    recordUpdateInstallFailure('v2026-10-15', 'v2026-11-01')
    expect(written(UPDATE_INSTALL_HEALTH_FILENAME)).toBe(
      fixture('update-install-health.escalated.json')
    )
  })

  it('the updater preferences match their fixture', () => {
    setAutoDownloadPref(true)
    setAutoCheckPref(false)
    setSkippedVersion('v2026-10-20')
    expect(written('memry-config.json')).toBe(fixture('memry-config.json'))
  })
})
