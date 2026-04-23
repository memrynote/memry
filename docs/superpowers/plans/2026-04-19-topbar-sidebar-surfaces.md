# TopBar + Sidebar Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the desktop app chrome so a single full-width `TopBar` (traffic lights + sidebar toggle + back/forward placeholders) sits above the sidebar/inset row, the sidebar becomes a recessed flat surface that fully offcanvas-collapses, and `SidebarInset` reads as a raised, bordered pane sitting on top of it.

**Architecture:**
- New `TopBar` component rendered inside `SidebarProvider` (needs `useSidebar()` for the toggle). `SidebarProvider`'s wrapper becomes `flex-col` via the existing `className` pass-through; `TopBar` stacks above the horizontal `AppSidebar + SidebarInset` row.
- `Sidebar` switches from `collapsible="icon"` (narrow rail) to `collapsible="offcanvas"` (fully hidden) and picks up `variant="inset"` so `SidebarInset` gets the built-in shadcn raised/rounded/shadowed treatment. The wrapper-level `has-data-[variant=inset]:bg-sidebar` rule is what makes the "sidebar color becomes the floor, inset floats on top" illusion work with zero new CSS.
- `sidebar-container`'s `fixed inset-y-0` is offset by a new `--topbar-height` CSS var so the sidebar starts below the top bar instead of overlapping it.
- Traffic lights migrate from inside the sidebar header to the top bar (no more `compact` prop — they always look the same). `VaultSwitcher` moves to `SidebarFooter` above `SyncStatus`. Per-pane tab bars stop rendering their own sidebar toggle since the top bar owns it.

**Tech Stack:** React 19, Electron 39, Tailwind v4, shadcn sidebar primitives, Vitest + Testing Library (unit/integration), Playwright (E2E).

---

## File Structure

**Create:**
- `apps/desktop/src/renderer/src/components/top-bar.tsx` — new top-of-window chrome: traffic lights + sidebar toggle + back/forward placeholders, drag region
- `apps/desktop/src/renderer/src/components/top-bar.test.tsx` — render + toggle integration test

**Modify:**
- `apps/desktop/src/renderer/src/App.tsx:423-434` — wrap `SidebarProvider` children in vertical stack (`TopBar` + horizontal sidebar/inset row), pass `className="flex-col"` to provider
- `apps/desktop/src/renderer/src/components/app-sidebar.tsx` — delete `SidebarHeaderContent`, remove `SidebarHeader`, move `VaultSwitcher` into `SidebarFooter` above `SyncStatus`, change `Sidebar` props to `variant="inset" collapsible="offcanvas"`, drop dead `group-data-[collapsible=icon]:*` styles + unused imports
- `apps/desktop/src/renderer/src/components/ui/sidebar.tsx:150-170` (SidebarProvider wrapper) — add `--topbar-height: 40px` to the `style` object
- `apps/desktop/src/renderer/src/components/ui/sidebar.tsx:246-262` (sidebar-container) — replace `inset-y-0 ... h-svh` with `top-(--topbar-height) bottom-0` so the sidebar anchors below the top bar
- `apps/desktop/src/renderer/src/components/split-view/tab-pane.tsx:15-47` — hard-code `showSidebarToggle={false}` on `TabBarWithDrag`, drop the prop plumbing
- `apps/desktop/src/renderer/src/components/traffic-lights.tsx` — remove `compact` prop (single size now)

**Don't touch:**
- `components/tabs/tab-bar-with-drag.tsx` — keep `showSidebarToggle` prop supported in case other callers still use it; just never pass `true` from the pane.

---

## Task 1: Create TopBar component (TDD)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/top-bar.tsx`
- Create: `apps/desktop/src/renderer/src/components/top-bar.test.tsx`

### Step 1: Write the failing test

