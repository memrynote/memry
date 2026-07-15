# Custom Theme System — Design

Date: 2026-07-09
Status: Approved (brainstorm), pending implementation plan

## Overview

Users can create named custom themes (e.g. "Tema 1") that override any theme color
variable in the app — background, surface, sidebar tones, hover states, text tones,
accent, and every other color token. Themes are edited from Settings → Appearance with
a hex input plus a color picker per variable, stored as JSON files in the vault, and
synced across devices via a new `theme` sync item type.

## Decisions (from brainstorm)

| Decision                | Choice                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Editable variable scope | Core set (~25) visible by default + collapsible Advanced section for everything else (colors only)                                           |
| Theme model             | Base + override: custom theme forks one built-in (`light`/`white`/`dark`) and stores only changed variables                                  |
| Storage                 | One JSON file per theme: `.memry/themes/<slug>.json`                                                                                         |
| Sync                    | New `theme` sync item type, one item per theme (folder_config precedent)                                                                     |
| Accent color            | Embedded in the theme as an editable variable when a custom theme is active; built-in themes keep the existing global `accentColor` behavior |
| Preview                 | Live apply while editing; debounced autosave (~500 ms), no Save button                                                                       |
| Built-in themes         | Immutable; "Customize" creates a custom theme forked from them                                                                               |

## Data Model

```jsonc
// .memry/themes/<slug>.json
{
  "id": "uuid", // stable sync identity — never changes
  "name": "Tema 1", // user-facing, renameable
  "base": "light", // 'light' | 'white' | 'dark'
  "variables": {
    // ONLY overrides; untouched vars inherit from base
    "--background": "#f6f5f0",
    "--sidebar": "#111111"
  },
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

- Filename slug derived from `name`; rename moves the file, `id` stays stable.
  Slug collisions get a `-2` suffix.
- `variables` values are 6-digit hex colors only (`#rrggbb`, matching the existing
  `HEX_COLOR_REGEX`). Shadows, radii, durations, and fonts are out of scope.
- Zod schema (`CustomThemeSchema`) lives in `packages/contracts`.
- Main-process module `apps/desktop/src/main/vault/themes.ts`:
  `listThemes` / `readTheme` / `writeTheme` / `renameTheme` / `deleteTheme`,
  atomic writes (temp file + rename, same as `vault-preferences.ts`).

## Variable Registry

- Renderer module `theme-variables.ts`: the single source for which CSS variables are
  editable, their group, and i18n label key.
- Groups — **Core** (default open): background, surface, surface-active (hover),
  border/input, popover, card, text tones (`--text-primary/secondary/tertiary/bright`),
  full sidebar set (`--sidebar*`), accent/tint. **Advanced** (collapsed): category
  dots (`--accent-*`), semantic cards (`--card-*`), graph (`--graph-*`), task colors
  (`--task-*`), queue (`--queue-*`), destructive/ring, primary/secondary.
- Base values are never duplicated into TS: read via `getComputedStyle` on a probe
  element carrying the base theme class (used for current-value display and reset).
- A unit test asserts every registry variable exists in `base.css` (drift guard).

## Apply Mechanism

- `general.theme` enum is **unchanged** (backward compatibility). New optional field
  `general.customThemeId: string | null`.
  - When set, it wins. `general.theme` is simultaneously set to the custom theme's
    `base`, so older app versions that don't know the field render the base theme.
- `use-theme-sync.ts` extension: when a custom theme is active →
  `setTheme(base)` (next-themes keeps class-based switching and `dark:` variants
  correct) + apply each override via
  `document.documentElement.style.setProperty(cssVar, value)` — the existing
  `--user-accent-color` pattern. Switching themes clears previously applied inline
  overrides before applying new ones.
- FOUC: extend the synchronous `GET_STARTUP_THEME` IPC to return
  `{ theme, base, overrides }` so the first paint is correct.
