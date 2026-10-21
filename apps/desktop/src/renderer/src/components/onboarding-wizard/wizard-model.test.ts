import { describe, expect, it } from 'vitest'
import {
  activeImports,
  initialState,
  wizardReducer,
  type WizardAction,
  type WizardState
} from './wizard-model'

function run(actions: WizardAction[], from: WizardState = initialState(true)): WizardState {
  return actions.reduce(wizardReducer, from)
}

/** Steps visited by pressing next from welcome until the list ends. */
function walk(state: WizardState): string[] {
  const visited = [state.step]
  for (;;) {
    const next = wizardReducer(state, { type: 'next' })
    if (next.step === state.step) return visited
    visited.push(next.step)
    state = next
  }
}

describe('onboarding wizard steps', () => {
  it.each([
    {
      name: 'local with AI on',
      patch: {},
      steps: ['welcome', 'theme', 'modules', 'import', 'agent', 'storage', 'ready']
    },
    {
      name: 'AI and agent off skips the agent step',
      patch: { aiEnabled: false },
      steps: ['welcome', 'theme', 'modules', 'import', 'storage', 'ready']
    },
    {
      name: 'sync adds the account and plan steps',
      patch: { storage: 'sync' as const },
      steps: [
        'welcome',
        'theme',
        'modules',
        'import',
        'agent',
        'storage',
        'account',
        'plan',
        'ready'
      ]
    }
  ])('$name', ({ patch, steps }) => {
    expect(walk(run([{ type: 'update', patch }]))).toEqual(steps)
  })

  it('returning users sign in and pick a vault, with no tour or import', () => {
    expect(walk(run([{ type: 'start', path: 'returning' }]))).toEqual(['account', 'vault'])
  })

  it('turning AI off while on the agent step lets back skip past it', () => {
    const atStorage = run([
      { type: 'goto', step: 'storage' },
      { type: 'update', patch: { aiEnabled: false } }
    ])
    expect(run([{ type: 'back' }], atStorage).step).toBe('import')
  })

  it('an existing account on the new path continues as a returning user', () => {
    const state = run([
      { type: 'update', patch: { storage: 'sync', theme: 'dark', aiEnabled: false } },
      { type: 'goto', step: 'account' },
      { type: 'reroute-to-returning' }
    ])
    expect(state).toMatchObject({ path: 'returning', step: 'account' })
    expect(state.draft).toMatchObject({ theme: 'dark', aiEnabled: true, storage: 'local' })
    expect(run([{ type: 'next' }], state).step).toBe('vault')
  })

  it('a returning account with no vaults sets up a synced vault like a new user', () => {
    const state = run([
      { type: 'start', path: 'returning' },
      { type: 'next' },
      { type: 'switch-to-new' }
    ])
    expect(state).toMatchObject({ path: 'new', step: 'theme', draft: { storage: 'sync' } })
    expect(walk(state)).toContain('plan')
  })
})

describe('import choices follow the module set', () => {
  it('drops task and journal imports when those modules are off', () => {
    const base = initialState(true).draft
    const draft = {
      ...base,
      features: { ...base.features, tasks: false, journal: false },
      imports: ['todoist', 'ticktick', 'noteplan', 'evernote'].map((importerId) => ({
        key: importerId,
        importerId,
        label: importerId,
        sourcePaths: []
      }))
    }
    expect(activeImports(draft).map((choice) => choice.importerId)).toEqual(['evernote'])
  })
})