- [ ] Create `apps/desktop/src/renderer/src/components/top-bar.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TopBar } from './top-bar'

vi.mock('@/components/traffic-lights', () => ({
  TrafficLights: () => <div data-testid="traffic-lights" />
}))

function renderWithProvider() {
  return render(
    <SidebarProvider defaultOpen>
      <TopBar />
    </SidebarProvider>
  )
}

describe('TopBar', () => {
  it('renders traffic lights, sidebar toggle, and back/forward placeholders', () => {
    renderWithProvider()
    expect(screen.getByTestId('traffic-lights')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /toggle sidebar/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /forward/i })).toBeInTheDocument()
  })

  it('back and forward buttons are disabled placeholders (no handler)', () => {
    renderWithProvider()
    const back = screen.getByRole('button', { name: /back/i })
    const forward = screen.getByRole('button', { name: /forward/i })
    expect(back).toBeDisabled()
    expect(forward).toBeDisabled()
  })

  it('clicking toggle calls sidebar toggle', () => {
    const { container } = renderWithProvider()
    const toggle = screen.getByRole('button', { name: /toggle sidebar/i })
    const wrapper = container.querySelector('[data-slot="sidebar-wrapper"]')
    // Provider starts expanded — cookie will flip after click; we just verify the click handler runs
    fireEvent.click(toggle)
    expect(wrapper).toBeTruthy()
  })

  it('has drag-region class for window dragging', () => {
    const { container } = renderWithProvider()
    const topBar = container.querySelector('[data-slot="top-bar"]')
    expect(topBar?.className).toContain('drag-region')
  })
})
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm --filter @memry/desktop test -- top-bar.test`

Expected: FAIL with `Cannot find module './top-bar'`

### Step 3: Write minimal implementation

- [ ] Create `apps/desktop/src/renderer/src/components/top-bar.tsx`:

```tsx
'use client'

import { PanelLeftIcon, ArrowLeft, ArrowRight } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { TrafficLights } from '@/components/traffic-lights'
import { useSidebar } from '@/components/ui/sidebar'

export function TopBar() {
  const { toggleSidebar } = useSidebar()

  return (
    <div
      data-slot="top-bar"
      className={cn(
        'drag-region flex items-center gap-2 h-10 shrink-0 px-3 border-b border-sidebar-border bg-sidebar'
      )}
    >
      <TrafficLights />
      <button
        type="button"
        aria-label="Toggle sidebar"
        onClick={toggleSidebar}
        className="flex items-center justify-center size-6 rounded-[4px] hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
      >
        <PanelLeftIcon className="size-3.5 text-sidebar-muted" />
      </button>
      <button
        type="button"
        aria-label="Back"
        disabled
        className="flex items-center justify-center size-6 rounded-[4px] text-sidebar-muted/60 cursor-not-allowed"
      >
        <ArrowLeft className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Forward"
        disabled
        className="flex items-center justify-center size-6 rounded-[4px] text-sidebar-muted/60 cursor-not-allowed"
      >
        <ArrowRight className="size-3.5" />
      </button>
    </div>
  )
}
```

### Step 4: Run tests — expect pass

- [ ] Run: `pnpm --filter @memry/desktop test -- top-bar.test`

Expected: PASS (4 tests).

### Step 5: Verify icon exports exist

- [ ] Run: `pnpm grep-icons` OR inspect `apps/desktop/src/renderer/src/lib/icons/index.ts` for `ArrowLeft` and `ArrowRight`. If missing, add:

```ts
export { ArrowLeft, ArrowRight, PanelLeft as PanelLeftIcon } from 'lucide-react'
```

(Exact re-export list lives in `lib/icons/index.ts`. Append missing icons there. `PanelLeftIcon` already imported in `ui/sidebar.tsx`.)

### Step 6: Commit

- [ ] Run:

```bash
git add apps/desktop/src/renderer/src/components/top-bar.tsx \
        apps/desktop/src/renderer/src/components/top-bar.test.tsx \
        apps/desktop/src/renderer/src/lib/icons/index.ts
git commit -m "feat(ui): add TopBar component with traffic lights and nav placeholders"
```

---

## Task 2: Offset sidebar below the top bar

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/ui/sidebar.tsx:150-170` (provider style)
- Modify: `apps/desktop/src/renderer/src/components/ui/sidebar.tsx:247-262` (sidebar-container class)

### Step 1: Add `--topbar-height` CSS var to provider

- [ ] In `apps/desktop/src/renderer/src/components/ui/sidebar.tsx`, locate the `SidebarProvider` return (~line 147-170). Update the `style` object on the wrapper div:

```tsx
style={
  {
    '--sidebar-width': `${sidebarWidth}px`,
    '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
    '--topbar-height': '40px',
    ...style
  } as React.CSSProperties
}
```

### Step 2: Offset sidebar-container top

- [ ] In the same file (~line 247-262), replace `'fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) md:flex'` with:

```tsx
'fixed top-(--topbar-height) bottom-0 z-10 hidden w-(--sidebar-width) md:flex',
```

(Drop `inset-y-0` and `h-svh`; `bottom-0` + `top-(--topbar-height)` handle vertical span.)

### Step 3: Run typecheck + existing sidebar tests

- [ ] Run: `pnpm typecheck:node && pnpm typecheck:web`

Expected: no new errors.

- [ ] Run: `pnpm --filter @memry/desktop test -- sidebar`

Expected: existing tests still pass. If any assert `inset-y-0` or `h-svh` literally, update expectations.

### Step 4: Commit

- [ ] Run:

```bash
git add apps/desktop/src/renderer/src/components/ui/sidebar.tsx
git commit -m "feat(ui): offset sidebar container below --topbar-height"
```

---

## Task 3: Move VaultSwitcher to footer, switch sidebar to offcanvas + inset variant

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/app-sidebar.tsx`

