import { describe, it, expect } from 'vitest'
import { isRestorableTabType } from './serialization'
import type { FeaturesSettings } from '@memry/contracts/settings-schemas'

const flags: FeaturesSettings = {
  home: false,
  inbox: false,
  journal: true,
  tasks: true,
  calendar: true,
  graph: true
}

describe('isRestorableTabType', () => {
  it('drops a disabled feature tab', () => {
    expect(isRestorableTabType('inbox', flags)).toBe(false)
  })
  it('keeps an enabled feature tab', () => {
    expect(isRestorableTabType('journal', flags)).toBe(true)
  })
  it('always keeps the home launcher even when home is off', () => {
    expect(isRestorableTabType('home', flags)).toBe(true)
  })
  it('keeps non-feature tabs (notes)', () => {
    expect(isRestorableTabType('note', flags)).toBe(true)
  })
})
