# Template Editor as Note Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bespoke template creation screen with the note editing surface, so a template is authored in a tab that looks and behaves like a note, with a Create/Update button, silent auto-save after first save, and a save-or-discard prompt on tab close.

**Architecture:** `pages/template-editor.tsx` is rewritten to compose the same primitives the note page uses (`NoteLayout`, `NoteTitle`, `TagsRow`, `InfoSection`, `GhostAffordanceRow`, `ContentArea`). `pages/note.tsx` is not touched. The save state machine lives in a dedicated hook, the property model in a dedicated module, and a generic tab-close guard registry is added to the tabs context so every close path (X, middle-click, context menu, ⌘W, close-others/right/all) is covered at one place.

**Tech Stack:** React 19, TypeScript, Electron, Vitest + Testing Library (jsdom), Tailwind, i18next.

**Spec:** `docs/superpowers/specs/2026-08-04-template-editor-as-note-page-design.md`

## Global Constraints

- **Backward compatibility is mandatory.** No schema, IPC contract, vault format, or sync protocol change in this plan. Templates written by older versions must load unchanged.
- **Logging:** always `createLogger('Scope')`; never raw `console.*`.
- **User-facing errors:** always `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **RTL safety:** new markup uses logical Tailwind classes only — `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`, `border-s`/`border-e`, `rounded-s-*`/`rounded-e-*`. Never `ml-*`, `mr-*`, `pl-*`, `pr-*`, `left-*`, `right-*`, `text-left`, `text-right`.
- **i18n:** every user-visible string goes through `useT(namespace)`. New keys land in `packages/i18n/src/locales/en/*.json` **and all 32 locales** (Task 8).
- **Auto-save debounce:** 800 ms, and never write when the payload is byte-identical to the last persisted snapshot (template sync pushes on every write).
- **Commit style:** no `Co-Authored-By` trailers.
- **Branch:** work happens on the current worktree branch; do not push or open a PR as part of this plan.

---

### Task 1: `setTabEntity` tab action

A draft template tab has no `entityId`. When the user clicks **Create Template** the tab must adopt the new id and path in place, without closing and reopening (which would flash and lose focus). No existing action can write those fields.

**Files:**

- Modify: `apps/desktop/src/renderer/src/contexts/tabs/types.ts` (action union, ~line 263)
- Modify: `apps/desktop/src/renderer/src/contexts/tabs/reducers/tab-modify-reducer.ts`
- Modify: `apps/desktop/src/renderer/src/contexts/tabs/context.tsx` (interface ~line 60, implementation near `updateTabTitle` ~line 505, memo value + deps at the tail)
- Test: `apps/desktop/src/renderer/src/contexts/tabs/reducers/tab-modify-reducer.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `setTabEntity(tabId: string, entityId: string, path: string, groupId?: string): void` on the `useTabs()` context. Used by Task 5.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/renderer/src/contexts/tabs/reducers/tab-modify-reducer.test.ts`. Match the existing file's helper for building state — read the top of the file first and reuse whatever factory the neighbouring tests use rather than inventing a new one.

```ts
describe('SET_TAB_ENTITY', () => {
  it('writes entityId and path onto the target tab', () => {
    const state = createStateWithTabs([
      { id: 'tab-1', type: 'template-editor', path: '/templates/new' }
    ])

    const next = tabModifyReducer(state, {
      type: 'SET_TAB_ENTITY',
      payload: { tabId: 'tab-1', groupId: 'group-1', entityId: 'tpl-42', path: '/templates/tpl-42' }
    })

    const tab = next.tabGroups['group-1'].tabs.find((t) => t.id === 'tab-1')
    expect(tab?.entityId).toBe('tpl-42')
    expect(tab?.path).toBe('/templates/tpl-42')
  })

  it('leaves other tabs untouched', () => {
    const state = createStateWithTabs([
      { id: 'tab-1', type: 'template-editor', path: '/templates/new' },
      { id: 'tab-2', type: 'note', path: '/notes/n1' }
    ])

    const next = tabModifyReducer(state, {
      type: 'SET_TAB_ENTITY',
      payload: { tabId: 'tab-1', groupId: 'group-1', entityId: 'tpl-42', path: '/templates/tpl-42' }
    })

    const other = next.tabGroups['group-1'].tabs.find((t) => t.id === 'tab-2')
    expect(other?.path).toBe('/notes/n1')
    expect(other?.entityId).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- src/renderer/src/contexts/tabs/reducers/tab-modify-reducer.test.ts
```

Expected: FAIL — TypeScript rejects the unknown action type `'SET_TAB_ENTITY'`.

- [ ] **Step 3: Add the action to the union**

In `types.ts`, directly after the `UPDATE_TAB_TITLE` entry:

```ts
| {
    type: 'SET_TAB_ENTITY'
    payload: { tabId: string; groupId: string; entityId: string; path: string }
  }
```

- [ ] **Step 4: Handle it in the reducer**

In `tab-modify-reducer.ts`, add a case mirroring the shape of the existing `SET_TAB_MODIFIED` case:

```ts
case 'SET_TAB_ENTITY': {
  const { tabId, groupId, entityId, path } = action.payload
  const group = state.tabGroups[groupId]
  if (!group) return state
  return {
    ...state,
    tabGroups: {
      ...state.tabGroups,
      [groupId]: {
        ...group,
        tabs: group.tabs.map((t) => (t.id === tabId ? { ...t, entityId, path } : t))
      }
    }
  }
}
```

- [ ] **Step 5: Expose it on the context**

In `context.tsx`, add to the context interface next to `updateTabTitle`:

```ts
/**
 * Attach an entity id + path to an existing tab (draft → saved transition)
 */
setTabEntity: (tabId: string, entityId: string, path: string, groupId?: string) => void
```

Add the implementation next to `updateTabTitle`:

```ts
const setTabEntity = useCallback(
  (tabId: string, entityId: string, path: string, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'SET_TAB_ENTITY',
      payload: { tabId, groupId: actualGroupId, entityId, path }
    })
  },
  []
)
```

Add `setTabEntity` to both the memo value object and its dependency array at the tail of the provider.

- [ ] **Step 6: Run the test and confirm it passes**

```bash
pnpm --filter @memry/desktop test:renderer -- src/renderer/src/contexts/tabs/reducers/tab-modify-reducer.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/contexts/tabs
git commit -m "feat(tabs): add SET_TAB_ENTITY action for draft-to-saved transitions"
```

---

### Task 2: Tab close guard registry

Today `closeTab` dispatches unconditionally, and `useUnsavedChangesGuard` in `components/tabs/unsaved-changes-dialog.tsx` is dead — nothing outside a test imports it. Six call sites close tabs (`regular-tab.tsx` X button and middle-click, `pinned-tab.tsx`, `accessible-tab.tsx` ×2, `tab-context-menu.tsx`, `use-menu-commands.ts` for ⌘W). Rather than patch all six, the guard goes inside the context so every path is covered at once.

`contexts/tabs/context.tsx` is already 23K, so the registry lives in its own module and the context consumes it in about twenty lines.

**Files:**

- Create: `apps/desktop/src/renderer/src/contexts/tabs/close-guard.tsx`
- Modify: `apps/desktop/src/renderer/src/contexts/tabs/context.tsx` (interface, the four close callbacks at ~355-386, the provider return at line 734, memo value + deps)
- Modify: `apps/desktop/src/renderer/src/contexts/tabs/index.ts` (export the guard type)
- Modify: `apps/desktop/src/renderer/src/components/tabs/unsaved-changes-dialog.tsx` (delete `useUnsavedChangesGuard`, keep `UnsavedChangesDialog`)
- Modify: `apps/desktop/src/renderer/src/components/tabs/index.ts` (drop the removed export)
- Modify: `apps/desktop/src/renderer/src/components/missing-small-components.test.tsx` (drop the hook's test block; keep the dialog's)
- Test: `apps/desktop/src/renderer/src/contexts/tabs/close-guard.test.tsx`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `interface TabCloseGuard { isDirty: () => boolean; save: () => Promise<boolean> }`
  - `registerCloseGuard(tabId: string, guard: TabCloseGuard): () => void` on `useTabs()` — returns an unregister function. Used by Task 5.

**Behaviour contract:**

- Unguarded tab, or guarded and clean → closes immediately on the exact path it takes today.
- Guarded and dirty → the dialog opens instead; nothing is dispatched yet.
- **Don't Save** → close proceeds. **Save** → `guard.save()` runs; on `true` the close proceeds, on `false` the dialog stays open and the tab stays dirty. **Cancel** → nothing closes.
- Bulk closes (`closeOtherTabs` / `closeTabsToRight` / `closeAllTabs`) prompt for each dirty guarded tab in the target set one at a time; once the queue drains, the original bulk action dispatches. Cancel at any point aborts the whole operation and dispatches nothing.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/contexts/tabs/close-guard.test.tsx`:

