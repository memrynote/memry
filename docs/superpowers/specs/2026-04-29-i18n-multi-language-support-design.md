# Multi-Language (i18n) Support

**Date:** 2026-04-29
**Status:** Approved

## Summary

Add full i18n infrastructure to memry: a new shared `packages/i18n` package wrapping `react-i18next` with the ICU plugin, used by both the Electron main process and the renderer. Default UI language is English. Users explicitly switch via Settings → General → Language; the renderer re-renders live and the native Electron menu rebuilds in the new language. Right-to-left languages (Arabic) are first-class from day 1: the document's `dir` attribute flips, Tailwind logical properties (`ms-*`, `me-*`, `start-*`, `end-*`) are mandated for new code, and direction-pointing icons opt into a `mirror-rtl` class.

memry ships with `en` translations populated and `tr` / `ar` resource files as empty stubs that fall back to English. Translations themselves are a separate content workstream and **not** a precondition for shipping the architecture. No translation pipeline (Crowdin / Lokalise) is in scope. No OS-locale auto-detection. Notes are E2E encrypted and never translated.

## Goals

- Architect for ease of adding language `N` later without touching component code
- One i18n stack used uniformly by both processes, sharing a single set of locale JSONs
- Live language switching in the renderer; native menu rebuilds after the switch
- RTL-correct layout when the active locale is RTL, no codemod required for new code
- Type-checked translation keys (`t('inbox.triage.archive')` errors at compile time if the key is removed)
- Lazy-loaded locale bundles to keep initial Electron bundle size flat
- A CI gate (`pnpm i18n:check`) that prevents PRs from introducing untranslated strings
- The app remains shippable after every phase of the migration

## Non-Goals

- OS-locale auto-detection on first launch (deferred — `'en'` is the explicit default)
- Region overrides (`en-GB` vs `en-US`, `es-ES` vs `es-MX`) — language-code only in v1
- Translation pipeline integration (Crowdin, Lokalise, GitLocalize)
- Translation memory / TMX exports
- Real-time / community-edited translations
- Translating user content (notes are E2E encrypted; user types in any language they want)
- AI-translate-this-note feature (separate product feature, not infra)
- `firstDayOfWeek`, `timezone`, region as settings fields (separate concerns; revisit when requested)
- Bidi-perfect rendering inside the BlockNote editor (known issue list, not v1 scope)
- RTL codemod for the existing ~939 renderer files (defer until a real RTL user exists)
- Pixel-perfect RTL screenshot tests (use bounding-box assertions instead)
- Translation-completeness as a CI failure (warn, never block)

## Decisions Captured

| Decision                  | Choice                                                                                                                  | Rationale                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Number of languages in v1 | Architect for flexibility, ship with English populated                                                                  | Avoids committing to translator capacity; matches "ship with 1" philosophy                           |
| Language switch UX        | Hybrid — renderer switches live, native menu rebuilds in main, OS-cached strings (notifications, dock) wait for restart | Best UX-to-cost ratio for an Electron desktop app                                                    |
| RTL support               | Yes, from day 1                                                                                                         | Retrofitting RTL on 939 files is exponentially more expensive than starting right                    |
| Default locale            | Explicit `'en'`, no OS detection                                                                                        | Simpler, predictable first-run; ~30 fewer lines; can add OS detect later if needed                   |
| Settings schema           | Extend existing `GeneralSettings` with one `locale` field                                                               | Matches existing `clockFormat` pattern; pre-production allows refactor later if locale concerns grow |
| Library choice            | `react-i18next` + `i18next-icu` plugin                                                                                  | Works in both main and renderer; largest ecosystem; ICU plurals via plugin                           |
| Package home              | New `packages/i18n` shared package                                                                                      | Used by both `apps/desktop/src/main` and `apps/desktop/src/renderer`                                 |

## Architecture

### Package structure

