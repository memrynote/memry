import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { mockApp } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  app: mockApp
}))

vi.mock('./lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  UPDATE_INSTALL_HEALTH_FILENAME,
  reconcileUpdateInstallHealth,
  recordUpdateInstallFailure
} from './updater-install-health'

// The verbatim production shapes from #1999: the build two installs sat on for
// four releases, and the target whose Squirrel.Mac staging kept failing.
const STUCK_BUILD = 'v2026-08-17.1'
const TARGET = 'v2026-09-03.2'

describe('update install health', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-update-install-health-'))
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'userData' ? tempDir : `/mock/${name}`
    )
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const healthFile = (): string => path.join(tempDir, UPDATE_INSTALL_HEALTH_FILENAME)
  const writeRaw = (contents: string): void => fs.writeFileSync(healthFile(), contents, 'utf-8')

  it('escalates on the third failed install of the same update, and only once', () => {
    // #given two launches whose install of the same target already failed
    expect(recordUpdateInstallFailure(STUCK_BUILD, TARGET)).toEqual({
      consecutiveFailures: 1,
      stuck: false
    })
    expect(recordUpdateInstallFailure(STUCK_BUILD, TARGET)).toEqual({
      consecutiveFailures: 2,
      stuck: false
    })

    // #when a third launch fails the same way
    // #then the streak escalates exactly once, and stays latched afterwards
    expect(recordUpdateInstallFailure(STUCK_BUILD, TARGET)).toEqual({
      consecutiveFailures: 3,
      stuck: true
    })
    expect(recordUpdateInstallFailure(STUCK_BUILD, TARGET)).toEqual({
      consecutiveFailures: 4,
      stuck: false
    })
  })

  it('keeps the streak across launches, which is the whole point of the file', () => {
    // #given a streak written by earlier sessions
    recordUpdateInstallFailure(STUCK_BUILD, TARGET)
    recordUpdateInstallFailure(STUCK_BUILD, TARGET)

    // #when a fresh launch reconciles and then fails again
    expect(reconcileUpdateInstallHealth(STUCK_BUILD)).toBeNull()

    // #then the count continued rather than restarting at one
    expect(recordUpdateInstallFailure(STUCK_BUILD, TARGET)).toEqual({
      consecutiveFailures: 3,
      stuck: true
    })
  })

  it('restarts the streak when a NEW update is the one failing', () => {
    // #given an escalated streak against one target
    recordUpdateInstallFailure(STUCK_BUILD, TARGET)
    recordUpdateInstallFailure(STUCK_BUILD, TARGET)
    recordUpdateInstallFailure(STUCK_BUILD, TARGET)

    // #when a different update fails its first install
    // #then one failure of a different update is not a stranded install
    expect(recordUpdateInstallFailure(STUCK_BUILD, 'v2026-09-10.1')).toEqual({
      consecutiveFailures: 1,
      stuck: false
    })
    expect(reconcileUpdateInstallHealth(STUCK_BUILD)).toBeNull()
  })

  it('re-surfaces an escalated streak on every launch the app is still stuck', () => {
    // #given three failed installs on this build
    recordUpdateInstallFailure(STUCK_BUILD, TARGET)
    recordUpdateInstallFailure(STUCK_BUILD, TARGET)
    recordUpdateInstallFailure(STUCK_BUILD, TARGET)

    // #when the app boots again as the same old build
    // #then the user is told which update to install by hand, again
    expect(reconcileUpdateInstallHealth(STUCK_BUILD)).toBe(TARGET)
    expect(reconcileUpdateInstallHealth(STUCK_BUILD)).toBe(TARGET)
  })

  it('clears everything once the app boots as a different build', () => {
    // #given an escalated streak
    recordUpdateInstallFailure(STUCK_BUILD, TARGET)
    recordUpdateInstallFailure(STUCK_BUILD, TARGET)
    recordUpdateInstallFailure(STUCK_BUILD, TARGET)

    // #when the app boots as the version it was trying to install
    expect(reconcileUpdateInstallHealth(TARGET)).toBeNull()

    // #then the file is gone and a later failure starts from scratch
    expect(fs.existsSync(healthFile())).toBe(false)
    expect(recordUpdateInstallFailure(TARGET, 'v2026-09-10.1')).toEqual({
      consecutiveFailures: 1,
      stuck: false
    })
  })

  it('behaves exactly like a fresh install when no state file exists', () => {
    // #given no file on disk, which is every install shipped before this change
    // #when the app boots
    expect(reconcileUpdateInstallHealth(STUCK_BUILD)).toBeNull()

    // #then the first failure is the first failure
    expect(recordUpdateInstallFailure(STUCK_BUILD, TARGET)).toEqual({
      consecutiveFailures: 1,
      stuck: false
    })
  })

  it('degrades to no streak on a torn or corrupt file', () => {
    // #given a half-written file, the shape a crash mid-write leaves behind
    writeRaw('{"fromVersion":"v2026-08-17.1","targetVer')

    // #when the updater reads it
    // #then nothing is surfaced and the streak restarts rather than throwing
    expect(reconcileUpdateInstallHealth(STUCK_BUILD)).toBeNull()
    expect(recordUpdateInstallFailure(STUCK_BUILD, TARGET)).toEqual({
      consecutiveFailures: 1,
      stuck: false
    })
  })

  it('rejects a hostile target version instead of substituting characters out of it', () => {
    // #given a file whose target version is a path, not a version
    writeRaw(
      JSON.stringify({
        fromVersion: STUCK_BUILD,
        targetVersion: '/Users/kaan/x',
        consecutiveFailures: 3,
        escalated: true
      })
    )

    // #when the app boots as the stuck build
    // #then the record is refused whole: no sanitised version reaches the dialog
    expect(reconcileUpdateInstallHealth(STUCK_BUILD)).toBeNull()
  })

  it('rejects an out-of-range failure count instead of trusting it', () => {
    // #given a count that no honest run could have written
    writeRaw(
      JSON.stringify({
        fromVersion: STUCK_BUILD,
        targetVersion: TARGET,
        consecutiveFailures: Number.MAX_SAFE_INTEGER,
        escalated: false
      })
    )

    // #when the next install fails
    // #then the streak starts over rather than escalating off a bogus number
    expect(recordUpdateInstallFailure(STUCK_BUILD, TARGET)).toEqual({
      consecutiveFailures: 1,
      stuck: false
    })
  })

  it('rejects a non-boolean escalation latch', () => {
    // #given a latch that is not a boolean
    writeRaw(
      JSON.stringify({
        fromVersion: STUCK_BUILD,
        targetVersion: TARGET,
        consecutiveFailures: 3,
        escalated: 'yes'
      })
    )

    // #when the app boots as the stuck build
    // #then the record is refused whole rather than read as escalated
    expect(reconcileUpdateInstallHealth(STUCK_BUILD)).toBeNull()
  })
})
