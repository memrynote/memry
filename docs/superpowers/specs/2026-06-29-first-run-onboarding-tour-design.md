# First-run onboarding tour (Standard 6)

Date: 2026-06-29
Status: Approved design — ready for implementation plan
Owner: Kaan

## Goal

New users land in an empty vault with zero guidance. Give first-launch users a
short interactive tour that highlights real UI chrome and teaches the core loop,
shipping safely the night before launch.

## Scope

In: a one-time, first-run interactive tour with 6 steps highlighting live
sidebar chrome. Out (post-launch): command-palette step, Home-widget step,
per-vault gating, multi-locale copy, a replay-tour button in settings.

## Approach

Drive the tour with **driver.js** (MIT, ~5kb, framework-agnostic). It owns the
overlay cutout, popover positioning, focus handling, keyboard nav, and
esc-to-close. We do not hand-roll overlay/positioning/focus-trap. All 6 targets
live in the always-mounted left sidebar, so no tab-switching or DOM-wait hacks
are needed.

Rejected alternatives:

- Hand-rolled coachmark engine — overlay cutout + popover positioning +
  focus-trap + resize handling is the over-engineering trap on launch eve.
- Centered modal-slide carousel — not interactive; user wanted the real tour.

## Trigger & first-run gate

- A `useFirstRunTour()` effect runs inside `app-sidebar.tsx`. The sidebar only
  mounts after the vault is open and the main UI is up, so all 6 targets are
  guaranteed present — no timing workaround.
- Gate key: `localStorage['memry:onboarding:tour:v1']`.
  - Unset on mount → run the tour once.
  - Set the flag on finish **or** skip (either ends it permanently).
  - `// ponytail: localStorage, app-wide once; move to a per-vault setting if we
ever need to re-show per vault`.

## Steps → DOM hooks

Only two existing files receive `data-tour` hooks.

| #   | Step                                             | Target element            | Hook                                                                                               |
| --- | ------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Welcome + privacy (offline-first, E2E-encrypted) | none (centered)           | —                                                                                                  |
| 2   | Create first note                                | "New" quick-action button | `data-tour="new-note"` in `app-sidebar.tsx`                                                        |
| 3   | Sidebar nav (where features live)                | nav `SidebarGroup`        | `data-tour="sidebar-nav"` in `sidebar-nav.tsx`                                                     |
| 4   | Inbox capture                                    | Inbox nav item            | `data-tour={`nav-${item.page}`}` in `sidebar-nav.tsx` (one edit yields nav-inbox AND nav-calendar) |
| 5   | Calendar                                         | Calendar nav item         | same per-item hook as #4                                                                           |
| 6   | Sync / settings                                  | settings gear button      | `data-tour="settings"` in `app-sidebar.tsx`                                                        |

Step targets selected by `[data-tour="..."]`. `Skip` (driver "close") is visible
on every step.

## New files

- `components/onboarding/use-first-run-tour.ts` — the hook: localStorage gate +
  driver.js config + the 6 step definitions. Respects
  `prefers-reduced-motion` → `animate: false`. RTL handled by driver's auto
  positioning. Strings pulled from i18n (see Copy).
- `components/onboarding/tour.css` — restyle the driver popover/overlay to the
  app theme tokens (terracotta / paper / ink) so it does not render
  default-light. Imported by the hook module.

## Copy / i18n

6 short strings live as `en` keys under a new `onboarding` namespace. Repo
`i18n:check` enforces `en` only, so `en` keys are sufficient for the gate to
pass. This copy is the bulk of the authoring effort; the logic is small.

Step copy (final wording can be tuned during implementation):

1. Welcome — "Your private, offline-first home. Notes never leave your device unencrypted."
2. New note — "Start here. Create your first note — everything's stored locally."
3. Sidebar nav — "Notes, Inbox, Calendar, and Tasks all live in this sidebar."
4. Inbox — "Capture anything fast. The Inbox triages it into the right folder."
5. Calendar — "See your notes and tasks on a timeline."
6. Settings — "Turn on end-to-end encrypted sync and pick your theme here."

## Accessibility & theming

- Reduced motion: disable driver animation when `prefers-reduced-motion: reduce`.
- Keyboard: driver provides esc-to-close and arrow-key step nav out of the box.
- RTL: driver auto-positions the popover; no manual flip needed.
- Theme: `tour.css` maps driver classes to existing CSS theme tokens.

## Testing

One renderer test for the gate (driver's own DOM behavior is the library's
responsibility, not unit-tested here):

- Flag unset on mount → tour starts (driver invoked).
- After completion/skip → flag is set.
- Second mount with flag set → no-op (driver not invoked).

## Files touched

- `apps/desktop/src/renderer/src/components/app-sidebar.tsx` (2 hooks + call the effect)
- `apps/desktop/src/renderer/src/components/sidebar/sidebar-nav.tsx` (2 hooks)
- `apps/desktop/src/renderer/src/components/onboarding/use-first-run-tour.ts` (new)
- `apps/desktop/src/renderer/src/components/onboarding/tour.css` (new)
- i18n `en` namespace file (new `onboarding` keys)
- `apps/desktop/package.json` (add `driver.js`)

## Verification

- `pnpm --filter @memry/desktop typecheck:web`
- `pnpm --filter @memry/desktop test:renderer` (gate test green)
- `pnpm --filter @memry/desktop i18n:check`
- Manual: fresh vault → tour fires once, Skip ends it, reload → does not re-fire.