```
packages/i18n/
├── package.json                    # exports: ./main, ./renderer, ./locales
├── tsconfig.json
└── src/
    ├── shared/
    │   ├── config.ts               # SUPPORTED_LOCALES, FALLBACK_LOCALE, LOCALE_DISPLAY_NAMES
    │   ├── direction.ts            # localeDirection(locale) via Intl.Locale.textInfo
    │   └── types.ts                # type augmentation for t() autocomplete
    ├── main/
    │   └── index.ts                # createMainI18n(): Node-side i18next instance
    ├── renderer/
    │   ├── index.ts                # createRendererI18n(): browser-side i18next instance
    │   ├── provider.tsx            # <I18nProvider> wraps the app
    │   ├── use-t.ts                # thin wrapper around useTranslation for our namespaces
    │   └── use-direction.ts        # subscribes to locale changes → returns 'ltr' | 'rtl'
    └── locales/
        ├── en/
        │   ├── common.json         # generic verbs (Save, Cancel, OK, Close, Loading, Search)
        │   ├── inbox.json          # inbox feature strings
        │   ├── notes.json          # note editor chrome
        │   ├── journal.json        # journal-specific strings
        │   ├── calendar.json       # calendar feature strings
        │   ├── settings.json       # settings panels
        │   ├── errors.json         # main- and renderer-process error messages
        │   └── menu.json           # native Electron Menu items
        ├── tr/  …same shape, populated incrementally…
        └── ar/  …same shape, populated incrementally…
```

### Three exports, three consumers

- `@memry/i18n/main` — used by `apps/desktop/src/main` for error strings and `Menu.buildFromTemplate`
- `@memry/i18n/renderer` — used by `apps/desktop/src/renderer` for the `<I18nProvider>` and React hooks
- `@memry/i18n/locales` — raw JSON access if needed by anything else

The `main`/`renderer` split avoids pulling React into the main-process bundle.

### Why namespace JSONs by feature

1. **Lazy-loading** — only the active page's namespace loads on demand
2. **Merge conflicts** — multiple PRs touching strings in different features don't collide

### Naming convention

- File names: existing kebab-case
- Translation keys: dot-namespaced lowercase-kebab — `inbox.triage.action.archive`, `settings.general.language.helper-text`
- Keys encode meaning, not English text — `inbox.triage.action.archive` (verb) and `inbox.archive.title` (noun) translate differently in many languages

## Initialization & Locale Change Flow

### Boot sequence

```
Electron app launch
  │
  ├─► Main process (apps/desktop/src/main/index.ts)
  │     1. Read settings from disk → persistedLocale (or undefined)
  │     2. Resolve initial locale: persistedLocale ?? 'en'
  │     3. await createMainI18n({ locale })   ← SYNCHRONOUS init via fs.readFileSync
  │     4. Build native menu using t() from @memry/i18n/main
  │     5. Create BrowserWindow
  │
  └─► Renderer (apps/desktop/src/renderer/src/main.tsx)
        1. window.api.locale.get()  → IPC, main is source of truth
        2. await createRendererI18n({ locale })
        3. <I18nProvider i18n={instance}>
             <App />
           </I18nProvider>
```

**Key invariant:** main is the source of truth for active locale. Renderer asks main on boot and listens for change events afterward. Avoids split-brain on multi-window or renderer reload.

**Synchronous main init** is intentional — `Menu.buildFromTemplate` runs before the first window opens and needs `t('menu.file.new-note')` to resolve immediately. Total cost ~50ms with three locales pre-loaded.

### Locale change choreography

```
Renderer: SettingsModal "Language" select onChange
  │
  ├─► window.api.locale.set('tr')
  │
  ▼
Main: ipcMain handler
  ├─► settingsStore.update({ locale: 'tr' })       (persist)
  ├─► await mainI18n.changeLanguage('tr')          (translate own strings)
  ├─► rebuildAppMenu()                              (rebuild native menu)
  ├─► allWindows.forEach(w => w.webContents.send('locale:changed', 'tr'))
  │
  ▼
Renderer: locale:changed listener
  ├─► await rendererI18n.changeLanguage('tr')      (load tr.json namespaces)
  ├─► document.documentElement.setAttribute('lang', 'tr')
  ├─► document.documentElement.setAttribute('dir', localeDirection('tr'))
  ├─► toast: t('settings.language.changed', { lang: nativeName })
  └─► React tree re-renders via i18next event hook
```

**Failure modes:**

