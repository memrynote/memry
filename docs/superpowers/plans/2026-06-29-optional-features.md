# Optional Features (Module Toggles) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users turn each top-level feature (Home, Inbox, Journal, Tasks, Calendar, Graph) on/off from a new Settings → Features section; off = ghosted-but-visible sidebar item that redirects to Features, the page unreachable by any path, and all related actions disabled.

**Architecture:** New `features` settings group (6 booleans, default on) reusing the existing JSON-blob group-settings pattern (`settings-schemas.ts` + generic `read/writeGroupSettings` + a `use-feature-flags` hook copied from `use-calendar-preferences`). Enforcement is read-time gating at each entry point (sidebar click guard, session-restore filter, creation/conversion actions, day panel), driven by a shared `featureForTabType` mapping. Home off turns the always-present landing tab into an empty "Create note" launcher.

**Tech Stack:** TypeScript, React 19, Zod (contracts), Electron IPC (`window.api.settings`), Vitest, electron-log `createLogger`, Tailwind logical props.

## Global Constraints

- Pre-production: no back-compat / migration. Flags default **on**.
- Prettier: single quotes, no semicolons, 100 char width, no trailing commas.
- Logging via `createLogger('Scope')`; user-facing errors via `extractErrorMessage(err, fallback)`.
- All renderer↔main IPC goes through `packages/contracts`; run `pnpm ipc:generate` then `pnpm ipc:check` after editing contract channels.
- New Tailwind classes must be logical (`ms/me`, `ps/pe`, `start/end`, `text-start/end`), never physical.
- i18n: custom ICU formatter → single-brace `{count}`; only `en` is enforced by `i18n:check`.
- Native module ABI: if a `better-sqlite3` test throws `ERR_DLOPEN_FAILED`, run `pnpm --filter @memry/desktop rebuild:node` in the same shell before vitest.
- Feature flag keys are exactly the `TabType`/`AppPage` names: `home`, `inbox`, `journal`, `tasks`, `calendar`, `graph`.

---

### Task 1: Feature-flags contract (schema + channel + mapping)

**Files:**
- Modify: `packages/contracts/src/settings-schemas.ts` (append a new group after the Calendar group ~line 179)
- Create: `packages/contracts/src/feature-flags.ts`
- Modify: `packages/contracts/src/ipc-channels.ts` (add two keys to `SettingsChannels.invoke`, after `SET_CALENDAR_SETTINGS` ~line 404)
- Test: `packages/contracts/src/feature-flags.test.ts`

**Interfaces:**
- Produces: `FeaturesSettingsSchema`, `type FeaturesSettings`, `FEATURES_SETTINGS_DEFAULTS`, `type FeatureKey`, `FEATURE_KEYS`, `featureForTabType(type: string): FeatureKey | null`.
- Produces: channels `SettingsChannels.invoke.GET_FEATURES_SETTINGS = 'settings:getFeaturesSettings'`, `SET_FEATURES_SETTINGS = 'settings:setFeaturesSettings'`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/feature-flags.test.ts
import { describe, it, expect } from 'vitest'
import { FEATURES_SETTINGS_DEFAULTS, FeaturesSettingsSchema } from './settings-schemas'
import { featureForTabType, FEATURE_KEYS } from './feature-flags'