- Accent: the registry exposes accent as `--user-accent-color` (the existing source
  of the `--tint` chain). With a custom theme active, the theme's override of this
  variable wins; with built-ins, the global `accentColor` setting behaves exactly as
  today.

## IPC

- New `ThemeChannels` in `packages/contracts`: `list`, `get`, `create`, `update`,
  `rename`, `delete` invokes + `changed` event broadcast to all windows.
- Follow the `ipc-contract-change` skill; run `pnpm ipc:generate` + `pnpm ipc:check`.
- Errors surface via `extractErrorMessage`; main-process logging via
  `createLogger('Themes')`.

## Sync & Compatibility (PRODUCTION constraints)

- New sync item type `'theme'` wired with the `adding-sync-item-type` skill:
  record type, clock-required, encryptable, `itemId` = theme `id`.
- Payload = the full theme JSON. Whole-theme LWW per item (payloads are tiny);
  per-theme granularity means two devices editing different themes never conflict.
- Apply on pull: write `.memry/themes/<slug>.json`; if the slug changed (rename),
  move the file. Delete operations remove the file; if the deleted theme was active,
  fall back to its base and clear `customThemeId`.
- `general.customThemeId` added to `GENERAL_SYNCABLE_FIELDS` and
  `SyncedSettingsSchema.general` as optional. Older clients strip unknown fields in
  Zod (non-strict) — no breakage.
- No DB schema change: themes are vault files + sync items. No migration needed.
- **Pre-implementation verification points:**
  1. Older desktop clients must gracefully skip unknown item types on pull — verify
     the handler-registry (`getHandler(type)`) miss path.
  2. If sync-server validates against `SYNC_ITEM_TYPES`, the server must deploy
     **before** the desktop release that ships themes (same ordering rule as the
     telemetry rollout).

## Settings UI

- `appearance-section.tsx`: below the existing theme segmented control, a
  **Custom themes** group — list of user themes (active one marked), actions:
  New theme (pick a base or duplicate current), Edit, Rename, Duplicate, Delete.
  Built-ins are immutable; a "Customize" action forks them into a new custom theme.
- Editor: Core group open, Advanced collapsible. Each row:
  label + current-color swatch + hex `<Input>` (validated with `HEX_COLOR_REGEX`) +
  a color picker button (native `<input type="color">`, `CustomColorSwatch`
  precedent). Picking from the OS picker fills the hex input. Modified variables show
  a per-variable reset; a Reset-all action clears every override.
- Live preview: edits apply to the app immediately (the app is the preview);
  debounced (~500 ms) write-through to the theme file and sync queue.
- i18n: all labels through the normal i18n flow (ICU, single-brace).
- RTL: logical Tailwind classes only (`ms-*`/`me-*`, `ps-*`/`pe-*`, …).

## Error Handling

- Invalid hex rejected at the input (regex) and at the IPC boundary (Zod).
- Reading a theme file: unknown or invalid variables are silently ignored
  (forward compatibility when future versions add variables).
- Corrupt/missing theme file → fall back to the base theme, log the error.
- Deleting the active theme → revert to its base, clear `customThemeId`
  (propagates through sync).

## Testing

- Unit (main): `themes.ts` — atomic write, slug derivation, collision suffix, rename,
  delete; Zod schemas; registry↔`base.css` consistency test.
- Unit (renderer): editor component — hex validation, picker→input flow, per-var and
  reset-all; `use-theme-sync` — override apply/clear, base class switching.
- Sync: `theme-handler` tests modeled on the folder_config handler tests —
  upsert, rename (slug move), delete, active-theme-deleted fallback.
- E2E (light): create theme → change one core variable → assert applied →
  restart → assert persisted.

## Out of Scope

- Theme export/import/sharing, theme gallery/marketplace.
- Non-color tokens: shadows, radii, durations, fonts.
- Per-window or per-vault-section themes.
- Editing built-in themes in place.