```tsx
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useCloseGuardRegistry } from './close-guard'

describe('useCloseGuardRegistry', () => {
  it('commits immediately when no tab is guarded', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => result.current.requestClose(['tab-1'], commit))

    expect(commit).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBeNull()
  })

  it('commits immediately when the guarded tab is clean', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', {
        isDirty: () => false,
        save: vi.fn().mockResolvedValue(true)
      })
    })
    act(() => result.current.requestClose(['tab-1'], commit))

    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('holds the close and exposes a pending prompt when dirty', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', {
        isDirty: () => true,
        save: vi.fn().mockResolvedValue(true)
      })
    })
    act(() => result.current.requestClose(['tab-1'], commit))

    expect(commit).not.toHaveBeenCalled()
    expect(result.current.pending).toEqual({ tabId: 'tab-1' })
  })

  it('discard commits without saving', async () => {
    const commit = vi.fn()
    const save = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', { isDirty: () => true, save })
    })
    act(() => result.current.requestClose(['tab-1'], commit))
    await act(async () => {
      await result.current.resolvePending('discard')
    })

    expect(save).not.toHaveBeenCalled()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBeNull()
  })

  it('save commits only when the save succeeds', async () => {
    const commit = vi.fn()
    const save = vi.fn().mockResolvedValue(false)
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', { isDirty: () => true, save })
    })
    act(() => result.current.requestClose(['tab-1'], commit))
    await act(async () => {
      await result.current.resolvePending('save')
    })

    expect(save).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
    expect(result.current.pending).toEqual({ tabId: 'tab-1' })

    save.mockResolvedValue(true)
    await act(async () => {
      await result.current.resolvePending('save')
    })

    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('cancel aborts the whole operation', async () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', {
        isDirty: () => true,
        save: vi.fn().mockResolvedValue(true)
      })
      result.current.registerCloseGuard('tab-2', {
        isDirty: () => true,
        save: vi.fn().mockResolvedValue(true)
      })
    })
    act(() => result.current.requestClose(['tab-1', 'tab-2'], commit))
    await act(async () => {
      await result.current.resolvePending('cancel')
    })

    expect(commit).not.toHaveBeenCalled()
    expect(result.current.pending).toBeNull()
  })

  it('prompts each dirty tab in turn, then commits once', async () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', {
        isDirty: () => true,
        save: vi.fn().mockResolvedValue(true)
      })
      result.current.registerCloseGuard('tab-2', {
        isDirty: () => true,
        save: vi.fn().mockResolvedValue(true)
      })
    })
    act(() => result.current.requestClose(['tab-1', 'tab-2', 'tab-3'], commit))

    expect(result.current.pending).toEqual({ tabId: 'tab-1' })
    await act(async () => {
      await result.current.resolvePending('discard')
    })
    expect(result.current.pending).toEqual({ tabId: 'tab-2' })
    expect(commit).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.resolvePending('discard')
    })
    expect(result.current.pending).toBeNull()
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('unregistering removes the guard', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCloseGuardRegistry())

    let unregister = () => {}
    act(() => {
      unregister = result.current.registerCloseGuard('tab-1', {
        isDirty: () => true,
        save: vi.fn().mockResolvedValue(true)
      })
    })
    act(() => unregister())
    act(() => result.current.requestClose(['tab-1'], commit))

    expect(commit).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- src/renderer/src/contexts/tabs/close-guard.test.tsx
```

Expected: FAIL — `Cannot find module './close-guard'`.

- [ ] **Step 3: Implement the registry**

Create `apps/desktop/src/renderer/src/contexts/tabs/close-guard.tsx`:

```tsx
/**
 * Tab Close Guard
 *
 * Lets a tab's page veto its own close while it holds unsaved work. The
 * registry lives here rather than in context.tsx so the context file does not
 * grow another responsibility; the provider wires it in and every close path
 * (X button, middle-click, context menu, ⌘W, close others/right/all) inherits
 * the behaviour for free.
 */

import { useCallback, useRef, useState } from 'react'

export interface TabCloseGuard {
  /** True while the tab holds work that would be lost on close. */
  isDirty: () => boolean
  /** Persist the pending work. Resolve false to keep the tab open. */
  save: () => Promise<boolean>
}

export interface PendingClosePrompt {
  tabId: string
}

export type PendingCloseResolution = 'save' | 'discard' | 'cancel'

export interface CloseGuardRegistry {
  registerCloseGuard: (tabId: string, guard: TabCloseGuard) => () => void
  /**
   * Run `commit` once every dirty guarded tab in `tabIds` has been resolved.
   * Commits synchronously when nothing in the set is dirty.
   */
  requestClose: (tabIds: string[], commit: () => void) => void
  pending: PendingClosePrompt | null
  resolvePending: (resolution: PendingCloseResolution) => Promise<void>
}

export function useCloseGuardRegistry(): CloseGuardRegistry {
  const guardsRef = useRef(new Map<string, TabCloseGuard>())
  const queueRef = useRef<string[]>([])
  const commitRef = useRef<(() => void) | null>(null)
  const [pending, setPending] = useState<PendingClosePrompt | null>(null)

  const registerCloseGuard = useCallback((tabId: string, guard: TabCloseGuard) => {
    guardsRef.current.set(tabId, guard)
    return () => {
      guardsRef.current.delete(tabId)
    }
  }, [])

  const advance = useCallback(() => {
    const next = queueRef.current.shift()
    if (next) {
      setPending({ tabId: next })
      return
    }
    setPending(null)
    const commit = commitRef.current
    commitRef.current = null
    commit?.()
  }, [])

  const requestClose = useCallback(
    (tabIds: string[], commit: () => void) => {
      const dirty = tabIds.filter((id) => guardsRef.current.get(id)?.isDirty() === true)
      if (dirty.length === 0) {
        commit()
        return
      }
      queueRef.current = dirty
      commitRef.current = commit
      advance()
    },
    [advance]
  )

  const resolvePending = useCallback(
    async (resolution: PendingCloseResolution) => {
      const current = pending
      if (!current) return

      if (resolution === 'cancel') {
        queueRef.current = []
        commitRef.current = null
        setPending(null)
        return
      }

      if (resolution === 'save') {
        const guard = guardsRef.current.get(current.tabId)
        const saved = guard ? await guard.save() : true
        // Failed save: leave the prompt up and the tab dirty rather than
        // silently discarding the user's work.
        if (!saved) return
      }

      advance()
    },
    [pending, advance]
  )

  return { registerCloseGuard, requestClose, pending, resolvePending }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm --filter @memry/desktop test:renderer -- src/renderer/src/contexts/tabs/close-guard.test.tsx
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Wire the registry into the tabs context**

In `context.tsx`:

Import at the top:

```ts
import { useCloseGuardRegistry, type TabCloseGuard } from './close-guard'
import { UnsavedChangesDialog } from '@/components/tabs/unsaved-changes-dialog'
```

Add to the context interface, next to `closeTab`:

```ts
/**
 * Register a veto for this tab's close while it holds unsaved work.
 * Returns an unregister function.
 */
registerCloseGuard: (tabId: string, guard: TabCloseGuard) => () => void
```

Inside the provider body, before the close callbacks:

```ts
const closeGuards = useCloseGuardRegistry()
```

Replace the four close callbacks (currently at ~355-386) so each routes through `requestClose`. Note `closeAllTabs` and the two partial closers pass the ids they are about to remove, so the prompt only fires for tabs that would actually close:

```ts
const closeTab = useCallback(
  (tabId: string, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    closeGuards.requestClose([tabId], () => {
      dispatch({ type: 'CLOSE_TAB', payload: { tabId, groupId: actualGroupId } })
    })
  },
  [closeGuards]
)