### Step 1: Delete `SidebarHeaderContent` and `SidebarHeader` usage

- [ ] In `apps/desktop/src/renderer/src/components/app-sidebar.tsx`, delete lines 78-97 (`SidebarHeaderContent` function). Then remove `<SidebarHeaderContent />` from the JSX return (currently line 420).

- [ ] Remove now-unused imports from the top of the file:
  - `TrafficLights` (line 25) — now owned by TopBar
  - `SidebarHeader` (in line 26-36 import block) — no longer used
  - `useSidebar` (same block) — only `SidebarHeaderContent` used it

### Step 2: Change Sidebar props

- [ ] Locate the return statement (~line 419):

```tsx
return (
  <Sidebar collapsible="icon" {...props}>
```

Replace with:

```tsx
return (
  <Sidebar variant="inset" collapsible="offcanvas" {...props}>
```

### Step 3: Move VaultSwitcher into footer

- [ ] Locate `SidebarFooter` block (lines 455-467). Currently:

```tsx
<SidebarFooter className="gap-0">
  <SidebarMenu>
    <SidebarMenuItem>
      {authState.status === 'authenticated' ? (
        <SyncStatus onOpenSettings={handleSyncClick} iconOnly />
      ) : authState.status === 'checking' ? null : (
        <SidebarMenuButton tooltip="Sync disabled" onClick={handleSyncClick}>
          <CloudOff className="size-4 text-muted-foreground" />
        </SidebarMenuButton>
      )}
    </SidebarMenuItem>
  </SidebarMenu>
</SidebarFooter>
```

Replace with:

```tsx
<SidebarFooter className="gap-0 px-2 pb-2">
  <VaultSwitcher />
  <SidebarMenu>
    <SidebarMenuItem>
      {authState.status === 'authenticated' ? (
        <SyncStatus onOpenSettings={handleSyncClick} iconOnly />
      ) : authState.status === 'checking' ? null : (
        <SidebarMenuButton tooltip="Sync disabled" onClick={handleSyncClick}>
          <CloudOff className="size-4 text-muted-foreground" />
        </SidebarMenuButton>
      )}
    </SidebarMenuItem>
  </SidebarMenu>
</SidebarFooter>
```

### Step 4: Strip dead `group-data-[collapsible=icon]:*` classes

- [ ] Search within `app-sidebar.tsx` for `group-data-[collapsible=icon]:` — sidebar is `offcanvas` now, so these matchers never fire. Remove each occurrence from className strings. Expected locations (verify with grep inside file):

  - Line ~297 — `mx-3 my-2 group-data-[collapsible=icon]:mx-1.5` → `mx-3 my-2`
  - Line ~302 — `overflow-y-auto scrollbar-thin group-data-[collapsible=icon]:overflow-hidden` → `overflow-y-auto scrollbar-thin`
  - Line ~423 — `px-3 pt-2 pb-0 group-data-[collapsible=icon]:px-1.5 group-data-[collapsible=icon]:justify-center` → `px-3 pt-2 pb-0`
  - Line ~427 — strip `group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0`
  - Line ~430 — strip `group-data-[collapsible=icon]:hidden`
  - Line ~433 — strip `group-data-[collapsible=icon]:hidden`
  - Line ~440 — strip `group-data-[collapsible=icon]:hidden`

If any remain elsewhere, strip them too. Be conservative — don't touch `group-data-[collapsible=icon]:*` inside `components/ui/sidebar.tsx`; that file still serves other callers.

### Step 5: Typecheck

- [ ] Run: `pnpm typecheck:node && pnpm typecheck:web`

Expected: no new errors. If `TrafficLights`/`useSidebar`/`SidebarHeader` still referenced, fix imports.

### Step 6: Commit

- [ ] Run:

```bash
git add apps/desktop/src/renderer/src/components/app-sidebar.tsx
git commit -m "refactor(sidebar): move VaultSwitcher to footer, switch to inset+offcanvas"
```

