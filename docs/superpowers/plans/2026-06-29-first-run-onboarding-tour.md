# First-run Onboarding Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show new users a one-time, 6-step interactive tour on first launch that highlights live sidebar chrome (new note, nav, inbox, calendar, settings).

**Architecture:** A `useFirstRunTour()` hook runs inside the always-mounted `AppSidebarInner`, gated by a `localStorage` flag. It drives `driver.js` over six elements tagged with `data-tour` attributes. Tour copy lives as `en` i18n keys under the existing `common` namespace.

**Tech Stack:** React 19, `driver.js` (new dep), `@memry/i18n` (react-i18next), vitest + `@testing-library/react`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-29-first-run-onboarding-tour-design.md`.
- New dependency allowed: `driver.js` only. It is old/stable → clears pnpm `minimumReleaseAge` (~1 day).
- Gate key string is exactly `memry:onboarding:tour:v1`.
- i18n: add keys to **`en` only** under the existing `common` namespace (`onboarding.*` block). Repo `i18n:check` enforces `en`; other locales fall back. Do NOT register a new namespace.
- Tailwind: any new className must use logical props (`ms/me`, `ps/pe`, `start/end`) — but this feature adds almost no Tailwind (styling is in `tour.css` via theme tokens).
- Code style: single quotes, no semicolons, 100-char width, no trailing commas. Use `createLogger` not `console.*` if logging is ever needed (none needed here).
- Implementation lands on a fresh branch off `main`, NOT the current `feat/sidebar-feedback-button` branch.

---

### Task 1: Tour copy (i18n `en` keys)

**Files:**

- Modify: `packages/i18n/src/locales/en/common.json` (add top-level `onboarding` block, sibling to `phaseF`)

**Interfaces:**

- Produces: i18n keys read via `useT('common')` then `t('onboarding.<step>.title' | '.body')`:
  - `onboarding.welcome.title` / `.body`
  - `onboarding.newNote.title` / `.body`
  - `onboarding.sidebarNav.title` / `.body`
  - `onboarding.inbox.title` / `.body`
  - `onboarding.calendar.title` / `.body`
  - `onboarding.settings.title` / `.body`

- [ ] **Step 1: Add the `onboarding` block to `en/common.json`**

Add this as a new top-level key (e.g. after the existing `"home"` key — keep valid JSON, mind the comma on the preceding key):

```json
"onboarding": {
  "welcome": {
    "title": "Welcome to Memry",
    "body": "Your private, offline-first home. Notes are end-to-end encrypted — they never leave your device unencrypted."
  },
  "newNote": {
    "title": "Create your first note",
    "body": "Start here. Everything you write is stored locally, first."
  },
  "sidebarNav": {
    "title": "Find your way around",
    "body": "Notes, Inbox, Calendar, and Tasks all live in this sidebar."
  },
  "inbox": {
    "title": "Capture anything",
    "body": "Drop quick thoughts into the Inbox — it helps you file them into the right folder."
  },
  "calendar": {
    "title": "See your time",
    "body": "Your notes and tasks, laid out on a timeline."
  },
  "settings": {
    "title": "Sync and make it yours",
    "body": "Turn on end-to-end encrypted sync and pick your theme here."
  }
}
```

- [ ] **Step 2: Verify the JSON is valid**

Run: `node -e "require('./packages/i18n/src/locales/en/common.json'); console.log('ok')"`
Expected: prints `ok` (no JSON parse error).

- [ ] **Step 3: Commit**

```bash
git add packages/i18n/src/locales/en/common.json
git commit -m "i18n(onboarding): add first-run tour copy (en)"
```

---

### Task 2: The tour hook + theme CSS + driver.js dep (TDD)

**Files:**

- Modify: `apps/desktop/package.json` (add `driver.js` dependency)
- Create: `apps/desktop/src/renderer/src/components/onboarding/use-first-run-tour.ts`
- Create: `apps/desktop/src/renderer/src/components/onboarding/tour.css`
- Test: `apps/desktop/src/renderer/src/components/onboarding/use-first-run-tour.test.tsx`

**Interfaces:**

- Consumes: i18n keys from Task 1 via `useT('common')`.
- Produces:
  - `export const TOUR_KEY = 'memry:onboarding:tour:v1'`
  - `export function useFirstRunTour(): void` — call once from a mounted component; starts the tour at most once per install.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/components/onboarding/use-first-run-tour.test.tsx`:

```tsx
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const driveSpy = vi.fn()
let capturedConfig: { onDestroyed?: () => void } | undefined

vi.mock('driver.js', () => ({
  driver: (config: { onDestroyed?: () => void }) => {
    capturedConfig = config
    return { drive: driveSpy }
  }
}))
vi.mock('driver.js/dist/driver.css', () => ({}))
vi.mock('../onboarding/tour.css', () => ({}))
vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (k: string) => k }) }))

import { useFirstRunTour, TOUR_KEY } from './use-first-run-tour'

describe('useFirstRunTour', () => {
  beforeEach(() => {
    localStorage.clear()
    driveSpy.mockClear()
    capturedConfig = undefined
    // jsdom lacks matchMedia
    vi.stubGlobal(
      'matchMedia',
      vi
        .fn()
        .mockReturnValue({
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn()
        })
    )
  })

  it('starts the tour when the flag is unset', () => {
    renderHook(() => useFirstRunTour())
    expect(driveSpy).toHaveBeenCalledTimes(1)
  })

  it('sets the flag when the tour is destroyed (finish or skip)', () => {
    renderHook(() => useFirstRunTour())
    expect(localStorage.getItem(TOUR_KEY)).toBeNull()
    capturedConfig?.onDestroyed?.()
    expect(localStorage.getItem(TOUR_KEY)).toBe('1')
  })

  it('does not start the tour when the flag is already set', () => {
    localStorage.setItem(TOUR_KEY, '1')
    renderHook(() => useFirstRunTour())
    expect(driveSpy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/renderer/src/components/onboarding/use-first-run-tour.test.tsx`
Expected: FAIL — cannot resolve `./use-first-run-tour` (file does not exist yet).

- [ ] **Step 3: Install driver.js**

Run: `pnpm --filter @memry/desktop add driver.js`
Expected: `driver.js` appears in `apps/desktop/package.json` dependencies; lockfile updates. If pnpm rejects on `minimumReleaseAge`, the published release is older than the window, so this should not trigger — if it does, stop and report.

- [ ] **Step 4: Create the theme CSS**