- `tr.json` fails to load (corrupt file, FS error) → renderer keeps current locale, surfaces error toast via `extractErrorMessage`. Settings is _not_ persisted.
- Main persists but renderer change fails → next reload corrects (main is source of truth).
- Locale change while sync is in-flight → no impact (sync uses neither i18next nor user-facing strings; logs use `createLogger`, locale-independent).

### Settings schema extension

In `packages/contracts/src/settings-schemas.ts`, extend the existing `GeneralSettingsSchema`:

```ts
export const GeneralSettingsSchema = z.object({
  clockFormat: z.enum(['12h', '24h']).default('12h'),
  // …existing fields…
  locale: LocaleSchema.default('en')
})
```

`locale` is non-optional with `'en'` default. No `undefined`/Match-system semantics in v1.

### IPC contract

New file `packages/contracts/src/locale-api.ts`:

```ts
export const LocaleSchema = z.enum(['en', 'tr', 'ar']) // grow over time
export type Locale = z.infer<typeof LocaleSchema>

export interface LocaleApi {
  get: () => Promise<Locale>
  set: (locale: Locale) => Promise<void>
  list: () => Promise<readonly Locale[]>
  // event channel: 'locale:changed' → payload Locale
}
```

`pnpm ipc:check` validates the renderer↔main boundary.

## RTL Handling

### Direction detection

```ts
// packages/i18n/src/shared/direction.ts
export function localeDirection(locale: string): 'ltr' | 'rtl' {
  return new Intl.Locale(locale).textInfo.direction
}
```

`Intl.Locale.prototype.textInfo` is built into Electron 39 (Chromium 119+ / V8 12.0). No fallback list of RTL locales to maintain — the platform owns the mapping.

### Document attributes

The `locale:changed` listener mutates `<html>`:

```ts
function applyLocaleToDocument(locale: Locale) {
  const html = document.documentElement
  html.setAttribute('lang', locale)
  html.setAttribute('dir', localeDirection(locale))
}
```

DOM is the source of truth for direction. CSS reads via `[dir="rtl"]` selectors. No React state required for direction.

### Tailwind strategy: logical for new code, defer existing audit

| Old (physical, breaks in RTL) | New (logical, RTL-safe) |
| ----------------------------- | ----------------------- |
| `ml-2`, `mr-4`                | `ms-2`, `me-4`          |
| `pl-3`, `pr-3`                | `ps-3`, `pe-3`          |
| `left-0`, `right-4`           | `start-0`, `end-4`      |
| `rounded-l-md`                | `rounded-s-md`          |
| `text-left`                   | `text-start`            |
| `border-l`, `border-r`        | `border-s`, `border-e`  |

**Three rules:**

1. **New components: logical only.** Adds to memry's `CLAUDE.md` Code Style. Code review rejects physical classes in new files.
2. **Existing files: leave alone in v1.** RTL is fully supported architecturally — `<html dir="rtl">` flips, ICU plurals work, new components are RTL-correct. The pre-existing 939 files use physical Tailwind classes that won't auto-flip; an Arabic user on Phase A will see ~80–90% correct RTL with minor layout artifacts in legacy components. The cleanup codemod that fixes the remaining 10–20% is a separate phase — run it before `ar.json` is populated for real users.
3. **Codemod path (future):** A `jscodeshift` script does mechanical replacements (`ml-` → `ms-`, etc.). Cases requiring human judgment (`flex-row` vs `flex-row-reverse`, position-dependent absolute layouts) get TODO comments. Run the week before promoting Arabic to GA.