const closeOtherTabs = useCallback(
  (tabId: string, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    const group = stateRef.current.tabGroups[actualGroupId]
    const targets = (group?.tabs ?? [])
      .filter((t) => t.id !== tabId && !t.isPinned)
      .map((t) => t.id)
    closeGuards.requestClose(targets, () => {
      dispatch({ type: 'CLOSE_OTHER_TABS', payload: { tabId, groupId: actualGroupId } })
    })
  },
  [closeGuards]
)

const closeTabsToRight = useCallback(
  (tabId: string, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    const tabs = stateRef.current.tabGroups[actualGroupId]?.tabs ?? []
    const index = tabs.findIndex((t) => t.id === tabId)
    const targets =
      index === -1
        ? []
        : tabs
            .slice(index + 1)
            .filter((t) => !t.isPinned)
            .map((t) => t.id)
    closeGuards.requestClose(targets, () => {
      dispatch({ type: 'CLOSE_TABS_TO_RIGHT', payload: { tabId, groupId: actualGroupId } })
    })
  },
  [closeGuards]
)

const closeAllTabs = useCallback(
  (groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    const targets = (stateRef.current.tabGroups[actualGroupId]?.tabs ?? [])
      .filter((t) => !t.isPinned)
      .map((t) => t.id)
    closeGuards.requestClose(targets, () => {
      dispatch({ type: 'CLOSE_ALL_TABS', payload: { groupId: actualGroupId } })
    })
  },
  [closeGuards]
)
```

`stateRef` — check whether the provider already keeps a ref mirroring `state` (it keeps `activeGroupIdRef`, so the pattern exists). If there is no `stateRef`, add one next to `activeGroupIdRef`:

```ts
const stateRef = useRef(state)
stateRef.current = state
```

Reading through a ref (not `state`) keeps these callbacks dependency-free, matching how the existing ones are written.

Add `registerCloseGuard: closeGuards.registerCloseGuard` to the memo value, and `closeGuards` to the memo dependency array.

Replace the provider return at line 734:

```tsx
return (
  <TabContext.Provider value={value}>
    {children}
    <UnsavedChangesDialog
      isOpen={closeGuards.pending !== null}
      tabTitle={pendingTabTitle}
      onSave={() => void closeGuards.resolvePending('save')}
      onDiscard={() => void closeGuards.resolvePending('discard')}
      onCancel={() => void closeGuards.resolvePending('cancel')}
    />
  </TabContext.Provider>
)
```

with the title resolved just above the return:

```ts
const pendingTabTitle = closeGuards.pending
  ? (Object.values(state.tabGroups)
      .flatMap((g) => g.tabs)
      .find((t) => t.id === closeGuards.pending?.tabId)?.title ?? '')
  : ''
```

- [ ] **Step 6: Delete the dead hook**

In `components/tabs/unsaved-changes-dialog.tsx`, remove `useUnsavedChangesGuard`, the `UseUnsavedChangesGuardResult` and `PendingClose` interfaces, and the now-unused `useState` / `useCallback` / `useTabs` imports. Keep `UnsavedChangesDialog` untouched.

In `components/tabs/index.ts`, change the export to:

```ts
export { UnsavedChangesDialog } from './unsaved-changes-dialog'
```

In `components/missing-small-components.test.tsx`, delete the `useUnsavedChangesGuard` `renderHook` block (~line 293) and drop it from that file's import; leave the `UnsavedChangesDialog` render test in place.

- [ ] **Step 7: Export the guard type**

In `contexts/tabs/index.ts`, under the Context and Hooks section:

```ts
export type { TabCloseGuard } from './close-guard'
```

- [ ] **Step 8: Run the tabs suites and confirm no regression**

```bash
pnpm --filter @memry/desktop test:renderer -- src/renderer/src/contexts/tabs src/renderer/src/components/missing-small-components.test.tsx
```

Expected: PASS. The existing `context.test.tsx` close-tab tests are the regression guard — an unguarded tab must still close on exactly the path it took before.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/contexts/tabs apps/desktop/src/renderer/src/components/tabs apps/desktop/src/renderer/src/components/missing-small-components.test.tsx
git commit -m "feat(tabs): centralize unsaved-changes guard in the tabs context"
```

---

### Task 3: Template property model

Fixes a live data-loss bug. `pages/template-editor.tsx:80-89` maps a stored template property type down to the note UI's `PropertyType` and back; `select`, `multiselect`, and `rating` have no reverse mapping and fall through to `'text'`. Editing anything in a template that has a select property writes the degraded type back and destroys it permanently. Index-derived ids (`prop-${index}`) additionally break under reorder.

The fix is structural: keep `TemplateProperty` as the stored truth alongside a stable id, map to the UI shape for _display only_, and never map back.

**Files:**

- Create: `apps/desktop/src/renderer/src/lib/template-properties.ts`
- Test: `apps/desktop/src/renderer/src/lib/template-properties.test.ts`

**Interfaces:**

- Consumes: `TemplateProperty` from `@/services/templates-service`; `Property`, `NewProperty`, `PropertyType` from `@/components/note/info-section`.
- Produces (used by Tasks 4 and 5):
  - `interface EditableProperty { id: string; property: TemplateProperty }`
  - `toEditableProperties(props: TemplateProperty[]): EditableProperty[]`
  - `toUiProperties(items: EditableProperty[]): Property[]`
  - `toTemplateProperties(items: EditableProperty[]): TemplateProperty[]`
  - `addProperty(items: EditableProperty[], next: NewProperty): EditableProperty[]`
  - `setPropertyValue(items: EditableProperty[], id: string, value: unknown): EditableProperty[]`
  - `setPropertyName(items: EditableProperty[], id: string, name: string): EditableProperty[]`
  - `reorderProperties(items: EditableProperty[], orderedIds: string[]): EditableProperty[]`
  - `removeProperty(items: EditableProperty[], id: string): EditableProperty[]`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/lib/template-properties.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  addProperty,
  removeProperty,
  reorderProperties,
  setPropertyName,
  setPropertyValue,
  toEditableProperties,
  toTemplateProperties,
  toUiProperties
} from './template-properties'