Create `apps/desktop/src/renderer/src/components/onboarding/tour.css` (maps driver's popover to app theme tokens; physical CSS properties are fine here — this is a plain CSS file, not Tailwind):

```css
/* Restyle driver.js popover to match Memry theme tokens. */
.driver-popover {
  background-color: var(--popover, #fff);
  color: var(--popover-foreground, #1a1a1a);
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
  padding: 16px;
}

.driver-popover-title {
  font-size: 15px;
  font-weight: 600;
}

.driver-popover-description {
  font-size: 13px;
  line-height: 1.5;
  opacity: 0.85;
}

.driver-popover-progress-text {
  font-size: 12px;
  opacity: 0.6;
}

.driver-popover-next-btn,
.driver-popover-prev-btn {
  background-color: var(--primary, #ff671a);
  color: var(--primary-foreground, #fff);
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 13px;
  text-shadow: none;
}

.driver-popover-prev-btn {
  background-color: transparent;
  color: var(--popover-foreground, #1a1a1a);
  opacity: 0.7;
}

.driver-popover-arrow {
  border-color: var(--popover, #fff);
}
```

- [ ] **Step 5: Create the hook**

Create `apps/desktop/src/renderer/src/components/onboarding/use-first-run-tour.ts`:

```ts
import { useEffect, useRef } from 'react'
import { driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import './tour.css'
import { useT } from '@memry/i18n/renderer'

export const TOUR_KEY = 'memry:onboarding:tour:v1'

/**
 * First-launch interactive tour. Runs at most once per install:
 * the flag is set when the tour finishes OR is skipped (both destroy it).
 */
export function useFirstRunTour(): void {
  const { t } = useT('common')
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    if (localStorage.getItem(TOUR_KEY)) return
    startedRef.current = true

    const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

    const tour = driver({
      showProgress: true,
      animate: !prefersReducedMotion,
      allowClose: true,
      steps: [
        {
          popover: {
            title: t('onboarding.welcome.title'),
            description: t('onboarding.welcome.body')
          }
        },
        {
          element: '[data-tour="new-note"]',
          popover: {
            title: t('onboarding.newNote.title'),
            description: t('onboarding.newNote.body'),
            side: 'right',
            align: 'start'
          }
        },
        {
          element: '[data-tour="sidebar-nav"]',
          popover: {
            title: t('onboarding.sidebarNav.title'),
            description: t('onboarding.sidebarNav.body'),
            side: 'right',
            align: 'start'
          }
        },
        {
          element: '[data-tour="nav-inbox"]',
          popover: {
            title: t('onboarding.inbox.title'),
            description: t('onboarding.inbox.body'),
            side: 'right',
            align: 'start'
          }
        },
        {
          element: '[data-tour="nav-calendar"]',
          popover: {
            title: t('onboarding.calendar.title'),
            description: t('onboarding.calendar.body'),
            side: 'right',
            align: 'start'
          }
        },
        {
          element: '[data-tour="settings"]',
          popover: {
            title: t('onboarding.settings.title'),
            description: t('onboarding.settings.body'),
            side: 'top',
            align: 'end'
          }
        }
      ],
      onDestroyed: () => {
        // ponytail: localStorage, app-wide once; move to a per-vault setting if we ever need to re-show per vault
        localStorage.setItem(TOUR_KEY, '1')
      }
    })

    tour.drive()
  }, [t])
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/renderer/src/components/onboarding/use-first-run-tour.test.tsx`
Expected: PASS — 3 tests green.

- [ ] **Step 7: Typecheck the renderer**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: 0 errors. (If driver.js types are missing, confirm `driver.js` shipped its own `.d.ts` — it does; no `@types` package needed.)

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/package.json apps/desktop/src/renderer/src/components/onboarding/ ../../pnpm-lock.yaml 2>/dev/null
git add apps/desktop/package.json apps/desktop/src/renderer/src/components/onboarding/
git add pnpm-lock.yaml
git commit -m "feat(onboarding): first-run tour hook + driver.js + theme css"
```

---

### Task 3: Wire the hooks into the sidebar

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/app-sidebar.tsx` (3 edits: import + call hook; `data-tour="new-note"`; `data-tour="settings"`)
- Modify: `apps/desktop/src/renderer/src/components/sidebar/sidebar-nav.tsx` (2 edits: `data-tour="sidebar-nav"` on the group; `data-tour={`nav-${item.page}`}` on each button — yields `nav-inbox` and `nav-calendar`)

**Interfaces:**

- Consumes: `useFirstRunTour` and the `data-tour` selectors expected by the hook from Task 2.

- [ ] **Step 1: Import the hook in `app-sidebar.tsx`**

Add the import near the other hook imports (after line 59 `import { useT } from '@memry/i18n/renderer'`):

```ts
import { useFirstRunTour } from '@/components/onboarding/use-first-run-tour'
```

- [ ] **Step 2: Call the hook inside `AppSidebarInner`**

In `AppSidebarInner` (function starts at line 94), add the call alongside the other top-level hooks — immediately after the `useSidebarNavigation()` line (line 151):

```ts
const { openSidebarItem, isActiveItem } = useSidebarNavigation()

// First-launch interactive tour (runs once per install)
useFirstRunTour()
```

- [ ] **Step 3: Tag the new-note button**

On the main new-note `<button>` (line 422, the one with `onClick={() => void handleNewNote()}`), add the attribute:

```tsx
            <button
              type="button"
              data-tour="new-note"
              onClick={() => void handleNewNote()}
```

- [ ] **Step 4: Tag the settings button**

On the settings gear `<button>` (line 494, with `onClick={() => openSettings()}`), add the attribute:

```tsx
              <button
                type="button"
                data-tour="settings"
                onClick={() => openSettings()}
```

- [ ] **Step 5: Tag the nav group and items in `sidebar-nav.tsx`**

In `apps/desktop/src/renderer/src/components/sidebar/sidebar-nav.tsx`:

Add `data-tour="sidebar-nav"` to the wrapping `SidebarGroup`:

```tsx
    <SidebarGroup data-tour="sidebar-nav" className="shrink-0 py-1.5 pb-0">
```

Add a per-item `data-tour` to the `SidebarMenuButton` (this is the single edit that produces both `nav-inbox` and `nav-calendar` targets):

```tsx
              <SidebarMenuButton
                isActive={active}
                data-tour={`nav-${item.page}`}
                onClick={onNavClick(item.page)}
                className="h-7 rounded-[5px] p-0 pl-1 pr-2.5 gap-1.5 text-[13px] leading-4 font-medium text-sidebar-foreground"
              >
```

Note: `SidebarGroup` / `SidebarMenuButton` are `ui/sidebar` primitives that spread props onto their root DOM element, so `data-tour` lands on the rendered node. If typecheck reports the prop is not accepted, fall back to wrapping the targeted element in a `<div data-tour="...">` — but verify spread-through first (it is the common shadcn sidebar pattern).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: 0 errors.

- [ ] **Step 7: Verify `data-tour` targets render (renderer suite still green)**

Run: `pnpm --filter @memry/desktop test:renderer`
Expected: PASS (no regressions; existing `app-sidebar.test.tsx` still green).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/components/app-sidebar.tsx apps/desktop/src/renderer/src/components/sidebar/sidebar-nav.tsx
git commit -m "feat(onboarding): wire data-tour hooks + start first-run tour in sidebar"
```

---

### Task 4: Full verification

**Files:** none (verification only).

- [ ] **Step 1: i18n gate**

Run: `pnpm --filter @memry/desktop i18n:check`
Expected: pass (new `en` `onboarding.*` keys present; any pre-existing unrelated failures noted in repo memory are not introduced by this change).

- [ ] **Step 2: Renderer tests + web typecheck**

Run: `pnpm --filter @memry/desktop typecheck:web && pnpm --filter @memry/desktop test:renderer`
Expected: typecheck 0 errors; renderer tests green incl. the 3 gate tests.

- [ ] **Step 3: Lint**

Run: `pnpm --filter @memry/desktop lint`
Expected: 0 errors (warnings tolerated if pre-existing).

- [ ] **Step 4: Manual smoke (real app)**

Run: `pnpm dev` (or `pnpm --filter @memry/desktop dev:a` for a clean profile).
Verify, in order:

1. Fresh vault → on landing, the tour starts at the centered Welcome step.
2. Next advances through new-note → sidebar nav → inbox → calendar → settings, each popover anchored on the right element.
3. Clicking the corner X (skip) on any step ends the tour.
4. Reload the app → the tour does NOT re-appear.
5. (Reset to re-test: in devtools console run `localStorage.removeItem('memry:onboarding:tour:v1')`, reload → tour shows again.)
6. With OS "reduce motion" on, the tour shows without animation.

---

## Self-Review

**Spec coverage:**

- driver.js engine → Task 2. ✓
- localStorage gate `memry:onboarding:tour:v1`, set on finish/skip → Task 2 (`onDestroyed`) + tests. ✓
- 6 steps + targets → Task 2 steps array + Task 3 hooks. ✓
- 2 hooks in app-sidebar (new-note, settings) → Task 3 steps 3–4. ✓
- 2 hooks in sidebar-nav (group + per-item nav-inbox/nav-calendar) → Task 3 step 5. ✓
- Trigger from app-sidebar effect → Task 3 step 2. ✓
- New files use-first-run-tour.ts + tour.css → Task 2. ✓
- i18n `en` keys → Task 1. ✓
- Reduced motion / RTL / keyboard / theme → Task 2 (`animate`, driver defaults, tour.css). ✓
- Gate test → Task 2 step 1. ✓
- package.json driver.js → Task 2 step 3. ✓

**Deliberate deviations from spec (lazier, equivalent):**

- Copy lives under the existing `common` namespace (`onboarding.*` block), not a brand-new namespace — avoids touching `I18N_NAMESPACES`. Same keys, less wiring.
- Control-button labels (Next/Prev/Done/Skip) stay driver defaults (English), not i18n'd — only the 6 step strings are translated. Other locales fall back to `en` for everything anyway; revisit if a localized launch needs it.

**Placeholder scan:** none — every code step shows complete content.

**Type consistency:** `TOUR_KEY` and `useFirstRunTour` names match across hook, test, and Task 3 import. `data-tour` selector strings (`new-note`, `sidebar-nav`, `nav-inbox`, `nav-calendar`, `settings`) match exactly between the hook's `steps` (Task 2) and the wiring (Task 3).