---

## Task 4: Integrate TopBar into App layout

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx:423-434`

### Step 1: Import TopBar

- [ ] At the top of `apps/desktop/src/renderer/src/App.tsx`, add after existing component imports (near line 6):

```tsx
import { TopBar } from '@/components/top-bar'
```

### Step 2: Restructure the provider children

- [ ] Locate the existing block (~line 423-434):

```tsx
<SidebarProvider key={vaultPath}>
  <DragProvider
    tasks={tasks}
    selectedIds={selectedTaskIds}
    selectedIdsRef={selectedTaskIdsRef}
    onDragEnd={(event, state) => void handleDragEnd(event, state)}
  >
    <DroppedPriorityProvider value={droppedPriorities}>
      {mainContent}
    </DroppedPriorityProvider>
  </DragProvider>
</SidebarProvider>
```

And the `mainContent` block (~line 355-389) which currently renders `<AppSidebar />` next to `<SidebarInset>`.

- [ ] Update `SidebarProvider` call to force vertical layout:

```tsx
<SidebarProvider key={vaultPath} className="flex-col">
```

- [ ] Inside `mainContent` (~line 372-378), wrap the sidebar+inset pair so they sit below the top bar, and add `<TopBar />` above. Replace:

```tsx
<SidebarDrillDownProvider>
  <AppSidebar currentPage={currentPage} viewCounts={viewCounts} />
  <SidebarInset className="flex flex-col overflow-hidden">
    <AppContent />
  </SidebarInset>
</SidebarDrillDownProvider>
```

with:

```tsx
<SidebarDrillDownProvider>
  <TopBar />
  <div className="flex flex-1 min-h-0 w-full relative">
    <AppSidebar currentPage={currentPage} viewCounts={viewCounts} />
    <SidebarInset className="flex flex-col overflow-hidden">
      <AppContent />
    </SidebarInset>
  </div>
</SidebarDrillDownProvider>
```

### Step 3: Manual smoke

- [ ] Run `pnpm dev` (this is the Electron desktop app — needs Electron rebuild if native modules drift). When the app loads, verify:
  - Top bar visible across the full window with traffic lights on left
  - Sidebar visible below top bar
  - Clicking the sidebar-toggle icon in top bar collapses the sidebar completely (no icon rail)
  - Clicking again re-expands it
  - Traffic lights still close/minimize/maximize the window
  - Window can still be dragged by grabbing top-bar empty area

If dev startup fails with `ERR_DLOPEN_FAILED`, run `bash apps/desktop/scripts/ensure-native.sh electron` and retry.

### Step 4: Commit

- [ ] Run:

```bash
git add apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(ui): mount TopBar above sidebar/inset row"
```

---

## Task 5: Remove per-pane sidebar toggle

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/split-view/tab-pane.tsx`

### Step 1: Hard-code `showSidebarToggle={false}`

- [ ] In `apps/desktop/src/renderer/src/components/split-view/tab-pane.tsx`, update line 47:

```tsx
<TabBarWithDrag groupId={groupId} showSidebarToggle={showSidebarToggle} />
```

to:

```tsx
<TabBarWithDrag groupId={groupId} showSidebarToggle={false} />
```

Keep the `showSidebarToggle` prop on `TabPaneProps` for now — other callers (split view) might still pass it. It simply becomes a no-op for the sidebar toggle in pane context.

### Step 2: Typecheck + run pane tests

- [ ] Run: `pnpm --filter @memry/desktop test -- split-view`

Expected: pass.

### Step 3: Commit

- [ ] Run:

```bash
git add apps/desktop/src/renderer/src/components/split-view/tab-pane.tsx
git commit -m "refactor(tabs): remove per-pane sidebar toggle (owned by TopBar)"
```

---