describe('feature flags', () => {
  it('defaults every feature on', () => {
    expect(FeaturesSettingsSchema.parse(FEATURES_SETTINGS_DEFAULTS)).toEqual({
      home: true,
      inbox: true,
      journal: true,
      tasks: true,
      calendar: true,
      graph: true
    })
  })

  it('maps a known tab type to its feature key', () => {
    expect(featureForTabType('tasks')).toBe('tasks')
    expect(featureForTabType('calendar')).toBe('calendar')
  })

  it('returns null for a non-feature tab type', () => {
    expect(featureForTabType('note')).toBeNull()
    expect(featureForTabType('settings')).toBeNull()
  })

  it('keeps FEATURE_KEYS aligned with the schema shape', () => {
    expect([...FEATURE_KEYS].sort()).toEqual(Object.keys(FEATURES_SETTINGS_DEFAULTS).sort())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/contracts test -- feature-flags`
Expected: FAIL — `featureForTabType`/`FEATURE_KEYS` not exported; schema not defined.

- [ ] **Step 3: Add the schema group** (append to `packages/contracts/src/settings-schemas.ts`)

```ts
// ============================================================================
// Features Settings (optional module toggles)
// ============================================================================

export const FeaturesSettingsSchema = z.object({
  home: z.boolean(),
  inbox: z.boolean(),
  journal: z.boolean(),
  tasks: z.boolean(),
  calendar: z.boolean(),
  graph: z.boolean()
})

export type FeaturesSettings = z.infer<typeof FeaturesSettingsSchema>

export const FEATURES_SETTINGS_DEFAULTS: FeaturesSettings = {
  home: true,
  inbox: true,
  journal: true,
  tasks: true,
  calendar: true,
  graph: true
}
```

- [ ] **Step 4: Create the mapping module** (`packages/contracts/src/feature-flags.ts`)

```ts
import type { FeaturesSettings } from './settings-schemas'

export type FeatureKey = keyof FeaturesSettings

export const FEATURE_KEYS = ['home', 'inbox', 'journal', 'tasks', 'calendar', 'graph'] as const

/**
 * A tab/page type maps 1:1 to a feature key when it represents a toggleable
 * feature. Returns null for everything else (notes, settings, etc.).
 */
export function featureForTabType(type: string): FeatureKey | null {
  return (FEATURE_KEYS as readonly string[]).includes(type) ? (type as FeatureKey) : null
}
```

- [ ] **Step 5: Add the IPC channels** (insert in `packages/contracts/src/ipc-channels.ts` after `SET_CALENDAR_SETTINGS`)

```ts
    /** Get feature module toggles (home/inbox/journal/tasks/calendar/graph) */
    GET_FEATURES_SETTINGS: 'settings:getFeaturesSettings',
    /** Update feature module toggles (partial merge) */
    SET_FEATURES_SETTINGS: 'settings:setFeaturesSettings',
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @memry/contracts test -- feature-flags`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/settings-schemas.ts packages/contracts/src/feature-flags.ts packages/contracts/src/ipc-channels.ts packages/contracts/src/feature-flags.test.ts
git commit -m "feat(features): add feature-flags settings schema, channels, tab mapping"
```

---

### Task 2: Main-process handlers + IPC regen

**Files:**
- Modify: `apps/desktop/src/main/ipc/settings-handlers.ts` (register pair inside `registerSettingsHandlers()` near the Calendar pair ~line 828; add `removeHandler` pair in teardown ~line 990; import the defaults)
- Modify (generated): `apps/desktop/src/preload/generated-rpc.ts`, `apps/desktop/src/preload/index.d.ts` via `pnpm ipc:generate`

**Interfaces:**
- Consumes: `FEATURES_SETTINGS_DEFAULTS` (Task 1), `SettingsChannels.invoke.GET/SET_FEATURES_SETTINGS` (Task 1).
- Produces: `window.api.settings.getFeaturesSettings()` / `setFeaturesSettings(updates)` in the renderer types.

- [ ] **Step 1: Add the import** (top of `settings-handlers.ts`, alongside the existing `CALENDAR_SETTINGS_DEFAULTS` import)

```ts
import { FEATURES_SETTINGS_DEFAULTS, type FeaturesSettings } from '@memry/contracts/settings-schemas'
```

- [ ] **Step 2: Register the handler pair** (inside `registerSettingsHandlers()`, right after the calendar pair at ~828)

```ts
  ipcMain.handle(SettingsChannels.invoke.GET_FEATURES_SETTINGS, () =>
    readGroupSettings('features', FEATURES_SETTINGS_DEFAULTS)
  )
  ipcMain.handle(
    SettingsChannels.invoke.SET_FEATURES_SETTINGS,
    (_event, updates: Partial<FeaturesSettings>) =>
      writeGroupSettings('features', FEATURES_SETTINGS_DEFAULTS, updates)
  )
```

- [ ] **Step 3: Add teardown** (in the unregister block ~990, beside the other `removeHandler` calls)

```ts
  ipcMain.removeHandler(SettingsChannels.invoke.GET_FEATURES_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_FEATURES_SETTINGS)
```

- [ ] **Step 4: Regenerate + validate the IPC boundary**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: invoke map regenerated, `ipc:check` reports up-to-date (PASS). `window.api.settings.getFeaturesSettings`/`setFeaturesSettings` now appear in `apps/desktop/src/preload/index.d.ts`.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/ipc/settings-handlers.ts apps/desktop/src/preload/generated-rpc.ts apps/desktop/src/preload/index.d.ts
git commit -m "feat(features): main-process get/set features settings handlers"
```

---

### Task 3: Renderer `use-feature-flags` hook

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-feature-flags.ts`
- Test: `apps/desktop/src/renderer/src/hooks/use-feature-flags.test.ts`

**Interfaces:**
- Consumes: `window.api.settings.getFeaturesSettings/setFeaturesSettings` (Task 2), `FEATURES_SETTINGS_DEFAULTS`, `FeaturesSettings`, `FeatureKey` (Task 1).
- Produces: `useFeatureFlags(): { flags: FeaturesSettings; isLoading: boolean; isEnabled: (f: FeatureKey) => boolean; setFlag: (f: FeatureKey, value: boolean) => Promise<boolean> }`.

- [ ] **Step 1: Write the failing test** (mirrors `use-calendar-preferences.test.ts`; copy that file's mocking setup and adapt)

```ts
// apps/desktop/src/renderer/src/hooks/use-feature-flags.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useFeatureFlags } from './use-feature-flags'

const getFeaturesSettings = vi.fn()
const setFeaturesSettings = vi.fn()
let changedHandler: ((e: { key: string; value: unknown }) => void) | null = null

beforeEach(() => {
  changedHandler = null
  getFeaturesSettings.mockResolvedValue({
    home: true,
    inbox: false,
    journal: true,
    tasks: true,
    calendar: true,
    graph: true
  })
  setFeaturesSettings.mockResolvedValue({ success: true })
  // @ts-expect-error test shim
  global.window.api = {
    settings: { getFeaturesSettings, setFeaturesSettings },
    onSettingsChanged: (cb: (e: { key: string; value: unknown }) => void) => {
      changedHandler = cb
      return () => {}
    }
  }
})

describe('useFeatureFlags', () => {
  it('loads persisted flags', async () => {
    const { result } = renderHook(() => useFeatureFlags())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isEnabled('inbox')).toBe(false)
    expect(result.current.isEnabled('tasks')).toBe(true)
  })

  it('setFlag persists and updates optimistically', async () => {
    const { result } = renderHook(() => useFeatureFlags())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await act(async () => {
      await result.current.setFlag('tasks', false)
    })
    expect(setFeaturesSettings).toHaveBeenCalledWith({ tasks: false })
    expect(result.current.isEnabled('tasks')).toBe(false)
  })

  it('reacts to external settings:changed events', async () => {
    const { result } = renderHook(() => useFeatureFlags())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => changedHandler?.({ key: 'features', value: { graph: false } }))
    expect(result.current.isEnabled('graph')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- use-feature-flags`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

```ts
// apps/desktop/src/renderer/src/hooks/use-feature-flags.ts
import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  FEATURES_SETTINGS_DEFAULTS,
  type FeaturesSettings
} from '@memry/contracts/settings-schemas'
import type { FeatureKey } from '@memry/contracts/feature-flags'

interface UseFeatureFlagsReturn {
  flags: FeaturesSettings
  isLoading: boolean
  error: string | null
  isEnabled: (feature: FeatureKey) => boolean
  setFlag: (feature: FeatureKey, value: boolean) => Promise<boolean>
}

export function useFeatureFlags(): UseFeatureFlagsReturn {
  const [flags, setFlags] = useState<FeaturesSettings>(FEATURES_SETTINGS_DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.api.settings.getFeaturesSettings()
        if (mounted) setFlags(result)
      } catch (err) {
        if (mounted) setError(extractErrorMessage(err, 'Failed to load features'))
      } finally {
        if (mounted) setIsLoading(false)
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onSettingsChanged((event) => {
      if (event.key === 'features') {
        setFlags((prev) => ({ ...prev, ...(event.value as Partial<FeaturesSettings>) }))
      }
    })
    return unsubscribe
  }, [])

  const setFlag = useCallback(
    async (feature: FeatureKey, value: boolean): Promise<boolean> => {
      const updates = { [feature]: value } as Partial<FeaturesSettings>
      try {
        const result = await window.api.settings.setFeaturesSettings(updates)
        if (result.success) {
          setFlags((prev) => ({ ...prev, ...updates }))
          return true
        }
        setError(result.error ?? 'Update failed')
        return false
      } catch (err) {
        setError(extractErrorMessage(err, 'Failed to update features'))
        return false
      }
    },
    []
  )

  const isEnabled = useCallback((feature: FeatureKey) => flags[feature], [flags])

  return { flags, isLoading, error, isEnabled, setFlag }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- use-feature-flags`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-feature-flags.ts apps/desktop/src/renderer/src/hooks/use-feature-flags.test.ts
git commit -m "feat(features): use-feature-flags renderer hook"
```

---

### Task 4: Settings → Features section UI

**Files:**
- Modify: `apps/desktop/src/renderer/src/contexts/settings-modal-context.tsx` (add `'features'` to `SettingsSection` union ~line 4)
- Create: `apps/desktop/src/renderer/src/pages/settings/features-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings.tsx` (import + nav item in Workspace group ~line 93 + body conditional ~line 168)
- Modify: i18n `settings` namespace JSON (add `page.nav.items.features` + the section copy keys) — locate with `git grep -l '"account"' packages/i18n`
- Test: `apps/desktop/src/renderer/src/pages/settings/features-section.test.tsx`

**Interfaces:**
- Consumes: `useFeatureFlags` (Task 3), `useSettingsModal().open('features')` deep-link target (Task 6 / Task 5 callers).
- Produces: `FeaturesSettings` section component default-exported as `FeaturesSettings` named export `function FeaturesSection()`.

- [ ] **Step 1: Add the section id** (`settings-modal-context.tsx`, add to the union)

```ts
  | 'features'
```

- [ ] **Step 2: Write the failing test**

```tsx
// apps/desktop/src/renderer/src/pages/settings/features-section.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FeaturesSection } from './features-section'

const setFeaturesSettings = vi.fn().mockResolvedValue({ success: true })

beforeEach(() => {
  // @ts-expect-error test shim
  global.window.api = {
    settings: {
      getFeaturesSettings: vi.fn().mockResolvedValue({
        home: true,
        inbox: true,
        journal: true,
        tasks: true,
        calendar: true,
        graph: true
      }),
      setFeaturesSettings
    },
    onSettingsChanged: () => () => {}
  }
})

describe('FeaturesSection', () => {
  it('persists a toggle to setFeaturesSettings', async () => {
    render(<FeaturesSection />)
    const tasksSwitch = await screen.findByRole('switch', { name: /tasks/i })
    fireEvent.click(tasksSwitch)
    await waitFor(() => expect(setFeaturesSettings).toHaveBeenCalledWith({ tasks: false }))
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- features-section`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the section** (uses the shared primitives `SettingsHeader`, `SettingsGroup`, `SettingRow`; check their exact props in `components/settings/settings-primitives.tsx` and the existing `calendar-section.tsx` for the `SettingRow` + switch idiom, then mirror it)

```tsx
// apps/desktop/src/renderer/src/pages/settings/features-section.tsx
import { useT } from '@/i18n'
import { Switch } from '@/components/ui/switch'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow
} from '@/components/settings/settings-primitives'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { FEATURE_KEYS, type FeatureKey } from '@memry/contracts/feature-flags'

export function FeaturesSection() {
  const t = useT('settings')
  const { flags, setFlag } = useFeatureFlags()

  return (
    <div>
      <SettingsHeader
        title={t('features.title')}
        description={t('features.description')}
      />
      <SettingsGroup>
        {FEATURE_KEYS.map((key: FeatureKey) => (
          <SettingRow
            key={key}
            label={t(`features.items.${key}.label`)}
            description={t(`features.items.${key}.description`)}
          >
            <Switch
              role="switch"
              aria-label={t(`features.items.${key}.label`)}
              checked={flags[key]}
              onCheckedChange={(value) => void setFlag(key, value)}
            />
          </SettingRow>
        ))}
      </SettingsGroup>
    </div>
  )
}
```

- [ ] **Step 5: Wire into the settings page** (`pages/settings.tsx`)

Import beside the other section imports:

```tsx
import { FeaturesSection } from './settings/features-section'
```

Add the nav item inside the Workspace `SettingsNavGroup` (after the General item ~line 63; pick an existing icon, e.g. `LayoutGrid` from the icon set used in this file):

```tsx
          <SettingsNavItem
            icon={<LayoutGrid className="w-3.5 h-3.5" />}
            label={t('page.nav.items.features')}
            isActive={activeSection === 'features'}
            onClick={() => setActiveSection('features')}
          />
```

Add the body conditional (in the conditional chain ~line 168):

```tsx
            {activeSection === 'features' && <FeaturesSection />}
```

- [ ] **Step 6: Add i18n keys** (in the `settings` namespace JSON; `en` is mandatory)

```json
"page": { "nav": { "items": { "features": "Features" } } },
"features": {
  "title": "Features",
  "description": "Turn parts of the app on or off. Off = ghosted in the sidebar and disabled everywhere.",
  "items": {
    "home": { "label": "Home", "description": "Landing dashboard" },
    "inbox": { "label": "Inbox", "description": "Quick capture and triage" },
    "journal": { "label": "Journal", "description": "Daily notes" },
    "tasks": { "label": "Tasks", "description": "To-dos and due dates" },
    "calendar": { "label": "Calendar", "description": "Events and schedule" },
    "graph": { "label": "Graph", "description": "Note connections" }
  }
}
```

(Merge into the existing `settings` JSON structure rather than overwriting `page.nav.items`.)

- [ ] **Step 7: Run test + checks**

Run: `pnpm --filter @memry/desktop test:renderer -- features-section`
Expected: PASS.
Run: `pnpm --filter @memry/desktop typecheck:web && pnpm --filter @memry/desktop i18n:check`
Expected: 0 type errors; i18n OK.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/contexts/settings-modal-context.tsx apps/desktop/src/renderer/src/pages/settings/features-section.tsx apps/desktop/src/renderer/src/pages/settings/features-section.test.tsx apps/desktop/src/renderer/src/pages/settings.tsx packages/i18n
git commit -m "feat(features): Settings → Features toggle section"
```

---

### Task 5: Sidebar ghost + central open guard

**Files:**
- Modify: `apps/desktop/src/renderer/src/hooks/use-sidebar-navigation.ts` (gate `openSidebarItem`)
- Modify: `apps/desktop/src/renderer/src/components/app-sidebar.tsx` (compute disabled per item, pass to `SidebarNav`)
- Modify: `apps/desktop/src/renderer/src/components/sidebar/sidebar-nav.tsx` (ghost style + `aria-disabled`)
- Test: `apps/desktop/src/renderer/src/hooks/use-sidebar-navigation.test.ts`

**Interfaces:**
- Consumes: `useFeatureFlags` (Task 3), `featureForTabType` (Task 1), `useSettingsModal().open` (Task 4).
- Produces: `SidebarNav` gains prop `isDisabled: (page: AppPage) => boolean`.

> Design note: the guard blocks **all** disabled features including `home` (clicking ghosted Home → Features settings). The always-present default landing tab is created via `createDefaultTab()` (not through `openSidebarItem`), so it is never affected by this guard — it is handled in Task 7.

- [ ] **Step 1: Write the failing test** (verifies a disabled feature redirects instead of opening a tab)

```ts
// apps/desktop/src/renderer/src/hooks/use-sidebar-navigation.test.ts
import { describe, it, expect, vi } from 'vitest'
import { shouldRedirectToFeatures } from './use-sidebar-navigation'

describe('shouldRedirectToFeatures', () => {
  const flags = {
    home: true, inbox: true, journal: true, tasks: false, calendar: true, graph: true
  }
  it('redirects a disabled feature tab', () => {
    expect(shouldRedirectToFeatures('tasks', flags)).toBe(true)
  })
  it('allows an enabled feature tab', () => {
    expect(shouldRedirectToFeatures('inbox', flags)).toBe(false)
  })
  it('allows a non-feature tab (e.g. a note)', () => {
    expect(shouldRedirectToFeatures('note', flags)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- use-sidebar-navigation`
Expected: FAIL — `shouldRedirectToFeatures` not exported.

- [ ] **Step 3: Add the pure guard helper + wire it into `openSidebarItem`** (`use-sidebar-navigation.ts`)

```ts
import { featureForTabType } from '@memry/contracts/feature-flags'
import type { FeaturesSettings } from '@memry/contracts/settings-schemas'

export function shouldRedirectToFeatures(type: string, flags: FeaturesSettings): boolean {
  const feature = featureForTabType(type)
  return feature !== null && !flags[feature]
}
```

Inside the hook, read flags + settings modal and guard at the top of `openSidebarItem`:

```ts
  const { flags } = useFeatureFlags()
  const { open: openSettings } = useSettingsModal()

  const openSidebarItem = useCallback(
    (item: SidebarItem, ...rest) => {
      if (shouldRedirectToFeatures(item.type, flags)) {
        openSettings('features')
        return
      }
      // ...existing open logic unchanged
    },
    [flags, openSettings /* , ...existing deps */]
  )
```

(Keep the existing body of `openSidebarItem` verbatim below the guard; only the early-return is new.)

- [ ] **Step 4: Compute disabled in the sidebar + ghost the item**

In `app-sidebar.tsx`, add near the top of the component:

```tsx
  const { isEnabled } = useFeatureFlags()
```

Pass to `SidebarNav` (the existing render ~473):

```tsx
        isDisabled={(page) => !isEnabled(page)}
```

In `sidebar-nav.tsx`, extend the props and apply the ghost style + `aria-disabled` (the click still flows through `onNavClick`, which the Task 3 guard redirects):

```tsx
interface SidebarNavProps {
  items: NavItem[]
  isActive: (item: SidebarItem) => boolean
  onNavClick: (page: AppPage) => (e: React.MouseEvent) => void
  isDisabled: (page: AppPage) => boolean
  inboxCount: number
  todayTasksCount: number
}
```

Inside the `.map`, after `const active = isActive(sidebarItem)`:

```tsx
          const disabled = isDisabled(item.page)
          const badgeCount = disabled
            ? 0
            : item.page === 'inbox'
              ? inboxCount
              : item.page === 'tasks'
                ? todayTasksCount
                : 0
```

On `SidebarMenuButton`, merge a ghost class + aria:

```tsx
              <SidebarMenuButton
                isActive={!disabled && active}
                aria-disabled={disabled}
                data-tour={`nav-${item.page}`}
                onClick={onNavClick(item.page)}
                className={cn(
                  'h-7 rounded-[5px] p-0 ps-1 pe-2.5 gap-1.5 text-[13px] leading-4 font-medium text-sidebar-foreground',
                  disabled && 'opacity-50 text-muted-foreground'
                )}
              >
```

(Import `cn` from `@/lib/utils` if not already imported in this file.)

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter @memry/desktop test:renderer -- use-sidebar-navigation && pnpm --filter @memry/desktop typecheck:web`
Expected: PASS; 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-sidebar-navigation.ts apps/desktop/src/renderer/src/hooks/use-sidebar-navigation.test.ts apps/desktop/src/renderer/src/components/app-sidebar.tsx apps/desktop/src/renderer/src/components/sidebar/sidebar-nav.tsx
git commit -m "feat(features): ghost disabled sidebar items + redirect to Features"
```

---

### Task 6: Session-restore filter

**Files:**
- Modify: `apps/desktop/src/renderer/src/contexts/tabs/persistence/serialization.ts` (filter in `deserializeTabState` + `extractPinnedTabs`)
- Modify: `apps/desktop/src/renderer/src/contexts/tabs/persistence/hooks.ts` (pass current flags into the filter from `useSessionRestore`)
- Test: `apps/desktop/src/renderer/src/contexts/tabs/persistence/serialization.test.ts`

**Interfaces:**
- Consumes: `featureForTabType` (Task 1), `FeaturesSettings` (Task 1).
- Produces: `deserializeTabState(persisted, flags?: FeaturesSettings)` — when `flags` given, drops tabs whose feature is disabled (except `home`, the always-kept launcher).

> `home` is never filtered out — it is the neutral landing/launcher tab (Task 7). Only `inbox/journal/tasks/calendar/graph` tabs are dropped when disabled.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/src/contexts/tabs/persistence/serialization.test.ts
import { describe, it, expect } from 'vitest'
import { isRestorableTabType } from './serialization'

const flags = {
  home: false, inbox: false, journal: true, tasks: true, calendar: true, graph: true
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- serialization`
Expected: FAIL — `isRestorableTabType` not exported.

- [ ] **Step 3: Add the predicate + apply it in both rehydration spots** (`serialization.ts`)

```ts
import { featureForTabType } from '@memry/contracts/feature-flags'
import type { FeaturesSettings } from '@memry/contracts/settings-schemas'

export function isRestorableTabType(type: string, flags: FeaturesSettings): boolean {
  const feature = featureForTabType(type)
  if (feature === null || feature === 'home') return true
  return flags[feature]
}
```

In `deserializeTabState`, change the signature to accept optional flags and filter the per-group tabs before the `tabs.length > 0` fallback:

```ts
export const deserializeTabState = (
  persisted: PersistedTabState,
  flags?: FeaturesSettings
): Partial<TabSystemState> => {
  const migrated = migratePersistedState(persisted)
  const tabGroups: Record<string, TabGroup> = {}
  const persistedTabGroups = migrated.tabGroups

  for (const [groupId, group] of Object.entries(persistedTabGroups)) {
    const source = flags
      ? group.tabs.filter((t: PersistedTab) => isRestorableTabType(t.type, flags))
      : group.tabs
    const tabs: Tab[] = source.map((tab: PersistedTab) => ({
      ...tab,
      isModified: false,
      isPreview: false,
      isDeleted: false,
      openedAt: Date.now(),
      lastAccessedAt: Date.now()
    }))
    const finalTabs = tabs.length > 0 ? tabs : [createDefaultTab()]
    // ...rest unchanged
  }
  // ...rest unchanged
}
```

In `extractPinnedTabs`, add the same filter (when callers pass flags) so pinned disabled-feature tabs don't reopen:

```ts
export const extractPinnedTabs = (
  persisted: PersistedTabState,
  flags?: FeaturesSettings
): PersistedTab[] => {
  // ...existing extraction...
  return pinned.filter((t) => (flags ? isRestorableTabType(t.type, flags) : true))
}
```

- [ ] **Step 4: Pass flags from `useSessionRestore`** (`hooks.ts`)

```ts
  const { flags } = useFeatureFlags()
  // ...
  const restored = deserializeTabState(persisted, flags)
  // ...and in the pinned branch:
  const pinnedTabs = extractPinnedTabs(persisted, flags)
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter @memry/desktop test:renderer -- serialization && pnpm --filter @memry/desktop typecheck:web`
Expected: PASS; 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/contexts/tabs/persistence/serialization.ts apps/desktop/src/renderer/src/contexts/tabs/persistence/serialization.test.ts apps/desktop/src/renderer/src/contexts/tabs/persistence/hooks.ts
git commit -m "feat(features): drop disabled-feature tabs on session restore"
```

---

### Task 7: Home page empty "Create note" launcher when Home is off

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/home.tsx` (branch on `flags.home`)
- Create: `apps/desktop/src/renderer/src/components/home/home-disabled-launcher.tsx`
- Test: `apps/desktop/src/renderer/src/components/home/home-disabled-launcher.test.tsx`

**Interfaces:**
- Consumes: `useFeatureFlags` (Task 3), the existing "new note" creation handler (locate — see Step 4).
- Produces: `HomeDisabledLauncher` — centered `+ Create note` CTA.

> The `home` tab type always exists as the landing container. When the Home feature is off, its content becomes this neutral launcher instead of the dashboard. This avoids adding a new `TabType` (and the helper/icon map churn that entails).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/renderer/src/components/home/home-disabled-launcher.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HomeDisabledLauncher } from './home-disabled-launcher'

describe('HomeDisabledLauncher', () => {
  it('calls onCreateNote when the CTA is clicked', () => {
    const onCreateNote = vi.fn()
    render(<HomeDisabledLauncher onCreateNote={onCreateNote} />)
    fireEvent.click(screen.getByRole('button', { name: /create note/i }))
    expect(onCreateNote).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- home-disabled-launcher`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the launcher**

```tsx
// apps/desktop/src/renderer/src/components/home/home-disabled-launcher.tsx
import { Plus } from '@/lib/icons'
import { useT } from '@/i18n'

interface HomeDisabledLauncherProps {
  onCreateNote: () => void
}

export function HomeDisabledLauncher({ onCreateNote }: HomeDisabledLauncherProps) {
  const t = useT('home')
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <button
        type="button"
        onClick={onCreateNote}
        className="flex flex-col items-center gap-2 rounded-lg border border-border px-8 py-6 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Plus className="size-6" />
        <span className="text-sm font-medium">{t('disabled.createNote')}</span>
      </button>
      <p className="text-xs text-muted-foreground">{t('disabled.hint')}</p>
    </div>
  )
}
```

- [ ] **Step 4: Branch the home page** (`pages/home.tsx`)

Locate the existing new-note creation handler used by the sidebar "+" button: `git grep -nE 'createNote|newNote|onCreateNote' apps/desktop/src/renderer/src/components/app-sidebar.tsx apps/desktop/src/renderer/src/services`. Reuse that exact handler (it creates a blank note and opens its tab). Then at the top of the `Home` component body:

```tsx
  const { flags } = useFeatureFlags()
  const createNote = useCreateNote() // the located new-note handler/hook

  if (!flags.home) {
    return <HomeDisabledLauncher onCreateNote={createNote} />
  }
  // ...existing dashboard render unchanged
```

- [ ] **Step 5: Add i18n keys** (`home` namespace, `en`)

```json
"disabled": {
  "createNote": "Create note",
  "hint": "Nothing open. Start a note."
}
```

- [ ] **Step 6: Run test + checks**

Run: `pnpm --filter @memry/desktop test:renderer -- home-disabled-launcher && pnpm --filter @memry/desktop typecheck:web && pnpm --filter @memry/desktop i18n:check`
Expected: PASS; 0 type errors; i18n OK.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/home/home-disabled-launcher.tsx apps/desktop/src/renderer/src/components/home/home-disabled-launcher.test.tsx apps/desktop/src/renderer/src/pages/home.tsx packages/i18n
git commit -m "feat(features): empty create-note launcher when Home is disabled"
```

---

### Task 8: Gate creation, conversion, and day-panel actions

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx:1191` (gate `getTaskSlashMenuItem` by `flags.tasks`)
- Modify: `apps/desktop/src/renderer/src/pages/inbox/triage-view.tsx` (pass `tasksEnabled`) + `apps/desktop/src/renderer/src/components/inbox/triage-action-bar.tsx` (drop the `T`/to-task action when disabled)
- Modify: `apps/desktop/src/renderer/src/components/journal/journal-day-panel.tsx` (gate tasks section by `flags.tasks`, schedule section by `flags.calendar`)
- Modify: `apps/desktop/src/renderer/src/components/day-panel/global-day-panel.tsx` (skip calendar day-dots when `flags.calendar` is off)
- Test: `apps/desktop/src/renderer/src/components/inbox/triage-action-bar.test.tsx`

**Interfaces:**
- Consumes: `useFeatureFlags` (Task 3).
- Produces: `TriageActionBar` gains prop `tasksEnabled: boolean`.

- [ ] **Step 1: Write the failing test** (the to-task action is absent when tasks are disabled)

```tsx
// apps/desktop/src/renderer/src/components/inbox/triage-action-bar.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TriageActionBar } from './triage-action-bar'

const noop = () => {}
const baseProps = {
  onConvertToNote: noop,
  onConvertToTask: noop,
  onArchive: noop,
  onDelete: noop,
  onSkip: noop
}

describe('TriageActionBar tasks gating', () => {
  it('hides the to-task action when tasks are disabled', () => {
    render(<TriageActionBar {...baseProps} tasksEnabled={false} />)
    expect(screen.queryByText(/to task/i)).toBeNull()
  })
  it('shows the to-task action when tasks are enabled', () => {
    render(<TriageActionBar {...baseProps} tasksEnabled={true} />)
    expect(screen.getByText(/to task/i)).toBeTruthy()
  })
})
```

(Adjust `baseProps` to the actual `TriageActionBarProps` shape at the top of `triage-action-bar.tsx`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- triage-action-bar`
Expected: FAIL — `tasksEnabled` not a prop; action always present.

- [ ] **Step 3: Gate the to-task action** (`triage-action-bar.tsx`)

Add `tasksEnabled: boolean` to `TriageActionBarProps`, then filter the actions array so the `T` entry is dropped when disabled:

```tsx
  const actions = [
    /* ...other actions... */
    ...(tasksEnabled
      ? [
          {
            key: 'T',
            label: t('triage.action.toTask'),
            icon: <CheckSquare className="size-5" />,
            colorVar: ACTION_STYLES.task,
            action: onConvertToTask
          }
        ]
      : [])
  ]
```

Pass it from `triage-view.tsx`:

```tsx
  const { isEnabled } = useFeatureFlags()
  // ...
            tasksEnabled={isEnabled('tasks')}
```

- [ ] **Step 4: Gate the `/task` slash item** (`ContentArea.tsx` ~1191)

```tsx
  const featureFlags = useFeatureFlags()
  // ...where slash items are assembled:
  const taskItem = featureFlags.isEnabled('tasks') ? getTaskSlashMenuItem(editor, noteId) : null
  // ...then include taskItem in the menu only when non-null (filter Boolean on the items array)
```

- [ ] **Step 5: Gate the day-panel sections** (`journal-day-panel.tsx`)

```tsx
  const { isEnabled } = useFeatureFlags()
  // schedule (calendar events) section:
  {isEnabled('calendar') && (/* existing schedule render */)}
  // tasks section:
  {isEnabled('tasks') && (/* existing tasks render */)}
```

Also guard the React-Query task fetch so it doesn't run when disabled — add `enabled: isEnabled('tasks')` to the `['journal-day-panel','tasks',date]` query options.

- [ ] **Step 6: Skip calendar day-dots** (`global-day-panel.tsx`)

Where `useCalendarRange` feeds `buildDayDots`, short-circuit to no dots when calendar is off:

```tsx
  const { isEnabled } = useFeatureFlags()
  const dotData = isEnabled('calendar') ? buildDayDots(calendarItems) : EMPTY_DOTS
```

(Define `const EMPTY_DOTS = {}` or the empty shape `buildDayDots` returns; check its return type.)

- [ ] **Step 7: Run tests + checks**

Run: `pnpm --filter @memry/desktop test:renderer -- triage-action-bar && pnpm --filter @memry/desktop typecheck:web`
Expected: PASS (2 tests); 0 type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/components/inbox/triage-action-bar.tsx apps/desktop/src/renderer/src/components/inbox/triage-action-bar.test.tsx apps/desktop/src/renderer/src/pages/inbox/triage-view.tsx apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx apps/desktop/src/renderer/src/components/journal/journal-day-panel.tsx apps/desktop/src/renderer/src/components/day-panel/global-day-panel.tsx
git commit -m "feat(features): gate task slash/convert + day-panel tasks/calendar by flags"
```

---

### Task 9: Full-suite verification + manual GUI QA

**Files:** none (verification only).

- [ ] **Step 1: Run the renderer + contracts suites**

Run: `pnpm --filter @memry/contracts test && pnpm --filter @memry/desktop test:renderer`
Expected: all green (pre-existing unrelated failures noted in CLAUDE.md are exempt).

- [ ] **Step 2: Static gates**

Run: `pnpm lint && pnpm typecheck && pnpm ipc:check && git diff --check`
Expected: clean.

- [ ] **Step 3: Manual GUI QA** (`pnpm dev`)

Verify each, toggling in Settings → Features:
- Tasks off → sidebar Tasks ghosted; clicking it opens Settings → Features; `/task` slash item gone; inbox "To task" action gone; day-panel tasks section gone; right-panel shows no tasks.
- Calendar off → sidebar Calendar ghosted; day-panel schedule gone; month dots gone.
- Inbox/Journal/Graph off → ghosted + page unreachable (sidebar click + restart-with-restored-tab both redirect/drop).
- Home off → restart lands on the empty "Create note" tab; clicking the CTA creates and opens a blank note; sidebar Home ghosted → Features.
- Re-enable each → item un-ghosts and opens its page normally.

- [ ] **Step 4: Docs gate** (desktop change)

Run: `pnpm docs:ai-update --base origin/main` (or update `apps/docs/src` manually), then `pnpm docs:impact --base origin/main --strict && pnpm docs:build`
Expected: docs gate passes.

---

## Self-Review

**Spec coverage:**
- Data model → Task 1 (schema/defaults/mapping) + Task 2 (handlers). ✓
- Settings Features section → Task 4. ✓
- Sidebar ghost + redirect → Task 5. ✓
- Gating: tab-open guard → Task 5 (`openSidebarItem`); session restore → Task 6; inbox conversion → Task 8; day panel → Task 8; creation entry points (`/task` slash, quick-add) → Task 8 (slash + inbox; standalone Tasks-page quick-add `QuickAddInput`/`AddTaskModal` are only reachable from the Tasks page, which is itself gated by Task 5 — no separate gate needed). ✓
- Default landing (Home off) → Task 7. ✓
- Testing → per-task TDD + Task 9. ✓

**Residual enforcement gaps (acceptable for v1, called out, not silently dropped):**
- `memry://open?item=` deep-links to an inbox item when Inbox is disabled are not guarded (the deep-link opens the item directly, not via `openSidebarItem`). Low-risk; add a guard in the deep-link handler if it surfaces in QA. `// ponytail: deep-link guard deferred — main entry points (sidebar + restore) covered`.

**Placeholder scan:** no TBD/TODO. Two explicit "locate" steps (Task 7 Step 4 new-note handler; Task 8 prop shapes) carry the exact `git grep` to run — concrete actions, not content placeholders.

**Type consistency:** `featureForTabType` / `FeatureKey` / `FEATURE_KEYS` defined in Task 1 and consumed unchanged in Tasks 3, 5, 6. `isEnabled`/`setFlag`/`flags` hook surface from Task 3 used consistently in Tasks 4, 5, 6, 7, 8. Channel names `GET/SET_FEATURES_SETTINGS` consistent across Tasks 1–3.
