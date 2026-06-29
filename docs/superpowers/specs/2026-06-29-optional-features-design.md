# Optional Features (Module Toggles) — Design

Date: 2026-06-29

## Goal

Let users turn each top-level feature on/off: **Home, Inbox, Journal, Tasks, Calendar, Graph.**

- **Off** = the sidebar item stays visible but **ghosted** (disabled color). Clicking it does **not** open the page — it redirects to **Settings → Features** so the user can turn it back on.
- **On** = normal sidebar item; clicking opens the page as today.
- Off also disables every related action across the app (page unreachable by any path, conversions, day-panel sections, creation entry points).

One toggle list lives in a new **Settings → Features** section. The existing per-feature detail settings (Tasks/Calendar/Journal) stay where they are — those are config, not enablement.

## Non-goals (YAGNI)

- No per-feature granular sub-toggles (e.g. "disable only recurring tasks").
- No stored dependency graph between features — dependencies are enforced at read time, not modeled as data.
- No migration/backfill. Pre-production, flags default **on**, no back-compat.
- No sidebar reordering / custom arrangement.
- Notes themselves are never toggleable (they are the substrate the empty landing creates).

## Data model

New settings group `features`, following the existing group-blob pattern (`settings-schemas.ts` + generic `read/writeGroupSettings`).