## Task 6: Simplify TrafficLights — remove `compact` prop

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/traffic-lights.tsx`

### Step 1: Drop the prop

- [ ] Update `apps/desktop/src/renderer/src/components/traffic-lights.tsx`:

  Replace:

  ```tsx
  interface TrafficLightsProps {
    className?: string
    compact?: boolean
  }

  export function TrafficLights({ className, compact = false }: TrafficLightsProps) {
  ```

  with:

  ```tsx
  interface TrafficLightsProps {
    className?: string
  }

  export function TrafficLights({ className }: TrafficLightsProps) {
  ```

- [ ] Remove the `compact`-dependent sizing. Replace `const buttonSize = compact ? 'size-2.5' : 'size-3.5'` and the `compact`-aware `gap-*` / `iconSize` lines with constants:

  ```tsx
  const buttonSize = 'size-3'
  const iconSize = 'size-3'
  ```

  Replace `cn('flex items-center transition-all duration-200', compact ? 'gap-1.5' : 'gap-2', className)` with `cn('flex items-center gap-2', className)`.

### Step 2: Verify no other callers pass `compact`

- [ ] Run grep (in this file's context only — via Grep tool): search for `TrafficLights\s+compact` and `compact={` near `TrafficLights`. Should return zero hits after Task 3 removed the only caller.

### Step 3: Typecheck

- [ ] Run: `pnpm typecheck:web`

Expected: no new errors.

### Step 4: Commit

- [ ] Run:

```bash
git add apps/desktop/src/renderer/src/components/traffic-lights.tsx
git commit -m "refactor(ui): drop TrafficLights compact prop"
```

---

## Task 7: E2E visual smoke — layout invariants

**Files:**
- Create: `apps/desktop/tests/e2e/topbar-layout.spec.ts`

### Step 1: Write the failing E2E

- [ ] Create `apps/desktop/tests/e2e/topbar-layout.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { launchElectron } from './helpers/launch'

test.describe('TopBar + sidebar layout', () => {
  test('top bar renders above sidebar and inset', async () => {
    const { page, cleanup } = await launchElectron()
    try {
      await page.waitForSelector('[data-slot="top-bar"]', { state: 'visible' })
      await page.waitForSelector('[data-slot="sidebar"]', { state: 'visible' })
      await page.waitForSelector('[data-slot="sidebar-inset"]', { state: 'visible' })

      const topBarBox = await page.locator('[data-slot="top-bar"]').boundingBox()
      const sidebarBox = await page.locator('[data-slot="sidebar"]').boundingBox()
      const insetBox = await page.locator('[data-slot="sidebar-inset"]').boundingBox()

      if (!topBarBox || !sidebarBox || !insetBox) throw new Error('missing bounding boxes')

      expect(topBarBox.y).toBeLessThan(sidebarBox.y)
      expect(topBarBox.y).toBeLessThan(insetBox.y)
      expect(sidebarBox.x).toBeLessThan(insetBox.x)
      expect(Math.round(topBarBox.height)).toBe(40)
    } finally {
      await cleanup()
    }
  })

  test('toggling top-bar button fully hides sidebar', async () => {
    const { page, cleanup } = await launchElectron()
    try {
      await page.waitForSelector('[data-slot="sidebar"]', { state: 'visible' })
      const toggle = page.getByRole('button', { name: /toggle sidebar/i }).first()
      await toggle.click()

      const container = page.locator('[data-slot="sidebar"] [data-slot="sidebar-container"]')
      await expect(container).toHaveAttribute('data-collapsible', 'offcanvas')
    } finally {
      await cleanup()
    }
  })

  test('vault switcher is in sidebar footer, not header', async () => {
    const { page, cleanup } = await launchElectron()
    try {
      const footer = page.locator('[data-slot="sidebar-footer"]')
      await expect(footer).toBeVisible()
      await expect(footer.getByText(/vault/i).first()).toBeVisible()

      const topBar = page.locator('[data-slot="top-bar"]')
      await expect(topBar.getByText(/vault/i)).toHaveCount(0)
    } finally {
      await cleanup()
    }
  })
})
```

Note: `launchElectron` helper lives in `apps/desktop/tests/e2e/helpers/launch.ts`. If its exact name differs, match existing e2e tests (see [apps/desktop/tests/e2e/](apps/desktop/tests/e2e/) for the pattern).

### Step 2: Rebuild before running

- [ ] Playwright runs against the built bundle, not source. Run:

```bash
npx electron-vite build --mode production
```

(from `apps/desktop`).

### Step 3: Run the spec

- [ ] Run: `pnpm --filter @memry/desktop test:e2e -- topbar-layout`

Expected: PASS (3 tests).

If `toggle sidebar` accessible name collision appears (multiple matches), narrow the locator to `page.locator('[data-slot="top-bar"]').getByRole('button', { name: /toggle sidebar/i })`.

### Step 4: Commit

- [ ] Run:

```bash
git add apps/desktop/tests/e2e/topbar-layout.spec.ts
git commit -m "test(e2e): pin TopBar + sidebar layout invariants"
```

---

## Task 8: Verify the surface-differentiation look manually

**Files:** _none — manual visual check_

### Step 1: Run dev, confirm the two-surface effect

- [ ] `pnpm dev`. In the running app:
  - Wrapper background (around the inset) should be `--sidebar` color — the sidebar surface visually "floors" the inset.
  - `SidebarInset` should have rounded corners, a soft shadow, and margin (top/right/bottom) so it reads as a raised pane.
  - Top row (top bar + sidebar header area + inset tab bar) should look like **one continuous strip** — no visible seam between the sidebar and inset at the top.
  - Collapse sidebar: sidebar disappears fully, inset slides to near-left (keeps `ml-2` margin), top bar remains.

If the seam IS visible at the top, the fix is to ensure `TopBar`'s `bg-sidebar` extends across the full width (it does by default — top bar is rendered outside the row). No additional work expected.

### Step 2: Light/dark theme pass

- [ ] Switch theme (Cmd+Shift+T or settings modal). Verify:
  - Surface contrast between sidebar bg and inset bg is visible but subtle in both light and dark.
  - Top bar bottom border (`border-sidebar-border`) is readable in both themes.

### Step 3: Commit if any CSS tweaks were needed

- [ ] If step 1 or 2 required CSS tweaks, stage and commit. Otherwise, skip.

---

## Task 9: Final verify + PR

### Step 1: Full verify

- [ ] Run:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm ipc:check
```

Expected: all green. Known pre-existing failures in `websocket.test.ts` and `folders.test.ts` can be ignored per [CLAUDE.md:Known Gotchas](CLAUDE.md).

### Step 2: Open PR

- [ ] Run (via gh CLI):

```bash
gh pr create --title "feat(ui): unified TopBar + offcanvas sidebar with raised inset" --body "$(cat <<'EOF'
## Summary
- New `TopBar` component (traffic lights + sidebar toggle + back/forward placeholders) spans the full window width above the sidebar/inset row
- Sidebar switched to `variant="inset" collapsible="offcanvas"` — fully hides on collapse, and the inset reads as a raised/bordered pane against the flat sidebar-colored floor
- `VaultSwitcher` moved from sidebar header to sidebar footer above `SyncStatus`
- Per-pane tab bars no longer render their own sidebar toggle (TopBar owns it)
- Back / Forward are placeholder UI only — no navigation history yet

## Test plan
- [ ] `pnpm test` passes including new `top-bar.test.tsx`
- [ ] `pnpm test:e2e -- topbar-layout` passes (layout invariants)
- [ ] Manual: sidebar toggle, traffic lights, window drag, light/dark theme swap, collapsed state
EOF
)"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Move VaultSwitcher to sidebar footer → Task 3
- ✅ Sidebar collapse icon repositioned (now in TopBar) → Task 1 + Task 4
- ✅ Top row contains traffic lights + toggle + back + forward → Task 1
- ✅ Back/forward UI only, no functionality → Task 1 (`disabled` placeholders)
- ✅ Per-pane tab bar preserved → Task 5
- ✅ Sidebar = flat background surface / Inset = raised, bordered → Task 3 (`variant="inset"`) + Task 2 (wrapper bg)
- ✅ Top row looks single in UI (no seam) → TopBar is one element spanning full width (Task 1 + Task 4)
- ✅ Collapsed = sidebar fully gone → Task 3 (`collapsible="offcanvas"`)
- ✅ Traffic lights stay same size → Task 6 (remove `compact`)

**Placeholder scan:** no "TBD", "handle edge cases", or "similar to Task N" references left.

**Type consistency:** `TopBar` is exported as named from `top-bar.tsx`, imported by App.tsx and top-bar.test.tsx — names match. `useSidebar`, `SidebarFooter`, `SidebarInset` all come from `@/components/ui/sidebar` consistently.

---

## Open questions to resolve when executing

1. **Does `ArrowLeft` / `ArrowRight` already re-export from `@/lib/icons`?** If not, Task 1 Step 5 handles it. Verify before writing test.
2. **Does `TabBarWithDrag.showSidebarToggle` have other callers besides `TabPane`?** Grep confirms: only `split-view/tab-pane.tsx` passes it. Safe to hard-code `false` at pane level without removing the prop plumbing.
3. **Top bar height 40px — does it match existing tab bar height?** Tab bar height is derived from `TabBarWithDrag` styles; verify visual alignment in Task 8 and adjust `--topbar-height` if needed.

---

**Plan complete and saved to [docs/superpowers/plans/2026-04-19-topbar-sidebar-surfaces.md](docs/superpowers/plans/2026-04-19-topbar-sidebar-surfaces.md).**
