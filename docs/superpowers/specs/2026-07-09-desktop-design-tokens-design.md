# Desktop Design Tokens — SF Pro, Fixed Type Scale, Neutral Dark Palette, 1px Icons

**Date:** 2026-07-09
**Status:** Approved (brainstorm complete)
**Scope:** `apps/desktop` renderer only. No main-process, sync, DB, or settings-schema changes.

## Goal

Apply a designer spec to the desktop app globally:

- **Font:** SF Pro, regular (400) and medium (500) only.
- **Type scale:** 12 / 13 (base) / 14 / 16 / 18 / 24px (biggest).
- **Colors:** neutral gray ramp — subtle `#7F7F7F`, default `#5D5D5D`, strong `#292929`, bg-selected `#F5F5F5`, border `#F2F2F2` — applied to the **dark theme only**, as **derived dark equivalents** (the spec hexes are light-theme values; hierarchy is mirrored, not copied literally).
- **Icons:** hugeicons with 1px stroke width.

## Decisions (from brainstorm Q&A)

1. **Color scope:** dark theme (`.dark`) only, inverted/derived values preserving the spec's hierarchy. Light themes (`:root` paper, `.white`) untouched.
2. **Font scope:** everything → SF Pro system stack, including `--font-heading` (Space Grotesk) and `--font-display` (Playfair). `--font-serif` definition remains for the user editor-font setting.
3. **Type scale vs user setting:** chrome fixed at spec px sizes; the existing font-size setting (small/medium/large → 14/16/20px root) keeps scaling **editor content only** (rem-based BlockNote).
4. **Icons:** `strokeWidth=1` default in `createIcon`; migrate the 9 remaining `lucide-react` imports to hugeicons via `icon-map.ts`; keep existing explicit `strokeWidth` overrides (~28 sites, tiny icons need heavier stroke).

## Approach

Token-level change in the existing token layer (`apps/desktop/src/renderer/src/assets/base.css` + `lib/icons`). No component-by-component sweep, no parallel theme.

### 1. Dark palette (`.dark` block in `base.css`)

Spec hexes measured against white, mirrored onto the dark background:

| Token       | Light spec | Dark derived | Existing vars updated                                                                                                            |
| ----------- | ---------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| strong      | `#292929`  | `#E0E0E0`    | `--text-primary`, `--text-bright`, `--primary`                                                                                   |
| default     | `#5D5D5D`  | `#A6A6A6`    | `--foreground`, `--text-secondary`, `--card-foreground`, `--popover-foreground`, `--secondary-foreground`, `--accent-foreground` |
| subtle      | `#7F7F7F`  | `#7F7F7F`    | `--text-tertiary`, `--muted-foreground`, `--ring`                                                                                |
| bg-selected | `#F5F5F5`  | `#242424`    | `--surface-active`, `--accent`, `--input`                                                                                        |
| border      | `#F2F2F2`  | `#222222`    | `--border`                                                                                                                       |
| background  | (white)    | `#1A1A1A`    | `--background` (`--graph-bg` stays `#0e0e10`)                                                                                    |
| surface     | (derived)  | `#1F1F1F`    | `--surface`, `--muted`, `--card`, `--secondary`, `--popover`                                                                     |

Untouched in `.dark`: accent colors, task colors, graph node/edge colors, card pastels, shadows. `--primary-foreground` becomes `#1A1A1A` (dark text on the new `#E0E0E0` primary).

### 2. Typography (`@theme` block in `base.css` + `use-theme-sync`)

- Add fixed px font-size tokens (px ⇒ immune to root font-size setting):
  - `--text-xs: 12px`, `--text-sm: 13px`, `--text-base: 14px`, `--text-lg: 16px`, `--text-xl: 18px`, `--text-2xl: 24px`, plus matched `--text-*--line-height` (~1.4).
  - Sizes above 2xl (`3xl+`) clamp to 24px — spec says 24 is the biggest.
  - `text-sm` (13px) is the dominant UI class → de-facto base per spec.
- Font families: `--font-heading` and `--font-display` → `var(--font-sans)`. `--font-sans` stays the `-apple-system` system stack (SF Pro on macOS; Segoe fallback on Windows — SF Pro is not redistributable, no bundling).
- Weights: `@theme` `--font-weight-semibold: 500`, `--font-weight-bold: 500`. Re-pin editor content bold to 700 (`.bn-editor strong, .bn-editor b { font-weight: 700 }`) so user bold in notes survives.
- Editor scaling behavior (root font-size 14/16/20px via `use-theme-sync.ts`) unchanged.

### 3. Icons (`lib/icons/create-icon.tsx`, `icon-map.ts`, 9 lucide files)

- `createIcon`: default `strokeWidth = 1` when prop not provided; explicit props win.
- Migrate lucide imports → mapped hugeicons in: `ui/command.tsx`, `ui/dialog.tsx`, `ui/spinner.tsx`, `ui/dropdown-menu.tsx`, `ui/select.tsx`, `calendar/marquee-selection-overlay.tsx`, `ai-elements/sources.tsx`, `agent-chat/sidebar-tabs.tsx`, `pages/settings/import-section.tsx`. Add missing icons to `icon-map.ts`.
- Remove `lucide-react` from `apps/desktop/package.json` if zero imports remain.

## Backward compatibility

Pure renderer CSS/TSX change. No DB, sync protocol, IPC contract, vault format, or settings-shape changes. Existing settings (`theme`, `fontSize`, `fontFamily`, `accentColor`) keep their meaning; `fontSize` now affects editor content only (chrome fixed by design decision 3).

## Out of scope

- Light themes' colors (`:root`, `.white`).
- Accent/task/graph/pastel colors in dark theme.
- Landing site, docs site.
- Normalizing the ~28 explicit `strokeWidth` overrides.
- Codemod of physical→logical Tailwind classes (unrelated).

## Verification

1. `pnpm --filter @memry/desktop typecheck:web` + `pnpm lint`.
2. `pnpm test:desktop` (targeted: `use-theme-sync`, icon tests, zero-renderer-surface tests).
3. Live run (`pnpm dev`): dark theme contrast sweep (sidebar, lists, menus, dialogs, tasks, calendar, settings); chrome text at 13px base; font-size setting still scales editor and not chrome; note bold renders 700; icons render 1px stroke.
4. `pnpm test:e2e` as final gate.
5. `pnpm docs:impact --base <base> --strict` before push (docs gate).
