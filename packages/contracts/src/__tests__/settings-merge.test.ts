/**
 * Verifier for `settings-merge.json` (#2383).
 *
 * Chapter 06 §6.9.0: each clocked settings path is arbitrated by §6.3's field
 * rule. The committed JSON is the input; the production merge desktop's
 * `mergeRemote` runs is recomputed against it. The Rust core runs the same
 * file in `crates/memry-core/src/sync/settings_merge.rs`.
 */
import { describe, expect, it } from 'vitest'

import { mergeSettingsPayloads } from '../../../sync-client/src/settings-merge.ts'
import type { SettingsSyncPayload } from '../settings-sync'
import { loadVectorFile } from './vector-loader'

const vectors = loadVectorFile<{
  meta: { caseCount: number }
  cases: Array<{
    name: string
    pins: string
    local: SettingsSyncPayload
    remote: SettingsSyncPayload
    rustPending?: string
    expected: {
      settings: SettingsSyncPayload['settings']
      fieldClocks: SettingsSyncPayload['fieldClocks']
      requeue: boolean
    }
  }>
}>('settings-merge.json')

describe('settings-merge vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases.length).toBe(vectors.meta.caseCount)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const local = structuredClone(c.local)
    const remote = structuredClone(c.remote)

    expect(mergeSettingsPayloads(local, remote)).toEqual(c.expected)
    // The merge reads its inputs and never writes them.
    expect(local).toEqual(c.local)
    expect(remote).toEqual(c.remote)
  })
})