describe('template-properties', () => {
  it('round-trips every stored property type without degrading it', () => {
    const stored = [
      { name: 'Status', type: 'select' as const, value: 'todo', options: ['todo', 'done'] },
      { name: 'Tags', type: 'multiselect' as const, value: [], options: ['a'] },
      { name: 'Score', type: 'rating' as const, value: 3 },
      { name: 'Due', type: 'date' as const, value: null }
    ]

    const items = toEditableProperties(stored)
    expect(toTemplateProperties(items)).toEqual(stored)
  })

  it('preserves the stored type when a value is edited', () => {
    const items = toEditableProperties([{ name: 'Score', type: 'rating', value: 3 }])
    const edited = setPropertyValue(items, items[0].id, 5)

    expect(toTemplateProperties(edited)).toEqual([{ name: 'Score', type: 'rating', value: 5 }])
  })

  it('falls back to text for display only when the UI has no matching type', () => {
    const items = toEditableProperties([{ name: 'Score', type: 'rating', value: 3 }])

    expect(toUiProperties(items)[0].type).toBe('text')
    expect(toTemplateProperties(items)[0].type).toBe('rating')
  })

  it('carries select options through to the UI shape', () => {
    const items = toEditableProperties([
      { name: 'Status', type: 'select', value: 'todo', options: ['todo', 'done'] }
    ])
    const ui = toUiProperties(items)

    expect(ui[0].type).toBe('select')
    expect(ui[0].options).toEqual(['todo', 'done'])
  })

  it('assigns unique stable ids', () => {
    const items = toEditableProperties([
      { name: 'A', type: 'text', value: '' },
      { name: 'B', type: 'text', value: '' }
    ])

    expect(items[0].id).not.toBe(items[1].id)
    expect(toUiProperties(items).map((p) => p.id)).toEqual(items.map((i) => i.id))
  })

  it('adds a property with a de-duplicated name and a type-appropriate default', () => {
    const items = toEditableProperties([{ name: 'Done', type: 'checkbox', value: false }])
    const next = addProperty(items, { name: 'Done', type: 'checkbox' })

    const stored = toTemplateProperties(next)
    expect(stored).toHaveLength(2)
    expect(stored[1].name).not.toBe('Done')
    expect(stored[1].value).toBe(false)
  })

  it('defaults number to 0, date to null, and text to empty string', () => {
    const items = addProperty(
      addProperty(addProperty([], { name: 'N', type: 'number' }), { name: 'D', type: 'date' }),
      { name: 'T', type: 'text' }
    )

    expect(toTemplateProperties(items).map((p) => p.value)).toEqual([0, null, ''])
  })

  it('renames without touching the type', () => {
    const items = toEditableProperties([
      { name: 'Old', type: 'select', value: 'x', options: ['x'] }
    ])
    const next = setPropertyName(items, items[0].id, 'New')

    expect(toTemplateProperties(next)).toEqual([
      { name: 'New', type: 'select', value: 'x', options: ['x'] }
    ])
  })

  it('reorders by id and survives it', () => {
    const items = toEditableProperties([
      { name: 'A', type: 'text', value: '' },
      { name: 'B', type: 'rating', value: 1 }
    ])
    const next = reorderProperties(items, [items[1].id, items[0].id])

    expect(toTemplateProperties(next).map((p) => p.name)).toEqual(['B', 'A'])
    expect(toTemplateProperties(next)[0].type).toBe('rating')
  })

  it('removes by id', () => {
    const items = toEditableProperties([
      { name: 'A', type: 'text', value: '' },
      { name: 'B', type: 'text', value: '' }
    ])
    const next = removeProperty(items, items[0].id)

    expect(toTemplateProperties(next).map((p) => p.name)).toEqual(['B'])
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- src/renderer/src/lib/template-properties.test.ts
```

Expected: FAIL — `Cannot find module './template-properties'`.

- [ ] **Step 3: Implement the module**

Create `apps/desktop/src/renderer/src/lib/template-properties.ts`:

```ts
/**
 * Template Property Model
 *
 * `TemplateProperty` is the stored truth. The note editor's `InfoSection`
 * speaks a narrower `PropertyType`, so a template type with no UI equivalent
 * (rating) is displayed as text — but only displayed. Nothing maps back, which
 * is what keeps `select` / `multiselect` / `rating` from degrading to `text` on
 * save the way the previous editor's two-way mapping did.
 */

import type { Property, NewProperty, PropertyType } from '@/components/note/info-section'
import { getUniquePropertyName } from '@/lib/property-utils'
import type { TemplateProperty } from '@/services/templates-service'

export interface EditableProperty {
  id: string
  property: TemplateProperty
}

let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `tplprop-${idCounter}`
}

/** Display-only widening. Never used to write back. */
function toUiType(type: TemplateProperty['type']): PropertyType {
  switch (type) {
    case 'number':
    case 'checkbox':
    case 'date':
    case 'url':
    case 'select':
    case 'multiselect':
      return type
    default:
      return 'text'
  }
}

function defaultValueFor(type: PropertyType): unknown {
  switch (type) {
    case 'checkbox':
      return false
    case 'number':
      return 0
    case 'date':
      return null
    default:
      return ''
  }
}

/** UI types map 1:1 onto stored types except `status`, which stores as select. */
function toStoredType(type: PropertyType): TemplateProperty['type'] {
  return type === 'status' ? 'select' : type
}

export function toEditableProperties(props: TemplateProperty[]): EditableProperty[] {
  return props.map((property) => ({ id: nextId(), property }))
}

export function toUiProperties(items: EditableProperty[]): Property[] {
  return items.map(({ id, property }) => ({
    id,
    name: property.name,
    type: toUiType(property.type),
    value: property.value,
    isCustom: true,
    options: property.options
  }))
}

export function toTemplateProperties(items: EditableProperty[]): TemplateProperty[] {
  return items.map((item) => item.property)
}

export function addProperty(items: EditableProperty[], next: NewProperty): EditableProperty[] {
  const name = getUniquePropertyName(
    next.name,
    items.map((item) => item.property.name)
  )
  return [
    ...items,
    {
      id: nextId(),
      property: { name, type: toStoredType(next.type), value: defaultValueFor(next.type) }
    }
  ]
}

export function setPropertyValue(
  items: EditableProperty[],
  id: string,
  value: unknown
): EditableProperty[] {
  return items.map((item) =>
    item.id === id ? { ...item, property: { ...item.property, value } } : item
  )
}

export function setPropertyName(
  items: EditableProperty[],
  id: string,
  name: string
): EditableProperty[] {
  return items.map((item) =>
    item.id === id ? { ...item, property: { ...item.property, name } } : item
  )
}

export function reorderProperties(
  items: EditableProperty[],
  orderedIds: string[]
): EditableProperty[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const reordered = orderedIds
    .map((id) => byId.get(id))
    .filter((item): item is EditableProperty => item !== undefined)
  // Anything the caller did not list keeps its relative position at the end.
  const missing = items.filter((item) => !orderedIds.includes(item.id))
  return [...reordered, ...missing]
}

export function removeProperty(items: EditableProperty[], id: string): EditableProperty[] {
  return items.filter((item) => item.id !== id)
}
```

If `NewProperty['type']` turns out not to include `'status'`, drop the `toStoredType` special case and return `type` directly — check `components/note/info-section/types.ts` before writing.

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm --filter @memry/desktop test:renderer -- src/renderer/src/lib/template-properties.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/template-properties.ts apps/desktop/src/renderer/src/lib/template-properties.test.ts
git commit -m "fix(templates): stop select/multiselect/rating property types degrading to text"
```

---

### Task 4: Template draft save hook

The save state machine, isolated from rendering so it can be tested without mounting the editor.

```
draft ──(save)──> saved ⇄ dirty ──(800ms)──> saved
```

**Files:**

- Create: `apps/desktop/src/renderer/src/hooks/use-template-draft.ts`
- Test: `apps/desktop/src/renderer/src/hooks/use-template-draft.test.ts`

**Interfaces:**

- Consumes: `EditableProperty`, `toTemplateProperties` from Task 3; `useTemplates` from `@/hooks/use-templates`.
- Produces (used by Task 5):

```ts
export interface TemplateDraftFields {
  name: string
  icon: string | null
  tags: string[]
  properties: EditableProperty[]
  content: string
}

export type TemplateSaveState = 'draft' | 'saved' | 'dirty' | 'saving'

export interface UseTemplateDraftOptions {
  templateId?: string
  initial: TemplateDraftFields
  autoSaveDelayMs?: number
}

export interface UseTemplateDraftResult {
  fields: TemplateDraftFields
  setFields: (update: Partial<TemplateDraftFields>) => void
  state: TemplateSaveState
  templateId: string | undefined
  /** True while unpersisted work exists. Drives the tab dot and the close guard. */
  isDirty: boolean
  /** False while the name is blank — Create/Update stays disabled. */
  canSave: boolean
  /** Flush now. Resolves true on success. */
  save: () => Promise<boolean>
  /** Fires once, with the new id, when a draft becomes a saved template. */
  onCreated?: (templateId: string) => void
}
```

**Behaviour contract:**

- `templateId === undefined` → `state` starts `'draft'` and `isDirty` is true as soon as any field differs from `initial` (an untouched blank draft is not dirty, so opening and immediately closing an empty new-template tab does not prompt).
- `templateId` present → `state` starts `'saved'`, `isDirty` false.
- A field edit in `'saved'` moves to `'dirty'` and schedules an auto-save `autoSaveDelayMs` later (default 800). No auto-save is ever scheduled in `'draft'`.
- Auto-save and `save()` both skip the write when the serialized payload equals the last persisted snapshot.
- `save()` in `'draft'` calls `createTemplate`, adopts the returned id, and calls `onCreated`. In `'dirty'` it calls `updateTemplate`.
- On failure: `state` returns to `'draft'` or `'dirty'`, `save()` resolves `false`, and the error is logged and toasted via `extractErrorMessage`.
- `canSave` is false when `fields.name.trim()` is empty.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/hooks/use-template-draft.test.ts`:

```ts
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTemplateDraft } from './use-template-draft'

const createTemplate = vi.fn()
const updateTemplate = vi.fn()
const toastError = vi.fn()

vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({ createTemplate, updateTemplate })
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => toastError(...args) }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })
}))