PostCSS auto-flip plugins (`postcss-rtlcss`) are explicitly avoided — they flip too aggressively (mirror code blocks, mirror chevrons that shouldn't mirror) with invisible failure modes.

### Icon mirroring — opt-in, not opt-out

| Mirror in RTL                | Don't mirror                 |
| ---------------------------- | ---------------------------- |
| chevron-left / chevron-right | clock, calendar, settings    |
| arrow-back / arrow-forward   | search, magnifier            |
| reply icons (curved arrows)  | user avatars, document icons |
| breadcrumb separators        | brand logos                  |

Single Tailwind utility class `mirror-rtl` defined globally:

```css
[dir='rtl'] .mirror-rtl {
  transform: scaleX(-1);
}
```

Mirrorable icons opt in:

```tsx
<ChevronRight className="size-4 mirror-rtl" />
```

Opt-in beats opt-out: most icons should NOT mirror, so the safe default is "don't flip." Choosing to mirror is a deliberate semantic statement.

### LTR-in-RTL exceptions

Some content stays LTR regardless of UI direction:

- Code blocks in notes
- URLs and email addresses
- File paths
- Numbers and time displays (`Intl.NumberFormat` / `Intl.DateTimeFormat` handle this via Unicode bidi)
- English-language note content authored in an Arabic-locale UI

The note editor (BlockNote) is the biggest implementation hazard. Code blocks need explicit `dir="ltr"` wrapping; mixed-direction text needs `unicode-bidi: plaintext` on paragraphs. **Scoped as a known-issue list, not v1 work.** A user writing English in an Arabic-UI memry will see correct behavior in ~95% of cases via Unicode bidi; the 5% edge cases get a follow-up task.

## Settings UI

### Placement

The locale field sits in the **General** tab of `settings-modal.tsx`, next to `clockFormat`. No new "Language & Region" tab in v1.

### Picker control

Standard `<Select>` from existing UI primitives (shadcn). Three deliberate UX choices:

```
Language     [English ▾]
             ──────────
              English        ← 'en' (default)
              Türkçe         ← 'tr'
              العربية         ← 'ar'
```

1. **Native script for each language name** — "Türkçe" not "Turkish". Stored in `LOCALE_DISPLAY_NAMES` constant in `packages/i18n/src/shared/config.ts`, never in `translation.json`. These are not translated.
2. **No flags** — flags represent countries, not languages.
3. **No "Match system" option** — `'en'` is the explicit default per the simplified schema.

### Post-change UX

When the user picks a new language:

1. **Instant** (~100ms): renderer text flips to the new language.
2. **Instant**: `<html dir>` flips if applicable.
3. **Instant**: native menu bar rebuilds via `Menu.setApplicationMenu(rebuild())`.
4. **Toast** confirms the change in the new language: `t('settings.language.changed', { lang: nativeName })`.
5. **No restart prompt in 90% of cases.**

A static helper text is rendered under the picker at all times (not conditional on user interaction):

> "Most of the app updates immediately. Some system-level text — already-shown notifications, dock label, window title bar — refreshes after the next launch."

Setting expectations once is cheaper than a modal nag every time the user changes language.

### Failure handling

If `i18n.changeLanguage('tr')` rejects:

1. Log via `createLogger('Locale')`.
2. Throw → caught by existing `extractErrorMessage(err, fallback)`.
3. Toast in the _current_ language: "Couldn't change to Türkçe — please try again."
4. Settings is not persisted; picker reverts to previous value.

### First run

First-ever launch always shows English. No OS detection, no welcome screen. Users who want a different language go to Settings.

## Migration Path

### Phased rollout

| Phase                            | What ships                                                                                                                                        | PRs | Risk          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------- |
| **A. Infrastructure**            | `packages/i18n`, init in main + renderer, settings UI with picker, IPC contract, RTL plumbing. Zero strings migrated.                             | 1   | Low           |
| **B. Common namespace**          | Migrate ~30-50 universal strings (Save, Cancel, OK, Close, Loading, Error, Search, Yes/No). Translate to TR + AR. End-to-end switching validated. | 1   | Low           |
| **C. Feature-by-feature**        | One PR per feature folder: `settings`, `inbox`, `notes`, `calendar`, `journal`, `graph`, `tasks`.                                                 | 6–8 | Medium per PR |
| **D. Main-process strings**      | `errors.json`, native menu (`menu.json`).                                                                                                         | 1   | Low           |
| **E. Codemod sweep + lint gate** | `jscodeshift` codemod for stragglers; ESLint rule errors on JSX text literals.                                                                    | 1   | Medium        |

Total: ~10–12 PRs. Each independently mergeable. App is shippable after every merge.

### Phase gating

- Phase A blocks every C.x.
- Phase B is the proof-of-concept for end-to-end switching.
- C.1 through C.6 are parallel (different namespaces, no merge conflicts).
- Phase E lands last and locks the door (no new untranslated strings can land after).
- Phase I hardens that lint gate from one JSX text rule to four rules: JSX text, JSX string attributes, toast literals, and `extractErrorMessage` fallback literals. The final gate runs with zero i18n deferrals allowed.

### Namespace assignment heuristic

| File path                                            | Default namespace |
| ---------------------------------------------------- | ----------------- |
| `src/components/inbox/**`                            | `inbox.json`      |
| `src/components/note/**`                             | `notes.json`      |
| `src/components/journal/**`                          | `journal.json`    |
| `src/components/calendar/**`                         | `calendar.json`   |
| `src/components/settings*`, `src/pages/settings.tsx` | `settings.json`   |
| `src/components/ui/**`, `src/lib/**`                 | `common.json`     |
| Errors raised via `extractErrorMessage`              | `errors.json`     |
| Main process `Menu.buildFromTemplate`                | `menu.json`       |

Component imports the hook with namespace baked in:

```tsx
const { t } = useT('inbox')
return <Button>{t('triage.action.archive')}</Button>
```

### Codemod (Phase E only)

Phase C is _manual_ per feature. The human eye catches:

- Non-user-facing strings (CSS class names, ARIA roles, log messages, IDs)
- Strings needing parameterization (`` `${count} items` `` → `t('count', { count })`)
- Concatenated strings (`'Hello, ' + name` → `t('greeting', { name })`)

Phase E's codemod is conservative — it inserts `// TODO(i18n): wrap in t()` rather than auto-replacing. Human reviews each one. The accompanying ESLint rule then becomes a wall preventing new untranslated strings from landing.

### Pseudo-locale workflow

A `__pseudo` locale (English with diacritics + 40% length expansion):

```
"inbox.triage.action.archive": "[!! Ærçhïvé !!]"
"common.button.save":           "[!!! §åvé !!!]"
```

Catches:

1. **Untranslated strings** — visible English in `__pseudo` mode = a missed migration
2. **Layout breaks** — long pseudo-text exposes UI that breaks at non-English string lengths

Run mode: `LOCALE=__pseudo pnpm dev`. Compiled out of production builds via Vite's `define`.

### Translation sourcing for v1

Phase B (~50 common strings) translated by hand or via Claude/DeepL. Phases C/D/E ship `tr.json` and `ar.json` as **literal empty objects (`{}`) per namespace** — not stubs with empty-string values, since `i18next` would render `""` as actually-blank text. With `{}`, the missing-key fallback chain returns the English value automatically. Real translation is a separate content workstream filled in over time. The architecture is what we're shipping; translations are content.

## Testing Strategy

### Four-layer test plan

| Layer           | What it verifies                                                            | Tool                                                  | Cost               |
| --------------- | --------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------ |
| **Static**      | `t('key')` autocomplete + type errors on bad keys; IPC contract types match | TypeScript + `pnpm ipc:check` + new `pnpm i18n:check` | Free, runs on save |
| **Unit**        | `localeDirection()`, schema validation, locale resolver, instance creation  | Vitest                                                | Fast               |
| **Integration** | IPC `locale:set` round-trip, persistence, broadcast event delivery          | Vitest with mocked IPC                                | Fast               |
| **E2E**         | Live language switching, RTL visual, native menu rebuild                    | Playwright (built bundle)                             | Slow but rare      |

### Concrete test files

```
packages/i18n/
├── src/shared/direction.test.ts         # known + unknown locale → 'ltr'/'rtl'
├── src/main/index.test.ts               # main init, fallback chain
└── src/renderer/index.test.ts           # renderer init, useT re-render on changeLanguage

apps/desktop/
├── src/main/ipc/locale.test.ts          # IPC handlers: success, validation reject, FS failure
├── src/renderer/.../settings-locale.test.tsx   # picker → IPC → toast on success
└── e2e/i18n.spec.ts                     # NEW Playwright spec
```

### Playwright E2E (`e2e/i18n.spec.ts`)

Three scenarios, runs against the built bundle (per memry's existing E2E pattern):

1. **Switch language live** — boot, open settings, pick Türkçe, assert known string flips, assert no error toast.
2. **RTL applied for Arabic** — pick Arabic, assert `<html dir="rtl">`, assert sidebar bounding-box right-anchored (not pixel-match).
3. **Native menu rebuilds** — pick Türkçe, query Electron menu via `electronApp.evaluate(({ Menu }) => …)`, assert "File" became "Dosya".

No per-locale snapshot for every page. Bounding-box assertions catch layout breaks; pixel comparisons catch font-rendering noise and create flakes.

### `pnpm i18n:check` script

A small AST-based script (`apps/desktop/scripts/i18n-check.js`) running in CI alongside `ipc:check`:

```bash
pnpm i18n:check
# Output:
#   ✓ 847 keys used across 312 files
#   ✓ All keys exist in en/* bundles
#   ⚠ 234 keys missing in tr/* (will fall back to en)
#   ⚠ 234 keys missing in ar/* (will fall back to en)
#   ✗ 3 orphan keys in en/inbox.json: ['old.unused.thing', ...]
```

| Signal                                                      | Exit                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Missing key in `en.json` referenced by `t()`                | **Fail CI** — real bug                                               |
| Missing key in `tr.json`/`ar.json` that exists in `en.json` | **Warn** — translations are a content problem on a separate timeline |
| Orphan key (in JSON but never referenced)                   | **Warn** — suggests cleanup                                          |

### What we're NOT testing in v1

- Translation accuracy (translator review problem, not software test)
- Every namespace lazy-loads correctly (covered by E2E "switch live")
- All ICU plural categories for all locales (write 2-3 representative tests, trust the library)
- Pixel-perfect RTL screenshots (too flaky)

### CI integration

Existing PR command:

```bash
pnpm lint && pnpm typecheck && pnpm ipc:check && pnpm test
```

becomes:

```bash
pnpm lint && pnpm typecheck && pnpm ipc:check && pnpm i18n:check && pnpm test
```

E2E (`pnpm test:e2e`) runs on its own gate. The new `i18n.spec.ts` lives there.

## Acceptance Criteria for v1 Ship

- All Phase A–E PRs merged.
- `pnpm i18n:check` passes — no missing English keys.
- `pnpm test:e2e` passes including new `i18n.spec.ts`.
- English UI is visually identical to pre-i18n state (regression bar).
- TR + AR stubs exist; switching to them shows graceful English fallback.
- Settings picker functional. Locale persists across restart.
- `docs/i18n-adding-a-locale.md` exists — checklist for adding language number 4.

## Risks Verified During Phase A

| Risk                                         | Mitigation                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `react-i18next` v15 + React 19 compatibility | Smoke-test on day 1: `<Suspense>` + lazy-loading + React 19 transitions. The library officially supports React 19 but validate. |
| `Intl.Locale.textInfo` works in Electron 39  | One-liner verification: `console.log(new Intl.Locale('ar').textInfo.direction)` should print `'rtl'`.                           |
| Native menu rebuild on macOS doesn't flicker | Build menu, swap via `Menu.setApplicationMenu`. Visually confirm. macOS sometimes does odd things with system-owned menu bars.  |

## Future Enhancements (Deferred)

1. **OS-locale auto-detection** on first launch (~30 lines in main-process boot resolver)
2. **Region overrides** (`en-GB` vs `en-US`) — when explicitly requested
3. **Translation pipeline** integration (Crowdin, Lokalise) — when ≥4 active locales with external translators
4. **`firstDayOfWeek`, `timezone`, `dateFormat`** as settings fields — split into `LocaleSettings` schema if/when they accumulate
5. **RTL cleanup codemod** for the existing ~939 renderer files — converts legacy physical Tailwind classes (`ml-*`, `pr-*`, `left-*`, `text-left`) to logical equivalents (`ms-*`, `pe-*`, `start-*`, `text-start`). RTL is fully _supported_ from Phase A onward (new code uses logical classes); this codemod is the visual polish pass that makes pre-existing components also flip correctly. Run it before `tr.json` / `ar.json` are populated for real users — until then, an Arabic user sees ~80–90% correct RTL with minor layout artifacts in legacy components. The codemod is mechanical via `jscodeshift`; ~95% automated, the rest flagged for human review.
6. **Pluralization expansion** with ICU `select` and `selectordinal` — the library supports it; use as needed
7. **Bidi-perfect rendering inside BlockNote** — when an Arabic-locale user writes substantial notes and reports issues