```ts
// packages/contracts/src/settings-schemas.ts
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

- **Persistence:** reuse generic `readGroupSettings('features', FEATURES_SETTINGS_DEFAULTS)` / `writeGroupSettings(...)` in `apps/desktop/src/main/ipc/settings-handlers.ts`; register `getFeaturesSettings` / `setFeaturesSettings`. `writeGroupSettings` already broadcasts `SettingsChannels.events.CHANGED` with `{ key: 'features', value }`.
- **Channel:** add the features get/set channel to `SettingsChannels` in `packages/contracts/src/ipc-channels.ts`; run `pnpm ipc:generate` then `pnpm ipc:check`.
- **Renderer access:** new hook `apps/desktop/src/renderer/src/hooks/use-feature-flags.ts`, copied from `use-calendar-preferences.ts` (the canonical per-group preference hook): load via `window.api.settings.getFeaturesSettings()`, subscribe via `onSettingsChanged(e => e.key === 'features')`, write via `setFeaturesSettings`. Exposes `{ flags, setFlag(feature, value), isEnabled(feature) }`.

## Settings UI — Features section

Three edits to register a section (existing pattern):

1. `contexts/settings-modal-context.tsx` — add `'features'` to the `SettingsSection` union.
2. `pages/settings.tsx` — add a `SettingsNavItem` "Features" under the **Workspace** group + body conditional `{activeSection === 'features' && <FeaturesSettings/>}`.
3. `pages/settings/features-section.tsx` (new) — one `SettingsGroup` with 6 `SettingRow`s (label + one-line description + switch), each bound to `setFlag`. Uses `components/settings/settings-primitives.tsx`. Header text explains "Off = ghosted in the sidebar and disabled everywhere."

Deep-link target: ghosted sidebar items call `useSettingsModal().open('features')`.

## Sidebar — ghost + redirect

`mainNav` (`components/app-sidebar.tsx`) keeps **all 6** items always (no filtering). Each item maps to a feature key.

- `SidebarNav` / `SidebarItem` (`components/sidebar/sidebar-nav.tsx`) gets a `disabled` prop = `!isEnabled(feature)`.
  - Disabled style: `text-muted-foreground` + reduced opacity, no active highlight, no badge counts. (Logical Tailwind props per CLAUDE.md.)
- `handleNavClick` (`app-sidebar.tsx`) branches: disabled → `open('features')`; enabled → `openSidebarItem(...)` as today.
- Turning a feature on re-renders the item to its normal state; clicking then opens the page. No extra wiring — driven by the `flags` subscription.

## Gating — enforcement points

Hiding/ghosting the sidebar item is not enough; block every reachable path. Each point reads `isEnabled(feature)`:

1. **Tab-open guard.** `openSidebarItem` / any `openTab` for a disabled feature's `TabType` (`contexts/tabs/*`, `hooks/use-sidebar-navigation.ts`) → redirect to Settings → Features instead of opening. Covers command palette and `memry://` deep-links.
2. **Session restore.** On tab rehydration (`contexts/tabs/persistence/*`), drop tabs whose feature is disabled so a disabled page cannot reappear on launch.
3. **Inbox conversion.** Tasks off → hide/disable "Convert to task" in the inbox (locate: `convertToTask` in inbox renderer components). Note conversion stays (notes always on).
4. **Right day panel.** `components/journal/journal-day-panel.tsx`: Tasks off → skip the tasks query + hide the tasks section; Calendar off → hide the schedule section. `components/day-panel/global-day-panel.tsx` month dots come from calendar → skip when Calendar off.
5. **Creation entry points.** Tasks off → omit the `/task` slash item (`getTaskSlashMenuItem`), quick-add task, and day-panel "add task". Journal off → no journal-entry creation. Calendar off → no event create.

## Default landing (Home off)

When Home is disabled, the home tab is never opened. Default landing becomes an **empty "Create note" tab**:

- Locate the initial/landing-tab decision (search: initial `openTab` in `App.tsx` / tabs provider init) and branch on `flags.home`.
- Reuse the existing empty/new-tab state if one exists; otherwise a minimal empty-state component: centered `+ Create note` CTA that creates a blank note in-place (same path as normal new-note creation) and turns the tab into the editor.
- ponytail: single CTA, no dashboard fallback. Graph-off does not affect landing.

## Testing

- Unit: `use-feature-flags` load / merge / subscribe (copy the calendar-preferences test).
- Unit: `features-section` toggles persist via `setFeaturesSettings`.
- Guard test: opening a disabled feature tab redirects to Features settings (no page tab created).
- Day-panel: tasks/calendar sections hidden when their flag is off.
- Manual GUI QA: toggle each feature → sidebar ghost + click-redirects-to-Features + page unreachable + creation disabled; Home off → empty "Create note" landing; re-enable → item active + page opens.

## File touch-list

| Area                      | File                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Schema + defaults         | `packages/contracts/src/settings-schemas.ts`                                                                          |
| Channel                   | `packages/contracts/src/ipc-channels.ts`                                                                              |
| Main handlers             | `apps/desktop/src/main/ipc/settings-handlers.ts`                                                                      |
| Renderer hook (new)       | `apps/desktop/src/renderer/src/hooks/use-feature-flags.ts`                                                            |
| Settings section id       | `apps/desktop/src/renderer/src/contexts/settings-modal-context.tsx`                                                   |
| Settings page nav + body  | `apps/desktop/src/renderer/src/pages/settings.tsx`                                                                    |
| Features section (new)    | `apps/desktop/src/renderer/src/pages/settings/features-section.tsx`                                                   |
| Sidebar nav array + click | `apps/desktop/src/renderer/src/components/app-sidebar.tsx`                                                            |
| Sidebar item ghost style  | `apps/desktop/src/renderer/src/components/sidebar/sidebar-nav.tsx`                                                    |
| Tab-open guard            | `apps/desktop/src/renderer/src/hooks/use-sidebar-navigation.ts`, `contexts/tabs/*`                                    |
| Session restore filter    | `apps/desktop/src/renderer/src/contexts/tabs/persistence/*`                                                           |
| Day panel gating          | `apps/desktop/src/renderer/src/components/journal/journal-day-panel.tsx`, `components/day-panel/global-day-panel.tsx` |
| Inbox convert gating      | inbox renderer (locate `convertToTask`)                                                                               |
| Task creation gating      | `/task` slash (`getTaskSlashMenuItem`) + quick-add (locate)                                                           |
| Landing fallback          | `App.tsx` / tabs provider init (locate)                                                                               |
| i18n                      | new keys for the Features section + ghosted-item tooltip                                                              |
| Regenerate                | `pnpm ipc:generate` → `pnpm ipc:check`                                                                                |