const emptyFields = {
  name: '',
  icon: null,
  tags: [] as string[],
  properties: [],
  content: ''
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  createTemplate.mockResolvedValue({ id: 'tpl-1', name: 'X' })
  updateTemplate.mockResolvedValue({ id: 'tpl-1', name: 'X' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useTemplateDraft', () => {
  it('starts as a clean draft with no id', () => {
    const { result } = renderHook(() => useTemplateDraft({ initial: emptyFields }))

    expect(result.current.state).toBe('draft')
    expect(result.current.isDirty).toBe(false)
    expect(result.current.canSave).toBe(false)
  })

  it('becomes dirty and saveable once a name is typed', () => {
    const { result } = renderHook(() => useTemplateDraft({ initial: emptyFields }))

    act(() => result.current.setFields({ name: 'Meeting' }))

    expect(result.current.isDirty).toBe(true)
    expect(result.current.canSave).toBe(true)
  })

  it('never auto-saves while in draft', () => {
    const { result } = renderHook(() => useTemplateDraft({ initial: emptyFields }))

    act(() => result.current.setFields({ name: 'Meeting' }))
    act(() => vi.advanceTimersByTime(5000))

    expect(createTemplate).not.toHaveBeenCalled()
  })

  it('save() on a draft creates and adopts the new id', async () => {
    const onCreated = vi.fn()
    const { result } = renderHook(() => useTemplateDraft({ initial: emptyFields, onCreated }))

    act(() => result.current.setFields({ name: '  Meeting  ' }))
    await act(async () => {
      await result.current.save()
    })

    expect(createTemplate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Meeting' }))
    expect(onCreated).toHaveBeenCalledWith('tpl-1')
    expect(result.current.templateId).toBe('tpl-1')
    expect(result.current.state).toBe('saved')
    expect(result.current.isDirty).toBe(false)
  })

  it('auto-saves an existing template after the debounce', async () => {
    const { result } = renderHook(() =>
      useTemplateDraft({
        templateId: 'tpl-1',
        initial: { ...emptyFields, name: 'Meeting' }
      })
    )

    expect(result.current.state).toBe('saved')
    act(() => result.current.setFields({ content: 'hello' }))
    expect(result.current.state).toBe('dirty')

    await act(async () => {
      vi.advanceTimersByTime(800)
    })

    await waitFor(() => expect(updateTemplate).toHaveBeenCalledTimes(1))
    expect(updateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tpl-1', content: 'hello' })
    )
  })

  it('coalesces rapid edits into one write', async () => {
    const { result } = renderHook(() =>
      useTemplateDraft({
        templateId: 'tpl-1',
        initial: { ...emptyFields, name: 'Meeting' }
      })
    )

    act(() => result.current.setFields({ content: 'a' }))
    act(() => vi.advanceTimersByTime(400))
    act(() => result.current.setFields({ content: 'ab' }))
    await act(async () => {
      vi.advanceTimersByTime(800)
    })

    await waitFor(() => expect(updateTemplate).toHaveBeenCalledTimes(1))
    expect(updateTemplate).toHaveBeenCalledWith(expect.objectContaining({ content: 'ab' }))
  })

  it('skips the write when the payload is unchanged', async () => {
    const { result } = renderHook(() =>
      useTemplateDraft({
        templateId: 'tpl-1',
        initial: { ...emptyFields, name: 'Meeting' }
      })
    )

    act(() => result.current.setFields({ content: 'a' }))
    act(() => result.current.setFields({ content: '' }))
    await act(async () => {
      vi.advanceTimersByTime(800)
    })

    expect(updateTemplate).not.toHaveBeenCalled()
    expect(result.current.isDirty).toBe(false)
  })

  it('keeps the tab dirty when a save fails', async () => {
    updateTemplate.mockResolvedValue(null)
    const { result } = renderHook(() =>
      useTemplateDraft({
        templateId: 'tpl-1',
        initial: { ...emptyFields, name: 'Meeting' }
      })
    )

    act(() => result.current.setFields({ content: 'hello' }))
    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current.save()
    })

    expect(saved).toBe(false)
    expect(result.current.isDirty).toBe(true)
    expect(toastError).toHaveBeenCalled()
  })

  it('refuses to save a blank name', async () => {
    const { result } = renderHook(() => useTemplateDraft({ initial: emptyFields }))

    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current.save()
    })

    expect(saved).toBe(false)
    expect(createTemplate).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- src/renderer/src/hooks/use-template-draft.test.ts
```

Expected: FAIL — `Cannot find module './use-template-draft'`.

- [ ] **Step 3: Implement the hook**

Create `apps/desktop/src/renderer/src/hooks/use-template-draft.ts`:

```ts
/**
 * Template Draft
 *
 * A new template is an in-memory draft until the user clicks Create; from then
 * on every edit auto-saves silently, the way a note does. Nothing is written
 * while in draft, so a half-typed template never litters the template list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useTemplates } from '@/hooks/use-templates'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { toTemplateProperties, type EditableProperty } from '@/lib/template-properties'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('Hook:TemplateDraft')

const DEFAULT_AUTO_SAVE_DELAY_MS = 800

export interface TemplateDraftFields {
  name: string
  icon: string | null
  tags: string[]
  properties: EditableProperty[]
  content: string
}

export type TemplateSaveState = 'draft' | 'saved' | 'dirty' | 'saving'

export interface UseTemplateDraftOptions {
  templateId?: string
  initial: TemplateDraftFields
  autoSaveDelayMs?: number
  onCreated?: (templateId: string) => void
}

export interface UseTemplateDraftResult {
  fields: TemplateDraftFields
  setFields: (update: Partial<TemplateDraftFields>) => void
  state: TemplateSaveState
  templateId: string | undefined
  isDirty: boolean
  canSave: boolean
  save: () => Promise<boolean>
}

function serialize(fields: TemplateDraftFields): string {
  return JSON.stringify({
    name: fields.name.trim(),
    icon: fields.icon,
    tags: fields.tags,
    properties: toTemplateProperties(fields.properties),
    content: fields.content
  })
}

export function useTemplateDraft({
  templateId: initialTemplateId,
  initial,
  autoSaveDelayMs = DEFAULT_AUTO_SAVE_DELAY_MS,
  onCreated
}: UseTemplateDraftOptions): UseTemplateDraftResult {
  const { t } = useT('notes')
  const { createTemplate, updateTemplate } = useTemplates({ autoLoad: false })

  const [fields, setFieldsState] = useState<TemplateDraftFields>(initial)
  const [templateId, setTemplateId] = useState<string | undefined>(initialTemplateId)
  const [isSaving, setIsSaving] = useState(false)

  // The payload as last persisted (or as loaded). Dirtiness and the no-op
  // skip are both measured against this, so a round-trip back to the original
  // value correctly reads as clean.
  const persistedRef = useRef<string>(serialize(initial))
  const current = useMemo(() => serialize(fields), [fields])
  const isDirty = current !== persistedRef.current

  const fieldsRef = useRef(fields)
  fieldsRef.current = fields
  const templateIdRef = useRef(templateId)
  templateIdRef.current = templateId

  const state: TemplateSaveState = isSaving
    ? 'saving'
    : templateId === undefined
      ? 'draft'
      : isDirty
        ? 'dirty'
        : 'saved'

  const canSave = fields.name.trim().length > 0

  const setFields = useCallback((update: Partial<TemplateDraftFields>) => {
    setFieldsState((prev) => ({ ...prev, ...update }))
  }, [])

  const save = useCallback(async (): Promise<boolean> => {
    const snapshot = fieldsRef.current
    const name = snapshot.name.trim()
    if (name.length === 0) return false

    const payload = serialize(snapshot)
    if (payload === persistedRef.current) return true

    setIsSaving(true)
    try {
      const id = templateIdRef.current
      const properties = toTemplateProperties(snapshot.properties)

      if (id === undefined) {
        const created = await createTemplate({
          name,
          icon: snapshot.icon,
          tags: snapshot.tags,
          properties,
          content: snapshot.content
        })
        if (!created) {
          toast.error(t('templateEditor.toast.createFailed'))
          return false
        }
        persistedRef.current = payload
        setTemplateId(created.id)
        onCreated?.(created.id)
        return true
      }

      const updated = await updateTemplate({
        id,
        name,
        icon: snapshot.icon,
        tags: snapshot.tags,
        properties,
        content: snapshot.content
      })
      if (!updated) {
        toast.error(t('templateEditor.toast.saveFailed'))
        return false
      }
      persistedRef.current = payload
      return true
    } catch (err) {
      log.error('Failed to save template:', err)
      toast.error(extractErrorMessage(err, t('templateEditor.toast.saveFailed')))
      return false
    } finally {
      setIsSaving(false)
    }
  }, [createTemplate, updateTemplate, onCreated, t])

  const saveRef = useRef(save)
  saveRef.current = save

  // Auto-save only once the template exists. A draft is committed by the
  // Create button, never by a timer.
  useEffect(() => {
    if (templateId === undefined) return
    if (!isDirty) return

    const timer = setTimeout(() => {
      void saveRef.current()
    }, autoSaveDelayMs)

    return () => clearTimeout(timer)
  }, [templateId, isDirty, current, autoSaveDelayMs])

  return { fields, setFields, state, templateId, isDirty, canSave, save }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm --filter @memry/desktop test:renderer -- src/renderer/src/hooks/use-template-draft.test.ts
```

Expected: PASS, 9 tests. If the "skips the write when the payload is unchanged" case is red, the `persistedRef` comparison is being made against a stale snapshot — check that `serialize` is called on `initial`, not on the first render's `fields`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-template-draft.ts apps/desktop/src/renderer/src/hooks/use-template-draft.test.ts
git commit -m "feat(templates): add draft-then-autosave state machine hook"
```

---

### Task 5: Rewrite the template editor page

**Files:**

- Rewrite: `apps/desktop/src/renderer/src/pages/template-editor.tsx`
- Replace: `apps/desktop/src/renderer/src/pages/template-editor.test.tsx`

**Interfaces:**

- Consumes: `setTabEntity`, `registerCloseGuard` (Tasks 1-2); `template-properties` helpers (Task 3); `useTemplateDraft` (Task 4).
- Produces: `TemplateEditorPage({ templateId }: { templateId?: string })`, default export unchanged, so `tab-content.tsx:203` keeps working as-is.

**Layout contract:**

- `NoteLayout` with `actions`, no `breadcrumb`, no `sideRail`, no `stats`.
- Metadata block: `IconPickerButton` + `NoteTitle` (name), `TagsRow` (`hideWhenEmpty`, `hideAddButton`), `InfoSection` (`variant="embedded"`, `hideAddButton`, rendered only when properties exist), `GhostAffordanceRow`.
- `ContentArea` unboxed, placeholder carries the `{{title}}` hint.
- `actions`: primary button — **Create Template** in draft, **Update** when dirty, **Duplicate & Edit** for built-ins — plus a ⋯ `Picker` with Duplicate and Delete for custom templates.
- Built-in: every input `disabled`, `ContentArea` `editable={false}`, no ⋯ menu.

- [ ] **Step 1: Write the failing test**

Replace `apps/desktop/src/renderer/src/pages/template-editor.test.tsx` entirely. Keep the module-mock style of the file being replaced (read it first — it already mocks `@memry/i18n/renderer`, `@tanstack/react-query`, `@/hooks/use-templates`, `@/hooks/use-notes-query`, `@/contexts/tabs`, `@/hooks/use-note-editor-settings`, `sonner`, `@/lib/logger`, and the note components). Carry those mocks over, add mocks for `@/components/note/note-layout`, `@/components/note/ghost-affordance-row`, `@/components/note/content-area`, and `@/components/icon-picker-button`, and write:

```tsx
describe('TemplateEditorPage', () => {
  it('renders the note surface, not a form header', () => {
    render(<TemplateEditorPage />)

    expect(screen.getByLabelText('template title')).toBeInTheDocument()
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument()
  })

  it('disables Create while the name is blank', () => {
    render(<TemplateEditorPage />)

    expect(screen.getByRole('button', { name: /create template/i })).toBeDisabled()
  })

  it('writes nothing until Create is clicked', async () => {
    const user = userEvent.setup()
    render(<TemplateEditorPage />)

    await user.type(screen.getByLabelText('template title'), 'Meeting')
    expect(createTemplate).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /create template/i }))
    await waitFor(() => expect(createTemplate).toHaveBeenCalledTimes(1))
  })

  it('adopts the new id on the tab and flips the button to Update', async () => {
    const user = userEvent.setup()
    createTemplate.mockResolvedValue({ id: 'tpl-1', name: 'Meeting' })
    render(<TemplateEditorPage />)

    await user.type(screen.getByLabelText('template title'), 'Meeting')
    await user.click(screen.getByRole('button', { name: /create template/i }))

    await waitFor(() =>
      expect(setTabEntity).toHaveBeenCalledWith('tab-1', 'tpl-1', '/templates/tpl-1')
    )
    expect(await screen.findByRole('button', { name: /update/i })).toBeInTheDocument()
  })

  it('tracks the tab title live and marks the tab modified', async () => {
    const user = userEvent.setup()
    render(<TemplateEditorPage />)

    await user.type(screen.getByLabelText('template title'), 'M')

    await waitFor(() => expect(updateTabTitle).toHaveBeenCalledWith('tab-1', 'M'))
    expect(setTabModified).toHaveBeenCalledWith('tab-1', true)
  })

  it('falls back to New Template when the name is cleared', async () => {
    const user = userEvent.setup()
    render(<TemplateEditorPage />)

    const title = screen.getByLabelText('template title')
    await user.type(title, 'M')
    await user.clear(title)

    await waitFor(() => expect(updateTabTitle).toHaveBeenLastCalledWith('tab-1', 'New Template'))
  })

  it('registers a close guard that reports the draft as dirty', async () => {
    const user = userEvent.setup()
    render(<TemplateEditorPage />)

    await user.type(screen.getByLabelText('template title'), 'Meeting')

    expect(registerCloseGuard).toHaveBeenCalledWith('tab-1', expect.any(Object))
    const guard = registerCloseGuard.mock.calls.at(-1)[1]
    expect(guard.isDirty()).toBe(true)
  })

  it('renders a built-in read-only with a Duplicate & Edit action', async () => {
    queryData = {
      id: 'tpl-builtin',
      name: 'Daily',
      isBuiltIn: true,
      tags: [],
      properties: [],
      content: 'body'
    }
    const user = userEvent.setup()
    render(<TemplateEditorPage templateId="tpl-builtin" />)

    expect(screen.getByLabelText('template title')).toBeDisabled()
    expect(screen.queryByRole('button', { name: /^update$/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /duplicate & edit/i }))
    await waitFor(() =>
      expect(duplicateTemplate).toHaveBeenCalledWith('tpl-builtin', expect.any(String))
    )
  })

  it('preserves a select property type when only the title is edited', async () => {
    queryData = {
      id: 'tpl-1',
      name: 'Meeting',
      isBuiltIn: false,
      tags: [],
      properties: [{ name: 'Status', type: 'select', value: 'todo', options: ['todo', 'done'] }],
      content: ''
    }
    const user = userEvent.setup()
    render(<TemplateEditorPage templateId="tpl-1" />)

    await user.type(screen.getByLabelText('template title'), ' Notes')
    await user.click(screen.getByRole('button', { name: /update/i }))

    await waitFor(() => expect(updateTemplate).toHaveBeenCalled())
    expect(updateTemplate.mock.calls.at(-1)[0].properties).toEqual([
      { name: 'Status', type: 'select', value: 'todo', options: ['todo', 'done'] }
    ])
  })
})
```

The `@/contexts/tabs` mock must now expose the new methods:

```tsx
vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ closeTab, updateTabTitle, setTabModified, setTabEntity, registerCloseGuard }),
  useActiveTab: () => activeTab
}))
```

with `registerCloseGuard` returning an unregister function: `const registerCloseGuard = vi.fn(() => () => {})`.

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- src/renderer/src/pages/template-editor.test.tsx
```

Expected: FAIL — the old page renders its own header and has no Create/Update button by these names.

- [ ] **Step 3: Rewrite the page**

Replace the contents of `apps/desktop/src/renderer/src/pages/template-editor.tsx`. Structure:

```tsx
/**
 * Template Editor Page
 *
 * A template is authored on the note surface: same title, tags, properties and
 * content editor a note uses. A new template is an in-memory draft until the
 * Create button is pressed; after that every edit auto-saves.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'

import { NoteLayout } from '@/components/note'
import { ContentArea } from '@/components/note/content-area'
import { GhostAffordanceRow } from '@/components/note/ghost-affordance-row'
import { InfoSection, type NewProperty } from '@/components/note/info-section'
import { NoteTitle } from '@/components/note/note-title'
import { TagsRow, type Tag } from '@/components/note/tags-row'
import { IconPickerButton } from '@/components/icon-picker-button'
import { Button } from '@/components/ui/button'
import { Picker } from '@/components/ui/picker'
import { Copy, FileText, Loader2, Trash2 } from '@/lib/icons'
import { useTemplates } from '@/hooks/use-templates'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useNoteEditorSettings } from '@/hooks/use-note-editor-settings'
import { useTabs, useActiveTab } from '@/contexts/tabs'
import { useTemplateDraft } from '@/hooks/use-template-draft'
import {
  addProperty,
  removeProperty,
  reorderProperties,
  setPropertyName,
  setPropertyValue,
  toEditableProperties,
  toUiProperties
} from '@/lib/template-properties'
import { createLogger } from '@/lib/logger'
import { useT } from '@memry/i18n/renderer'
```

Then, in order:

1. `TemplateEditorPage({ templateId })` loads the template with the existing `useQuery({ queryKey: ['template-editor', templateId], enabled: !!templateId })`. While `templateId && isLoading`, return the existing spinner state.
2. Build `initial: TemplateDraftFields` with `useMemo` from the loaded template (`properties: toEditableProperties(template?.properties ?? [])`).
3. Render `<TemplateEditorSurface key={templateId ?? 'new'} … />` so a tab switch remounts with fresh state — the same guard `note.tsx` applies via its `key`.
4. In the surface component call `useTemplateDraft({ templateId, initial, onCreated })`.
5. `onCreated` calls `setTabEntity(activeTab.id, id, '/templates/' + id)`.
6. An effect syncs the tab: `updateTabTitle(tabId, fields.name.trim() || t('templateEditor.title.new'))` and `setTabModified(tabId, isDirty)`.
7. An effect registers the close guard, reading through refs so the registration is stable:

```tsx
const isDirtyRef = useRef(isDirty)
isDirtyRef.current = isDirty
const saveRef = useRef(save)
saveRef.current = save

useEffect(() => {
  if (!tabId || isBuiltIn) return
  return registerCloseGuard(tabId, {
    isDirty: () => isDirtyRef.current,
    save: () => saveRef.current()
  })
}, [tabId, isBuiltIn, registerCloseGuard])
```

8. Tag handling mirrors the file being replaced: keep the `pendingTagColorsRef` map so a freshly created tag shows its colour before `useNoteTagsQuery` catches up, and build `templateTags`/`availableTags` the same way.
9. Property handlers route through the Task 3 helpers:

```tsx
const handlePropertyChange = useCallback(
  (id: string, value: unknown) =>
    setFields({ properties: setPropertyValue(fields.properties, id, value) }),
  [fields.properties, setFields]
)
```

and likewise `setPropertyName`, `reorderProperties` (`onPropertyOrderChange` hands you the ordered id array), `addProperty`, `removeProperty`.

10. The action area:

```tsx
const actions = (
  <div className="flex items-center gap-1.5">
    {isBuiltIn ? (
      <Button size="sm" onClick={() => void handleDuplicateAndEdit()}>
        {t('templateEditor.actions.duplicateAndEdit')}
      </Button>
    ) : (
      <>
        <Button
          size="sm"
          disabled={!canSave || state === 'saving' || (templateId !== undefined && !isDirty)}
          onClick={() => void save()}
        >
          {state === 'saving' && <Loader2 className="size-3.5 me-1.5 animate-spin" />}
          {templateId === undefined
            ? t('templateEditor.actions.create')
            : t('templateEditor.actions.update')}
        </Button>
        {templateId !== undefined && (
          /* ⋯ Picker with Duplicate and Delete, modelled on note.tsx:1172-1311 */
        )}
      </>
    )}
  </div>
)
```

11. `ContentArea` gets `initialContent={initial.content}`, `contentType="markdown"`, `placeholder={t('templateEditor.content.placeholder')}` (the string that carries the `{{title}}` hint), `stickyToolbar={editorSettings.toolbarMode === 'sticky'}`, `onMarkdownChange={(md) => setFields({ content: md })}`, `editable={!isBuiltIn}`.

12. Delete closes the tab after a successful `deleteTemplate`; duplicate opens the copy in a new tab via `openTab({ type: 'template-editor', … entityId: copy.id })`.

Do not carry over `getDefaultValueForType`, `mapToTemplatePropertyType`, `mapFromTemplatePropertyType`, the `description` state, or the old header — they are all replaced.

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm --filter @memry/desktop test:renderer -- src/renderer/src/pages/template-editor.test.tsx
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck the renderer**

```bash
pnpm --filter @memry/desktop typecheck:web
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/template-editor.tsx apps/desktop/src/renderer/src/pages/template-editor.test.tsx
git commit -m "feat(templates): author templates on the note surface"
```

---

### Task 6: Settings entry point

Row click currently opens an in-settings preview. With the preview gone, the row opens the editor tab directly.

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/settings/templates-section.tsx`
- Delete: `apps/desktop/src/renderer/src/pages/settings/template-preview.tsx`
- Delete: `apps/desktop/src/renderer/src/pages/settings/template-preview.test.tsx`
- Test: `apps/desktop/src/renderer/src/pages/settings/templates-section.test.tsx`

