# Global design constraints — 2 weights · neutral palette · 8–12px radius

## Goal

Enforce three global design rules across the desktop Electron app:

1. **Typography** — only 2 font weights: `400` (regular) for body, `500` (medium) for headings + emphasis.
2. **Colors** — Tailwind `neutral` ramp as the foundation. Ignore the PRODUCT.md warm paper/ink/terracotta brand.
3. **Radius** — every corner 8–12px, no more no less. `rounded-full` (avatars/pills/toggles) is the one exception.

## Mechanism (why this is "global")

Tailwind v4 utilities resolve to overridable `@theme` tokens. Confirmed in `apps/desktop/src/renderer/src/assets/base.css`:

- `--radius-{sm,md,lg,xl,2xl,full}` mapped at `@theme inline` (base.css:2217) → every `rounded-*` utility reads these.
- `--font-weight-*` (Tailwind default namespace) → every `font-*` utility reads these.
- Color tokens (`--background`, `--foreground`, `--border`, …) defined per theme block and exposed via `@theme inline`.

**So the change is a token remap only. Zero component/TSX files touched. Fully reversible via `git revert`.** All 1000+ existing `rounded-*` / `font-*` / color usages conform automatically.

Scope = `base.css` (three theme blocks: `:root` warm-default, `.white`, `.dark`; three `--sidebar-*` sub-blocks; the `@theme inline` block) + 5 raw `font-weight:600` declarations.

## Rule 1 — Typography (2 weights)

Add to `@theme` (collapses the higher weights globally):

```
--font-weight-thin:       400
--font-weight-extralight:  400
--font-weight-light:       400   ← collapses 1 font-light use
--font-weight-normal:      400   body
--font-weight-medium:      500   headings + emphasis
--font-weight-semibold:    500   ← was 600, 154 uses auto-collapse
--font-weight-bold:        500   ← was 700, 19 uses auto-collapse
--font-weight-extrabold:   500
--font-weight-black:       500
```

Plus edit the 5 raw `font-weight: 600` lines in base.css (heading overrides at ~189, 741, 1463, 2465, and one more) → `500`. Result: only 400/500 render anywhere.

## Rule 2 — Radius (8–12px, keep full)

Remap in both `:root` and `.dark` radius blocks (`.white` inherits `:root`):

```
--radius-xs:  0.5rem  (8px)   ← was ~2px
--radius-sm:  0.5rem  (8px)   ← was 6px
--radius:     0.5rem  (8px)   (keep) — also covers bare `rounded`
--radius-md:  0.5rem  (8px)   (keep)
--radius-lg:  0.75rem (12px)  (keep)
--radius-xl:  0.75rem (12px)  ← was 16px
--radius-2xl: 0.75rem (12px)  ← was 20px
--radius-3xl: 0.75rem (12px)  (guard, if referenced)
--radius-full: 9999px         (keep ✓)
```

Add `--radius-xs` + `--radius-3xl` to the `@theme inline` map so the `rounded-xs` (13 uses) / `rounded-3xl` utilities pick them up. If any bare `rounded` utility falls outside the token (TW v4 default 4px), clamp via the `--radius` token above.

## Rule 3 — Colors (Tailwind neutral)

Tailwind v4 `neutral` ramp (oklch, pulled from tailwindcss.com/docs/colors via Context7):

```
50  oklch(98.5% 0 0)   300 oklch(87% 0 0)     700 oklch(37.1% 0 0)
100 oklch(97% 0 0)     400 oklch(70.8% 0 0)   800 oklch(26.9% 0 0)
200 oklch(92.2% 0 0)   500 oklch(55.6% 0 0)   900 oklch(20.5% 0 0)
                       600 oklch(43.9% 0 0)   950 oklch(14.5% 0 0)
```

### Structural chrome → neutral

| token                                   | `:root` / `.white` (light) | `.dark`             |
| --------------------------------------- | -------------------------- | ------------------- |
| background                              | 50 (`.white` = `#fff`)     | 950                 |
| surface                                 | 100                        | 900                 |
| surface-active                          | 200                        | 800                 |
| foreground / text-primary               | 900                        | 200                 |
| text-secondary                          | 600                        | 300                 |
| text-tertiary / muted-foreground        | 500                        | 400                 |
| text-bright                             | 950                        | 100                 |
| muted                                   | 100                        | 900                 |
| popover(+fg)                            | 50 / 900                   | 900 / 200           |
| border                                  | 200                        | 800                 |
| input                                   | 200                        | 700                 |
| card(+fg)                               | `#fff` / 900               | 900 / 200           |
| primary(+fg)                            | 900 / 50                   | 100 / 900           |
| secondary(+fg)                          | 100 / 900                  | 900 / 200           |
| accent(+fg)                             | 100 / 900                  | 800 / 200           |
| ring                                    | 400                        | 600                 |
| sidebar block (bg/fg/border/muted/etc.) | neutral equivalents        | neutral equivalents |
| queue-bg / queue-number-bg              | 100 / 200                  | 900 / 800           |

### Decorative brand color → neutral

- **Category pastels** (`--card-sage/rose/sand/lavender/grey`) → uniform `neutral-100` (light) / `neutral-900` (dark). Category color affordance dropped (accepted).
- **Accent dots** (`--accent-cyan/purple/green/orange`) → `neutral-500`.
- **Graph node types** (`--graph-node-*`) → mono _lightness_ ramp so the graph stays legible without hue: note→500, journal→600, task→400, project→700, tag→300; edges→300/400, ghost/dimmed→200, bg→50/950, label→foreground.
- **Default user accent** `--default-user-accent-color: #f97316` → `neutral-600`. The user-accent _feature_ stays — only the out-of-box default goes neutral. `--tint-foreground` stays `#fff` (AA on neutral-600).

### KEEP colored (functional / status — untouched)

- `--destructive` (+fg)
- entire `--task-*` group: priority (urgent/high/medium/low/none), due (overdue/today/tomorrow/upcoming), complete, progress, star, repeat, token-date/project, checkbox-done
- find-in-page highlight (`main.css` `::highlight(find-*)` ambers)

## Verification

- `pnpm --filter @memry/desktop typecheck` — no type impact (CSS only), but run.
- `pnpm lint` — flat ESLint; CSS token edits are lint-neutral.
- `git diff --check` — whitespace.
- Visual: `pnpm dev` → toggle light / white / dark, check: headings look medium not bold; all corners 8–12px except circular avatars/pills; UI is gray with red/amber/blue task+error signals still colored.
- No `pnpm i18n:check` / IPC / migration impact.

## Backward compatibility (LIVE BETA)

Purely visual token change. No DB schema, sync protocol, IPC contract, vault format, or settings-shape change → safe for every existing install. No migration. Reversible with one `git revert`.

## Out of scope

- `apps/landing` (separate brand surface — untouched).
- Physical → logical component class rewrites (token remap makes them unnecessary).
- Rewriting `font-semibold`/`rounded-xl` class names in TSX (token remap handles them; a codemod is a future cleanup, per Weights decision "token remap only").