**Interfaces:**

- Consumes: the `template-editor` tab type, unchanged.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

In `templates-section.test.tsx`, replace any preview-related assertions with:

```tsx
it('opens the editor tab when a row is clicked', async () => {
  const user = userEvent.setup()
  render(<TemplatesSettings />)

  await user.click(await screen.findByRole('button', { name: 'Meeting Notes' }))

  expect(openTab).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'template-editor', entityId: 'tpl-1' })
  )
  expect(closeSettings).toHaveBeenCalled()
})

it('opens built-in templates in the same tab type', async () => {
  const user = userEvent.setup()
  render(<TemplatesSettings />)

  await user.click(await screen.findByRole('button', { name: 'Daily Journal' }))

  expect(openTab).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'template-editor', entityId: 'tpl-builtin' })
  )
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- src/renderer/src/pages/settings/templates-section.test.tsx
```

Expected: FAIL — the row click sets preview state instead of opening a tab.

- [ ] **Step 3: Rewire the section**

In `templates-section.tsx`:

- Delete the `previewId` state, the `if (previewId) return <TemplatePreview … />` early return, and the `TemplatePreview` import.
- Point both `TemplateRow` `onSelect` props at `handleEditTemplate(template.id, template.name)`.
- Leave the row ⋯ menu (Edit / Duplicate / Delete) as it is; Edit already calls the same handler.

- [ ] **Step 4: Delete the preview files**

```bash
git rm apps/desktop/src/renderer/src/pages/settings/template-preview.tsx apps/desktop/src/renderer/src/pages/settings/template-preview.test.tsx
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
pnpm --filter @memry/desktop test:renderer -- src/renderer/src/pages/settings
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings
git commit -m "feat(settings): open templates in the editor tab instead of an inline preview"
```

---

### Task 7: Remove the dead templates list page

`pages/templates.tsx` (19K) renders a `templates` tab that nothing in the app ever opens. Removing the tab type is safe on restore: `isRestorableTabType` (`persistence/serialization.ts:24`) returns `true` for types it does not recognise as feature flags, so a stored `templates` tab would be restored and land on the `default` branch of `tab-content.tsx:252` — a benign "Unknown tab type" panel, not a crash. No migration is needed.

**Files:**

- Delete: `apps/desktop/src/renderer/src/pages/templates.tsx`, `apps/desktop/src/renderer/src/pages/templates.test.tsx`
- Modify: `apps/desktop/src/renderer/src/contexts/tabs/types.ts` (drop `'templates'` from `TabType` and from `SINGLETON_TAB_TYPES`)
- Modify: `apps/desktop/src/renderer/src/components/split-view/tab-content.tsx` (drop the lazy import and the `case 'templates'` at ~line 206)
- Modify: `apps/desktop/src/renderer/src/App.tsx:140`
- Modify: `apps/desktop/src/renderer/src/contexts/tabs/helpers.ts:148`
- Modify: `apps/desktop/src/renderer/src/components/tabs/tab-icon.tsx:99`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing. Purely subtractive.

- [ ] **Step 1: Delete the page and its test**

```bash
git rm apps/desktop/src/renderer/src/pages/templates.tsx apps/desktop/src/renderer/src/pages/templates.test.tsx
```

- [ ] **Step 2: Remove every registration**

Delete the `'templates'` entries at `types.ts` (union member and `SINGLETON_TAB_TYPES`), `App.tsx:140`, `helpers.ts:148`, `tab-icon.tsx:99`, and both the `LazyTemplatesPage` definition and its `case` in `tab-content.tsx`. Leave every `'template-editor'` entry alone — the two are one character apart, so re-read each hunk before saving.

- [ ] **Step 3: Verify nothing still references it**

```bash
grep -rn "'templates'" apps/desktop/src/renderer/src --include="*.ts" --include="*.tsx" | grep -v "settings"
```

Expected: no hits outside the settings-modal section id (`contexts/settings-modal-context.tsx`, `pages/settings.tsx`), which is an unrelated string.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @memry/desktop typecheck:web
```

Expected: clean. A non-exhaustive-switch error here means a `case 'templates'` was missed.

- [ ] **Step 5: Commit**

```bash
git add -A apps/desktop/src/renderer/src
git commit -m "chore(tabs): remove the unreachable templates list page and tab type"
```

---

### Task 8: Translations

**Files:**

- Modify: `packages/i18n/src/locales/en/notes.json` and the same file in all 31 other locale directories
- Modify: `packages/i18n/src/locales/*/settings.json` only if Task 6 introduced a new settings string

**Interfaces:**

- Consumes: the key names used in Tasks 4-6.
- Produces: nothing downstream.

**Keys to add** under `templateEditor` in `notes.json`:

```json
{
  "templateEditor": {
    "actions": {
      "create": "Create Template",
      "update": "Update",
      "duplicateAndEdit": "Duplicate & Edit",
      "duplicate": "Duplicate",
      "delete": "Delete Template"
    },
    "content": {
      "placeholder": "Default content for notes created from this template. Use {'{{title}}'} to insert the note title."
    },
    "namePlaceholder": "Template name",
    "iconLabel": "Template icon",
    "toast": {
      "duplicated": "Template duplicated",
      "deleted": "Template deleted"
    }
  }
}
```

The existing `templateEditor.title.*` and `templateEditor.toast.*` keys stay; `templateEditor.title.new` is reused as the fallback tab title.

**Keys to remove** — the whole `phaseF.pagesTemplateEditor` block, whose nine keys all belonged to the deleted header, description field and hint text. Remove it from every locale.

- [ ] **Step 1: Add the English keys**

Edit `packages/i18n/src/locales/en/notes.json`. Note the ICU escaping: a literal `{{title}}` in a translated string must be written `{'{{title}}'}` or i18next will treat it as an interpolation.

- [ ] **Step 2: Verify the English gate passes**

```bash
pnpm --filter @memry/desktop i18n:check
```

Expected: pass with no missing-English errors. Missing non-English keys report as warnings at this stage.

- [ ] **Step 3: Fill the other 31 locales**

For each directory under `packages/i18n/src/locales/` other than `en`, add the same `templateEditor` keys translated, and delete the `phaseF.pagesTemplateEditor` block. Keep the ICU escaping identical in every locale — the `{'{{title}}'}` literal is not translated.

- [ ] **Step 4: Re-run the check and the renderer suite**

```bash
pnpm --filter @memry/desktop i18n:check
pnpm --filter @memry/desktop test:renderer
```

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/src/locales
git commit -m "i18n: template editor strings across all locales"
```

---

### Task 9: Full verification

**Files:** none — this task only runs checks and fixes what they surface.

- [ ] **Step 1: Typecheck everything**

```bash
pnpm typecheck
```

Expected: clean. `typecheck:node` has a pre-existing failure in `schemas.ts` (TS1117, duplicate canvas schema keys) unrelated to this work — if it appears, confirm it also fails on `origin/main` before spending time on it.

- [ ] **Step 2: Lint**

```bash
pnpm lint
```

Expected: clean. Re-run with `--no-cache` if it passes suspiciously fast — the ESLint cache has masked warnings before.

- [ ] **Step 3: Desktop test suite**

```bash
pnpm test:desktop
```

Expected: green.

- [ ] **Step 4: Architecture and contract boundaries**

```bash
pnpm check:architecture
pnpm check:contracts
```

Expected: clean. No IPC contract changed, so `pnpm ipc:check` is not required.

- [ ] **Step 5: Whitespace**

```bash
git diff --check origin/main
```

Expected: no output.

- [ ] **Step 6: Docs gate**

```bash
pnpm docs:impact --base origin/main --strict
```

If it reports `missing-docs`, update the affected pages under `apps/docs/src/**` — the template authoring flow and any screenshot or step list describing the old create screen — or run `pnpm docs:ai-update --base origin/main`, then re-run the strict check and `pnpm docs:build`.

- [ ] **Step 7: Manual smoke in the running app**

```bash
pnpm dev
```

Walk the flow and confirm each: Settings → Templates → **New** opens a note-looking tab; typing a name updates the tab title and shows the unsaved dot; closing the tab prompts; **Create Template** saves and the button becomes **Update**; editing again saves silently within a second; reopening from Settings shows the saved content; a built-in opens read-only with **Duplicate & Edit**; a template with a select property survives an unrelated edit with its type intact; the new template appears in the note template picker and in Settings → Journal's default-template list.

- [ ] **Step 8: Commit any fixes**

```bash
git add -A
git commit -m "fix(templates): address verification findings"
```

(Skip if nothing needed fixing.)

---

## Self-Review

**Spec coverage**

| Spec section                             | Task               |
| ---------------------------------------- | ------------------ |
| §1 The editing surface                   | 5                  |
| §1 Icon via `IconPickerButton`           | 5                  |
| §1 `{{title}}` hint in the placeholder   | 5, 8               |
| §2 Save state machine                    | 4, 5               |
| §2 Draft tab title + dirty dot           | 5                  |
| §2 Built-in read-only + Duplicate & Edit | 5                  |
| §2 Sync no-op skip                       | 4                  |
| §3 Property round-trip                   | 3, 5               |
| §4 Close guard, all paths                | 2                  |
| §4 `useUnsavedChangesGuard` deleted      | 2                  |
| §5 Settings entry point                  | 6                  |
| §6 Deletions                             | 2, 6, 7            |
| Testing                                  | every task, plus 9 |
| i18n across 32 locales                   | 8                  |

Task 1 (`setTabEntity`) is not named in the spec; it is the mechanism §2's "write `entityId` and path onto the tab" requires, and no existing action can do it.

**Placeholder scan:** none. Every code step carries the code. Task 5's step 3 is prose-plus-fragments rather than one whole-file listing, because the file is ~450 lines and most of it (tag colour handling, the ⋯ `Picker` block) is carried over from named line ranges in the file being replaced — those line references are given so the implementer copies rather than invents.

**Type consistency:** `TemplateDraftFields.properties` is `EditableProperty[]` in both Task 3 and Task 4. `save()` returns `Promise<boolean>` in `UseTemplateDraftResult` (Task 4) and in `TabCloseGuard` (Task 2), so the page passes it through unwrapped. `registerCloseGuard` returns `() => void` in Task 2 and is consumed as an effect cleanup in Task 5. `setTabEntity(tabId, entityId, path, groupId?)` in Task 1 matches the three-argument call in Task 5.
