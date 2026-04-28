# i18n Phase A — Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the i18n infrastructure for memry. After Phase A, the app supports live language switching (English, Turkish, Arabic) with RTL handling, but no existing UI strings are migrated yet — that's Phase B onward (separate plans).

**Architecture:** A new shared `packages/i18n` workspace package wraps `react-i18next` + `i18next-icu`, with separate entry points for the Electron main process and renderer. The existing `GeneralSettings.language` field is tightened from a loose `z.string().min(2).max(5)` into a strict `z.enum(['en', 'tr', 'ar'])`. A new `locale` IPC surface (separate from the existing settings IPC) atomically persists, applies, and broadcasts language changes; the main process is the source of truth. Document direction (`<html dir>`) flips on RTL locales via `Intl.Locale.textInfo`.

**Tech Stack:** TypeScript, React 19, Electron 39, Vite, `i18next` v23+, `react-i18next` v15+, `i18next-icu`, `i18next-resources-to-backend`, Vitest, Playwright, Zod v4, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`

**Out of scope for this plan (deferred to Phase B–E plans):**
- Migrating any existing UI strings (Phase B–C)
- Translating `tr.json` / `ar.json` content beyond a smoke-test seed (Phase B onward)
- `pnpm i18n:check` script and ESLint rule for missing keys (Phase E)
- `jscodeshift` codemod that rewrites physical Tailwind classes to logical (deferred enhancement)
- BlockNote bidi handling (known-issue list, not v1)

**Pre-existing field decision:** `GeneralSettings` already has `language: z.string().min(2).max(5)` (default `'en'`). This plan **tightens it to an enum, keeps the name**. Renaming to `locale` is a 30-file cosmetic change with zero functional benefit and is explicitly NOT done here. The new IPC surface uses `LocaleApi` / `LocaleSchema` naming because those are net-new.

---

## Worktree Setup

Per memry's MEMORY.md: *"implement plan changes in git worktrees, not directly on current branch."* Create a worktree before any coding.

- [ ] **Step 1: Create worktree**

```bash
git worktree add ../memry-i18n-phase-a -b feature/i18n-phase-a
cd ../memry-i18n-phase-a
```

Expected: worktree created on a fresh branch off main.

- [ ] **Step 2: Verify clean state**

```bash
git status
pnpm install
```

Expected: working tree clean, dependencies installed.

---

## Pre-Flight: Risk Register Validations

The spec lists three risks to verify on day 1, before relying on them. These are 5-minute confidence checks, not full implementations.

### Task 0a: Verify `Intl.Locale.textInfo` works in Electron 39

**Files:**
- Modify (temporarily): `apps/desktop/src/main/index.ts:51` — add a one-line log near the top

- [ ] **Step 1: Add temporary log**

Edit `apps/desktop/src/main/index.ts`. Right after the existing `if (process.type === 'browser')` block (around line 51-53), insert:

```ts
console.log('[i18n preflight]', {
  ar: new Intl.Locale('ar').textInfo.direction,
  en: new Intl.Locale('en').textInfo.direction,
  he: new Intl.Locale('he').textInfo.direction
})
```

- [ ] **Step 2: Run dev and capture output**

Run: `pnpm dev`
Expected: in main-process logs (terminal where you ran `pnpm dev`), see:
```
[i18n preflight] { ar: 'rtl', en: 'ltr', he: 'rtl' }
```

If `textInfo` is `undefined`, abort: Electron's V8 doesn't have it yet, and we'd need a fallback locale-direction table. Update the spec accordingly. **This is the gate for proceeding.**

- [ ] **Step 3: Remove the temporary log**

Delete the inserted lines. The risk is resolved; we don't ship debug logs.

- [ ] **Step 4: Commit**

```bash
git checkout -- apps/desktop/src/main/index.ts
```

(No commit needed — temporary code reverted.)

### Task 0b: Verify `react-i18next` v15 + React 19 compatibility

We confirm via the package itself rather than running real code. `react-i18next`'s peer-dep range claims React 19; we verify before installing.

- [ ] **Step 1: Check the latest peer-deps range**

Run: `pnpm view react-i18next peerDependencies`
Expected: react peer dep range includes `^19.0.0` (e.g., `>=16.8.0` or explicitly `^19`). If only `^16 || ^17 || ^18`, pin to a version that supports 19 or accept the warning. As of 2026-04, `react-i18next@15.x` supports React 19.

- [ ] **Step 2: Note the resolved version for Task 2**

Record the version (e.g., `15.4.0`). Used for the `pnpm add` command in Task 2.

### Task 0c: Verify native macOS menu rebuilds without flicker

Deferred validation — happens during Task 16 (Native Menu Rebuild) when we actually rebuild a menu. No standalone preflight needed.

---

## Task 1: Create `packages/i18n` Package Skeleton

**Files:**
- Create: `packages/i18n/package.json`
- Create: `packages/i18n/tsconfig.json`
- Create: `packages/i18n/src/index.ts`

- [ ] **Step 1: Create the package directory**

```bash
mkdir -p packages/i18n/src/shared
mkdir -p packages/i18n/src/main
mkdir -p packages/i18n/src/renderer
mkdir -p packages/i18n/src/locales/en
mkdir -p packages/i18n/src/locales/tr
mkdir -p packages/i18n/src/locales/ar
```

- [ ] **Step 2: Write `packages/i18n/package.json`**

Match memry's existing package convention (source-pointing exports, no build step):

```json
{
  "name": "@memry/i18n",
  "version": "0.1.0",
  "private": true,
  "license": "GPL-3.0",
  "type": "module",
  "exports": {
    "./main": "./src/main/index.ts",
    "./renderer": "./src/renderer/index.ts",
    "./shared": "./src/shared/index.ts",
    "./locales": "./src/locales/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "@memry/typescript-config": "workspace:*"
  },
  "dependencies": {
    "@memry/contracts": "workspace:*",
    "i18next": "^23.16.0",
    "react-i18next": "^15.4.0",
    "i18next-icu": "^2.3.0",
    "i18next-resources-to-backend": "^1.2.1",
    "intl-messageformat": "^10.7.0",
    "zod": "^4.3.4"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

- [ ] **Step 3: Write `packages/i18n/tsconfig.json`**

```json
{
  "extends": "@memry/typescript-config/node.json",
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "**/*.test.tsx"],
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "baseUrl": "."
  }
}
```

- [ ] **Step 4: Write a placeholder `src/index.ts` so the package resolves**

```ts
export { } // placeholder; real exports live in /main, /renderer, /shared
```

- [ ] **Step 5: Run install + typecheck to verify the workspace picks it up**

```bash
pnpm install
pnpm --filter @memry/i18n typecheck
```

Expected: `typecheck` passes (no source files to check yet beyond placeholder).

- [ ] **Step 6: Commit**

```bash
git add packages/i18n/
git commit -m "feat(i18n): scaffold @memry/i18n package skeleton"
```

---

## Task 2: Install Dependencies into Desktop App

The desktop app needs `@memry/i18n` as a workspace dependency.

**Files:**
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Add workspace dep**

Edit `apps/desktop/package.json`. In `dependencies`, add:

```json
"@memry/i18n": "workspace:*"
```

(Insert alphabetically among other `@memry/*` deps.)

- [ ] **Step 2: Install**

```bash
pnpm install
```

Expected: lockfile updates, `@memry/i18n` linked.

- [ ] **Step 3: Verify resolution from desktop**

```bash
node --input-type=module -e "console.log(import.meta.resolve ? 'ok' : 'missing')" 2>&1 | head -1
```

(Just a sanity check that the workspace is wired. The real test is in later tasks where we import from `@memry/i18n/main`.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat(i18n): wire @memry/i18n into desktop app"
```

---

## Task 3: Implement `shared/config.ts` — Locale Constants

**Files:**
- Create: `packages/i18n/src/shared/config.ts`
- Create: `packages/i18n/src/shared/index.ts`

**Note:** `LocaleSchema`, `Locale`, `SUPPORTED_LOCALES`, and `FALLBACK_LOCALE` are owned by `@memry/contracts/locale-api` (created later in Task 10). To keep one canonical source of truth and avoid drift, this file imports them and adds *only* runtime UI concerns (display names, namespaces). That means **Task 10 must run before Task 3 finishes**, OR Task 3 lands a temporary local copy that Task 10 replaces. Choose one of:

- **Path A (cleaner, recommended):** reorder execution so Task 10 runs immediately after Task 2, then come back to Task 3
- **Path B (sequential):** define `LocaleSchema` etc. locally in Task 3, then in Task 10 swap to importing from contracts

The example below assumes **Path A** — the import is from `@memry/contracts/locale-api` which Task 10 creates. If you go Path B, replace the import line with the local definitions and clean up after Task 10.

- [ ] **Step 1: Write `packages/i18n/src/shared/config.ts`**

```ts
/**
 * Locale configuration: display names and namespace registry.
 *
 * Locale identity (LocaleSchema, Locale type, SUPPORTED_LOCALES, FALLBACK_LOCALE)
 * is owned by @memry/contracts/locale-api. This file extends that with the
 * runtime/UI concerns: human-readable display names and the i18next namespace list.
 *
 * LOCALE_DISPLAY_NAMES are intentionally NOT translated — each language's
 * name is shown in its own native script so users can find their language
 * regardless of the current UI locale.
 */

import { type Locale } from '@memry/contracts/locale-api'

export { LocaleSchema, type Locale, SUPPORTED_LOCALES, FALLBACK_LOCALE } from '@memry/contracts/locale-api'

export const LOCALE_DISPLAY_NAMES: Record<Locale, string> = {
  en: 'English',
  tr: 'Türkçe',
  ar: 'العربية'
}

export const I18N_NAMESPACES = [
  'common',
  'inbox',
  'notes',
  'journal',
  'calendar',
  'settings',
  'errors',
  'menu'
] as const

export type I18nNamespace = (typeof I18N_NAMESPACES)[number]

export const DEFAULT_NAMESPACE: I18nNamespace = 'common'
```

This requires `@memry/contracts: workspace:*` in `packages/i18n/package.json` — add it now (edit Task 1's package.json snippet to include it, or amend the file in this step).

- [ ] **Step 2: Write `packages/i18n/src/shared/index.ts`**

```ts
export * from './config'
export * from './direction'
```

(Note: `direction.ts` doesn't exist yet; the export will fail typecheck until Task 4. That's OK for the commit ordering — Task 4 follows immediately.)

- [ ] **Step 3: Commit (skip typecheck for now)**

```bash
git add packages/i18n/src/shared/config.ts packages/i18n/src/shared/index.ts
git commit -m "feat(i18n): add SUPPORTED_LOCALES and display names config"
```

---

## Task 4: Implement `shared/direction.ts` — Direction Helper (TDD)

**Files:**
- Create: `packages/i18n/src/shared/direction.ts`
- Create: `packages/i18n/src/shared/direction.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/i18n/src/shared/direction.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { localeDirection } from './direction'

describe('localeDirection', () => {
  it('returns ltr for English', () => {
    expect(localeDirection('en')).toBe('ltr')
  })

  it('returns ltr for Turkish', () => {
    expect(localeDirection('tr')).toBe('ltr')
  })

  it('returns rtl for Arabic', () => {
    expect(localeDirection('ar')).toBe('rtl')
  })

  it('returns rtl for Hebrew (forward-compat for future locales)', () => {
    expect(localeDirection('he')).toBe('rtl')
  })

  it('returns ltr for unknown locale (Intl default behavior)', () => {
    expect(localeDirection('xx')).toBe('ltr')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @memry/i18n test direction.test.ts
```

Expected: FAIL with "Cannot find module './direction'" or similar.

- [ ] **Step 3: Implement `packages/i18n/src/shared/direction.ts`**

```ts
/**
 * Returns the writing direction for a locale using `Intl.Locale.textInfo`.
 * Built into Electron 39 (Chromium 119+ / V8 12.0). No fallback table —
 * the platform owns the locale-direction mapping.
 */
export function localeDirection(locale: string): 'ltr' | 'rtl' {
  return new Intl.Locale(locale).textInfo.direction
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @memry/i18n test direction.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Run typecheck on the package**

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add packages/i18n/src/shared/direction.ts packages/i18n/src/shared/direction.test.ts
git commit -m "feat(i18n): add localeDirection helper via Intl.Locale.textInfo"
```

---

## Task 5: Implement `shared/types.ts` — i18next Module Augmentation

This makes `t('inbox.triage.archive')` type-checked against the actual JSON resource files.

**Files:**
- Create: `packages/i18n/src/shared/types.ts`

- [ ] **Step 1: Create the resource type module**

Note: the namespace JSONs don't exist yet (Task 7 creates them). For this task, write the augmentation against placeholder shapes — Task 7 will make them concrete.

Write `packages/i18n/src/shared/types.ts`:

```ts
/**
 * TypeScript module augmentation that types `t()` calls against the
 * English locale resources (the source of truth). Bad keys become
 * compile-time errors.
 *
 * Usage:
 *   const { t } = useT('inbox')
 *   t('triage.archive')         // ✅ checked against en/inbox.json
 *   t('triage.does-not-exist')  // ❌ TS error
 */

import type common from '../locales/en/common.json'
import type inbox from '../locales/en/inbox.json'
import type notes from '../locales/en/notes.json'
import type journal from '../locales/en/journal.json'
import type calendar from '../locales/en/calendar.json'
import type settings from '../locales/en/settings.json'
import type errors from '../locales/en/errors.json'
import type menu from '../locales/en/menu.json'

export interface Resources {
  common: typeof common
  inbox: typeof inbox
  notes: typeof notes
  journal: typeof journal
  calendar: typeof calendar
  settings: typeof settings
  errors: typeof errors
  menu: typeof menu
}

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: Resources
  }
}
```

- [ ] **Step 2: Don't commit yet**

This file references JSONs that don't exist — typecheck will fail. We commit after Task 7 creates the JSONs.

---

## Task 6: Update `shared/index.ts` Barrel

**Files:**
- Modify: `packages/i18n/src/shared/index.ts`

- [ ] **Step 1: Update barrel to include direction**

```ts
export * from './config'
export * from './direction'
```

(types.ts is augmentation-only — no runtime export needed.)

- [ ] **Step 2: Verify typecheck still fails (because of types.ts JSON imports)**

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: FAIL with "Cannot find module '../locales/en/common.json'" — fixed by Task 7.

---

## Task 7: Seed Locale Resource JSONs

Phase A ships with a tiny seed of strings to validate end-to-end switching. Real string migration is Phase B.

**Files:**
- Create: `packages/i18n/src/locales/en/{common,inbox,notes,journal,calendar,settings,errors,menu}.json`
- Create: `packages/i18n/src/locales/tr/{...same...}.json`
- Create: `packages/i18n/src/locales/ar/{...same...}.json`
- Create: `packages/i18n/src/locales/index.ts`

The English files have a few seed strings used by the Phase A settings UI and E2E test. The TR/AR files for `settings` and `menu` have translations for the same seed strings (so we can verify switching). Other namespaces are `{}`.

- [ ] **Step 1: Create English `common.json`**

`packages/i18n/src/locales/en/common.json`:

```json
{
  "button": {
    "save": "Save",
    "cancel": "Cancel",
    "close": "Close"
  }
}
```

- [ ] **Step 2: Create English `settings.json`**

`packages/i18n/src/locales/en/settings.json`:

```json
{
  "general": {
    "language": {
      "label": "Language",
      "helper": "Most of the app updates immediately. Some system-level text — already-shown notifications, dock label, window title bar — refreshes after the next launch.",
      "changed": "Language changed to {{nativeName}}"
    }
  }
}
```

- [ ] **Step 3: Create English `menu.json`**

`packages/i18n/src/locales/en/menu.json`:

```json
{
  "file": {
    "label": "File",
    "newNote": "New Note"
  },
  "edit": {
    "label": "Edit"
  },
  "view": {
    "label": "View"
  }
}
```

- [ ] **Step 4: Create empty English JSON for unused namespaces**

For `inbox.json`, `notes.json`, `journal.json`, `calendar.json`, `errors.json` — create as `{}`:

```bash
echo '{}' > packages/i18n/src/locales/en/inbox.json
echo '{}' > packages/i18n/src/locales/en/notes.json
echo '{}' > packages/i18n/src/locales/en/journal.json
echo '{}' > packages/i18n/src/locales/en/calendar.json
echo '{}' > packages/i18n/src/locales/en/errors.json
```

- [ ] **Step 5: Create Turkish `settings.json`**

`packages/i18n/src/locales/tr/settings.json`:

```json
{
  "general": {
    "language": {
      "label": "Dil",
      "helper": "Uygulamanın çoğu hemen güncellenir. Bazı sistem düzeyindeki metinler — gösterilmiş bildirimler, dock etiketi, pencere başlığı — bir sonraki başlatmadan sonra yenilenir.",
      "changed": "Dil {{nativeName}} olarak değiştirildi"
    }
  }
}
```

- [ ] **Step 6: Create Turkish `menu.json`**

`packages/i18n/src/locales/tr/menu.json`:

```json
{
  "file": {
    "label": "Dosya",
    "newNote": "Yeni Not"
  },
  "edit": {
    "label": "Düzenle"
  },
  "view": {
    "label": "Görünüm"
  }
}
```

- [ ] **Step 7: Create Turkish `common.json`**

`packages/i18n/src/locales/tr/common.json`:

```json
{
  "button": {
    "save": "Kaydet",
    "cancel": "İptal",
    "close": "Kapat"
  }
}
```

- [ ] **Step 8: Create empty Turkish JSON for unused namespaces**

```bash
echo '{}' > packages/i18n/src/locales/tr/inbox.json
echo '{}' > packages/i18n/src/locales/tr/notes.json
echo '{}' > packages/i18n/src/locales/tr/journal.json
echo '{}' > packages/i18n/src/locales/tr/calendar.json
echo '{}' > packages/i18n/src/locales/tr/errors.json
```

- [ ] **Step 9: Create Arabic seed JSONs**

`packages/i18n/src/locales/ar/settings.json`:

```json
{
  "general": {
    "language": {
      "label": "اللغة",
      "helper": "يتم تحديث معظم التطبيق على الفور. بعض النصوص على مستوى النظام — الإشعارات المعروضة بالفعل، علامة Dock، شريط عنوان النافذة — يتم تحديثها بعد الإطلاق التالي.",
      "changed": "تم تغيير اللغة إلى {{nativeName}}"
    }
  }
}
```

`packages/i18n/src/locales/ar/menu.json`:

```json
{
  "file": {
    "label": "ملف",
    "newNote": "ملاحظة جديدة"
  },
  "edit": {
    "label": "تحرير"
  },
  "view": {
    "label": "عرض"
  }
}
```

`packages/i18n/src/locales/ar/common.json`:

```json
{
  "button": {
    "save": "حفظ",
    "cancel": "إلغاء",
    "close": "إغلاق"
  }
}
```

- [ ] **Step 10: Create empty Arabic JSON for unused namespaces**

```bash
echo '{}' > packages/i18n/src/locales/ar/inbox.json
echo '{}' > packages/i18n/src/locales/ar/notes.json
echo '{}' > packages/i18n/src/locales/ar/journal.json
echo '{}' > packages/i18n/src/locales/ar/calendar.json
echo '{}' > packages/i18n/src/locales/ar/errors.json
```

- [ ] **Step 11: Create `packages/i18n/src/locales/index.ts`**

```ts
/**
 * Re-export all locale JSON resources for direct access. Most consumers
 * use the i18next instance via /main or /renderer instead.
 */

import enCommon from './en/common.json'
import enInbox from './en/inbox.json'
import enNotes from './en/notes.json'
import enJournal from './en/journal.json'
import enCalendar from './en/calendar.json'
import enSettings from './en/settings.json'
import enErrors from './en/errors.json'
import enMenu from './en/menu.json'

import trCommon from './tr/common.json'
import trInbox from './tr/inbox.json'
import trNotes from './tr/notes.json'
import trJournal from './tr/journal.json'
import trCalendar from './tr/calendar.json'
import trSettings from './tr/settings.json'
import trErrors from './tr/errors.json'
import trMenu from './tr/menu.json'

import arCommon from './ar/common.json'
import arInbox from './ar/inbox.json'
import arNotes from './ar/notes.json'
import arJournal from './ar/journal.json'
import arCalendar from './ar/calendar.json'
import arSettings from './ar/settings.json'
import arErrors from './ar/errors.json'
import arMenu from './ar/menu.json'

export const RESOURCES = {
  en: {
    common: enCommon,
    inbox: enInbox,
    notes: enNotes,
    journal: enJournal,
    calendar: enCalendar,
    settings: enSettings,
    errors: enErrors,
    menu: enMenu
  },
  tr: {
    common: trCommon,
    inbox: trInbox,
    notes: trNotes,
    journal: trJournal,
    calendar: trCalendar,
    settings: trSettings,
    errors: trErrors,
    menu: trMenu
  },
  ar: {
    common: arCommon,
    inbox: arInbox,
    notes: arNotes,
    journal: arJournal,
    calendar: arCalendar,
    settings: arSettings,
    errors: arErrors,
    menu: arMenu
  }
} as const
```

- [ ] **Step 12: Configure tsconfig to allow JSON imports**

Edit `packages/i18n/tsconfig.json`. Add to `compilerOptions`:

```json
"resolveJsonModule": true,
"esModuleInterop": true
```

- [ ] **Step 13: Verify typecheck passes**

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes. The `types.ts` augmentation now resolves the JSON imports.

- [ ] **Step 14: Commit**

```bash
git add packages/i18n/src/locales/ packages/i18n/src/shared/types.ts packages/i18n/tsconfig.json
git commit -m "feat(i18n): seed locale JSONs and i18next type augmentation"
```

---

## Task 8: Implement `main/load-resources.ts` — Synchronous JSON Loader

The main process needs synchronous loading because the native menu builds before the first window opens.

**Files:**
- Create: `packages/i18n/src/main/load-resources.ts`
- Create: `packages/i18n/src/main/load-resources.test.ts`

- [ ] **Step 1: Write the test**

`packages/i18n/src/main/load-resources.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { loadResources } from './load-resources'

describe('loadResources', () => {
  it('returns all namespaces for English', () => {
    const result = loadResources('en')
    expect(result.common).toBeDefined()
    expect(result.settings).toBeDefined()
    expect(result.menu).toBeDefined()
  })

  it('returns the actual translated strings', () => {
    const result = loadResources('tr')
    expect(result.menu.file.label).toBe('Dosya')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @memry/i18n test load-resources
```

Expected: FAIL — "Cannot find module './load-resources'".

- [ ] **Step 3: Implement `load-resources.ts`**

```ts
import type { Locale } from '../shared/config'
import { RESOURCES } from '../locales'
import type { Resources } from '../shared/types'

/**
 * Returns the full set of namespaces for a locale, loaded eagerly via the
 * static RESOURCES map. Used by the main-process i18next instance, which
 * must initialize synchronously before the native menu is built.
 */
export function loadResources(locale: Locale): Resources {
  return RESOURCES[locale]
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @memry/i18n test load-resources
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/src/main/load-resources.ts packages/i18n/src/main/load-resources.test.ts
git commit -m "feat(i18n): add synchronous resource loader for main process"
```

---

## Task 9: Implement `main/index.ts` — Main Process i18next Instance

**Files:**
- Create: `packages/i18n/src/main/index.ts`
- Create: `packages/i18n/src/main/index.test.ts`

- [ ] **Step 1: Write the test**

`packages/i18n/src/main/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createMainI18n } from './index'

describe('createMainI18n', () => {
  it('initializes with the requested locale', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })
    expect(i18n.language).toBe('tr')
  })

  it('translates a known menu key', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })
    expect(i18n.t('menu:file.label')).toBe('Dosya')
  })

  it('falls back to English for missing keys', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })
    // 'menu:edit.label' exists in tr; pick a key only in en — but our seed has both.
    // Use a non-existent key to test fallback to fallback language:
    expect(i18n.t('menu:nonexistent.key')).toBe('menu:nonexistent.key')
  })

  it('changeLanguage updates the active locale', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    expect(i18n.t('menu:file.label')).toBe('File')
    await i18n.changeLanguage('tr')
    expect(i18n.t('menu:file.label')).toBe('Dosya')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @memry/i18n test main/index
```

Expected: FAIL — "Cannot find module './index'".

- [ ] **Step 3: Implement `main/index.ts`**

```ts
import i18next, { type i18n as I18nInstance } from 'i18next'
import ICU from 'i18next-icu'
import { type Locale, FALLBACK_LOCALE, I18N_NAMESPACES, DEFAULT_NAMESPACE } from '../shared/config'
import { loadResources } from './load-resources'
import { RESOURCES } from '../locales'

interface CreateMainI18nOptions {
  locale: Locale
}

/**
 * Creates an i18next instance for the Electron main process.
 *
 * Synchronous resource loading: all namespaces for all SUPPORTED_LOCALES
 * are bundled into the main-process JS bundle via the static RESOURCES
 * import, then provided to i18next at init time. No filesystem I/O,
 * no async race with menu construction.
 */
export async function createMainI18n(options: CreateMainI18nOptions): Promise<I18nInstance> {
  const instance = i18next.createInstance()
  await instance
    .use(ICU)
    .init({
      lng: options.locale,
      fallbackLng: FALLBACK_LOCALE,
      ns: I18N_NAMESPACES,
      defaultNS: DEFAULT_NAMESPACE,
      resources: RESOURCES,
      interpolation: {
        escapeValue: false // main process renders no HTML
      },
      initImmediate: false // synchronous init
    })
  return instance
}

export type { I18nInstance }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @memry/i18n test main/index
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/src/main/index.ts packages/i18n/src/main/index.test.ts
git commit -m "feat(i18n): add main-process i18next instance factory"
```

---

## Task 10: Define `LocaleSchema` in Contracts + Add `locale-api.ts`

**Files:**
- Create: `packages/contracts/src/locale-api.ts`
- Modify: `packages/contracts/package.json` (add export)

- [ ] **Step 1: Write `packages/contracts/src/locale-api.ts`**

```ts
import { z } from 'zod'

export const LocaleSchema = z.enum(['en', 'tr', 'ar'])
export type Locale = z.infer<typeof LocaleSchema>

export const SUPPORTED_LOCALES = LocaleSchema.options
export const FALLBACK_LOCALE: Locale = 'en'

/**
 * Renderer-side IPC bridge for runtime locale control. Distinct from the
 * existing settings IPC: `LocaleApi.set` atomically persists the
 * `GeneralSettings.language` field AND triggers a runtime change
 * (instance.changeLanguage + native menu rebuild + broadcast).
 */
export interface LocaleApi {
  get: () => Promise<Locale>
  set: (locale: Locale) => Promise<void>
  list: () => Promise<readonly Locale[]>
}

export const LOCALE_CHANGED_EVENT = 'locale:changed' as const
```

- [ ] **Step 2: Add the export to `packages/contracts/package.json`**

In the `exports` field (alphabetical), insert:

```json
"./locale-api": "./src/locale-api.ts",
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm --filter @memry/contracts typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/locale-api.ts packages/contracts/package.json
git commit -m "feat(i18n): add LocaleSchema and LocaleApi contract"
```

---

## Task 11: Tighten `GeneralSettings.language` to LocaleSchema

The existing `language: z.string().min(2).max(5)` field is replaced with the strict enum. The default stays `'en'`.

**Files:**
- Modify: `packages/contracts/src/settings-schemas.ts:22` (and the matching default at line 36)

- [ ] **Step 1: Tighten the schema**

In `packages/contracts/src/settings-schemas.ts`, find:

```ts
language: z.string().min(2).max(5),
```

Replace with:

```ts
language: LocaleSchema,
```

Add the import at the top of the file:

```ts
import { LocaleSchema } from './locale-api'
```

The default `language: 'en'` at line 36 remains unchanged (it already matches `Locale`).

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @memry/contracts typecheck
```

Expected: passes — `'en'` is a valid member of the enum.

- [ ] **Step 3: Run the existing settings-schemas test**

```bash
pnpm --filter @memry/contracts test settings-schemas
```

Expected: passes. If any test was using `language: 'foo'` to test the loose-string acceptance, that test fails — update it to use a valid locale or test rejection.

- [ ] **Step 4: Run desktop typecheck to catch downstream breakage**

```bash
pnpm typecheck:desktop
```

Expected: passes. The 30 consumer files reading `settings.general.language` see a more-specific type but no runtime change.

If any consumer was doing something like `if (settings.general.language === 'es')` (not a member of the enum), TypeScript will now flag it as unreachable — investigate and fix per case.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/settings-schemas.ts
git commit -m "feat(i18n): tighten GeneralSettings.language to LocaleSchema"
```

---

## Task 12: Validate IPC Contract Boundary

**Files:**
- Run: `pnpm ipc:check`

- [ ] **Step 1: Run the contract validator**

```bash
pnpm ipc:check
```

Expected: passes. We haven't yet added the `LocaleApi` to the preload bridge — that's Task 14. This check verifies the existing settings IPC still type-checks after the `language` tightening.

- [ ] **Step 2: If failures, fix per memry's existing IPC pattern**

Likely fixes: regenerated types for `getSettings` / `updateSettings` may surface narrower types in `apps/desktop/src/preload/generated-rpc.ts`. Run `pnpm ipc:generate` if the workflow doc mentions it, then `ipc:check` again.

- [ ] **Step 3: Commit (only if regenerated files changed)**

```bash
git status
git add apps/desktop/src/preload/ apps/desktop/src/main/ipc/
git commit -m "chore(i18n): regenerate IPC types after schema tightening" || echo "no changes"
```

---

## Task 13: Implement IPC Channel Constant for `locale:changed`

The IPC channels package centralizes channel names. Locale change broadcasts need a channel.

**Files:**
- Modify: `packages/contracts/src/ipc-channels.ts` (add LocaleChannels)

- [ ] **Step 1: Read the existing pattern**

```bash
head -50 packages/contracts/src/ipc-channels.ts
```

Note the existing pattern (e.g., `SettingsChannels`).

- [ ] **Step 2: Add LocaleChannels**

Append to `packages/contracts/src/ipc-channels.ts`:

```ts
export const LocaleChannels = {
  Get: 'locale:get',
  Set: 'locale:set',
  List: 'locale:list',
  Changed: 'locale:changed'
} as const
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm --filter @memry/contracts typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/ipc-channels.ts
git commit -m "feat(i18n): add LocaleChannels IPC constants"
```

---

## Task 14: Implement `apps/desktop/src/main/ipc/locale-handler.ts`

**Files:**
- Create: `apps/desktop/src/main/ipc/locale-handler.ts`
- Create: `apps/desktop/src/main/ipc/locale-handler.test.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts` (register the handler)

- [ ] **Step 1: Find the existing IPC registration pattern**

```bash
ls apps/desktop/src/main/ipc/
cat apps/desktop/src/main/ipc/index.ts | head -40
```

Note how other handlers (e.g., `settings-handlers.ts`) register themselves.

- [ ] **Step 2: Write the handler test**

`apps/desktop/src/main/ipc/locale-handler.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('@memry/i18n/main', () => ({
  createMainI18n: vi.fn(),
  loadResources: vi.fn()
}))

import { ipcMain } from 'electron'
import { registerLocaleHandlers, getActiveLocale } from './locale-handler'

describe('locale handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers get, set, list channels', () => {
    const mockI18n = { changeLanguage: vi.fn(), language: 'en' } as any
    registerLocaleHandlers(mockI18n, () => {})
    expect(ipcMain.handle).toHaveBeenCalledWith('locale:get', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('locale:set', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('locale:list', expect.any(Function))
  })

  it('rejects an invalid locale string', async () => {
    const mockI18n = { changeLanguage: vi.fn(), language: 'en' } as any
    registerLocaleHandlers(mockI18n, () => {})
    const setHandler = (ipcMain.handle as any).mock.calls.find(
      ([ch]: [string]) => ch === 'locale:set'
    )[1]
    await expect(setHandler({}, 'invalid' as any)).rejects.toThrow()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @memry/desktop test locale-handler
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `locale-handler.ts`**

```ts
import { ipcMain, BrowserWindow } from 'electron'
import { LocaleChannels } from '@memry/contracts/ipc-channels'
import { LocaleSchema, SUPPORTED_LOCALES, type Locale } from '@memry/contracts/locale-api'
import type { I18nInstance } from '@memry/i18n/main'
import { createLogger } from '../lib/logger'
import { getGeneralSettings, updateGeneralSettings } from '../store/settings-store'

const logger = createLogger('Locale')

export type RebuildMenuFn = (locale: Locale) => void

let activeLocale: Locale = 'en'

export function getActiveLocale(): Locale {
  return activeLocale
}

export function registerLocaleHandlers(
  i18n: I18nInstance,
  rebuildMenu: RebuildMenuFn
): void {
  activeLocale = i18n.language as Locale

  ipcMain.handle(LocaleChannels.Get, () => activeLocale)

  ipcMain.handle(LocaleChannels.List, () => SUPPORTED_LOCALES)

  ipcMain.handle(LocaleChannels.Set, async (_event, candidate: unknown): Promise<void> => {
    const locale = LocaleSchema.parse(candidate)
    if (locale === activeLocale) return

    logger.info('Changing locale', { from: activeLocale, to: locale })

    try {
      // 1. Persist to settings (existing settings-store)
      const current = await getGeneralSettings()
      await updateGeneralSettings({ ...current, language: locale })

      // 2. Update main-process i18next
      await i18n.changeLanguage(locale)

      // 3. Rebuild native menu
      rebuildMenu(locale)

      // 4. Broadcast to all renderer windows
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(LocaleChannels.Changed, locale)
      }

      activeLocale = locale
      logger.info('Locale changed', { locale })
    } catch (err) {
      logger.error('Locale change failed', { locale, error: err })
      throw err
    }
  })
}
```

**Note on `getGeneralSettings` / `updateGeneralSettings`**: these may already exist under different names. Search:

```bash
grep -r "getGeneralSettings\|updateGeneralSettings\|generalSettings" apps/desktop/src/main/store/ apps/desktop/src/main/ipc/settings-handlers.ts | head -20
```

Adapt the import path to match the actual store API. If memry uses a different settings-access pattern, follow it instead.

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @memry/desktop test locale-handler
```

Expected: 2 tests pass. If the test fails because `getGeneralSettings` etc. aren't mocked, add a `vi.mock` for the store module.

- [ ] **Step 6: Register the handler in the main IPC index**

Edit `apps/desktop/src/main/ipc/index.ts`. Find the `registerAllHandlers` function and add a line that calls `registerLocaleHandlers`. Pattern follows existing handlers; the signature requires the i18n instance and a menu-rebuild callback, which means the registration site needs to receive them.

If the existing pattern doesn't accept arguments, refactor minimally: have `registerAllHandlers(deps)` take a `{ i18n, rebuildMenu }` object. Update its single caller (in `apps/desktop/src/main/index.ts`).

Show the modified registration:

```ts
// apps/desktop/src/main/ipc/index.ts
import { registerLocaleHandlers, type RebuildMenuFn } from './locale-handler'
import type { I18nInstance } from '@memry/i18n/main'

interface IpcDeps {
  i18n: I18nInstance
  rebuildMenu: RebuildMenuFn
}

export function registerAllHandlers(deps: IpcDeps): void {
  // ...existing registrations remain unchanged...
  registerLocaleHandlers(deps.i18n, deps.rebuildMenu)
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/ipc/locale-handler.ts apps/desktop/src/main/ipc/locale-handler.test.ts apps/desktop/src/main/ipc/index.ts
git commit -m "feat(i18n): add main-process locale IPC handler"
```

---

## Task 15: Wire Main-Process Boot Sequence

The boot sequence: read settings → resolve locale → init i18n → build menu → register handlers → create window.

**Files:**
- Modify: `apps/desktop/src/main/index.ts` (boot integration around `app.whenReady()`)

- [ ] **Step 1: Find the existing `app.whenReady()` block**

```bash
grep -n "whenReady\|registerAllHandlers\|createWindow" apps/desktop/src/main/index.ts | head -20
```

Identify where:
- (a) settings are loaded
- (b) `registerAllHandlers` is called
- (c) the first BrowserWindow is created
- (d) the native menu is set (likely a `Menu.setApplicationMenu(...)` call somewhere)

- [ ] **Step 2: Add the i18n init before the menu and handler registration**

In `apps/desktop/src/main/index.ts`, in the `app.whenReady()` handler (or equivalent), add the i18n init. Approximate placement (adapt to actual order):

```ts
import { createMainI18n, type I18nInstance } from '@memry/i18n/main'
import { LocaleSchema, FALLBACK_LOCALE, type Locale } from '@memry/contracts/locale-api'
import { buildAppMenu } from './menu' // Task 16 creates this if it doesn't exist

let mainI18n: I18nInstance

async function bootI18n(): Promise<I18nInstance> {
  // Resolve initial locale from persisted settings.
  let initialLocale: Locale = FALLBACK_LOCALE
  try {
    const settings = await getGeneralSettings() // adjust to actual API
    const parsed = LocaleSchema.safeParse(settings.language)
    if (parsed.success) initialLocale = parsed.data
  } catch {
    // First launch or corrupt settings: fall back to 'en'.
  }

  return createMainI18n({ locale: initialLocale })
}

function rebuildMenu(locale: Locale): void {
  Menu.setApplicationMenu(buildAppMenu(mainI18n))
}

// Inside app.whenReady():
mainI18n = await bootI18n()
Menu.setApplicationMenu(buildAppMenu(mainI18n))
registerAllHandlers({ i18n: mainI18n, rebuildMenu })
// ...rest of existing boot (createWindow, etc.) follows...
```

The exact integration point depends on the existing structure. The key invariants:
- `bootI18n()` runs before `Menu.setApplicationMenu`
- `bootI18n()` runs before `registerAllHandlers`
- `mainI18n` is captured in module scope so `rebuildMenu` can read it

- [ ] **Step 3: Verify the app boots**

```bash
pnpm dev
```

Expected: app launches as before. The native menu still shows English labels (Task 16 makes the menu use `t()`).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(i18n): boot main-process i18n before menu/handlers"
```

---

## Task 16: Make the Native Menu Use `t()`

**Files:**
- Create or modify: `apps/desktop/src/main/menu.ts` (whichever pattern memry uses)

- [ ] **Step 1: Find the existing menu construction**

```bash
grep -rn "buildFromTemplate\|setApplicationMenu" apps/desktop/src/main/ | head -10
```

If memry has a dedicated `menu.ts` or builds the menu inline in `index.ts`, identify the exact location.

- [ ] **Step 2: Refactor menu construction to take an i18n instance**

If menu is currently inline in `index.ts`, extract to `apps/desktop/src/main/menu.ts`:

```ts
import { Menu, type MenuItemConstructorOptions, app } from 'electron'
import type { I18nInstance } from '@memry/i18n/main'

export function buildAppMenu(i18n: I18nInstance): Menu {
  const t = i18n.getFixedT(null, 'menu')

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ label: app.name, submenu: [{ role: 'quit' }] }]
      : []),
    {
      label: t('file.label'),
      submenu: [
        {
          label: t('file.newNote'),
          accelerator: 'CmdOrCtrl+N'
          // click handler retained from existing code
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: t('edit.label'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    },
    {
      label: t('view.label'),
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ]

  return Menu.buildFromTemplate(template as MenuItemConstructorOptions[])
}
```

**Important:** keep all existing menu items / accelerators / click handlers. The only change is wrapping user-visible labels in `t()`. Preserve the existing menu structure exactly — this task is *labels only*, not a menu refactor.

- [ ] **Step 3: Verify menu shows English on launch**

```bash
pnpm dev
```

Expected: menu reads "File", "Edit", "View" (English). No regression.

- [ ] **Step 4: Verify menu rebuilds when locale changes (manual smoke)**

In an Electron renderer console (DevTools):
```js
window.api.locale.set('tr')
```

(This will only work after Task 21 wires the preload bridge. Skip this step for now and re-run after Task 21.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/menu.ts apps/desktop/src/main/index.ts
git commit -m "feat(i18n): localize native Electron menu via t()"
```

---

## Task 17: Implement Renderer i18next Instance

**Files:**
- Create: `packages/i18n/src/renderer/index.ts`
- Create: `packages/i18n/src/renderer/index.test.ts`

- [ ] **Step 1: Write the test**

`packages/i18n/src/renderer/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createRendererI18n } from './index'

describe('createRendererI18n', () => {
  it('initializes with the requested locale', async () => {
    const i18n = await createRendererI18n({ locale: 'tr' })
    expect(i18n.language).toBe('tr')
  })

  it('translates a settings string', async () => {
    const i18n = await createRendererI18n({ locale: 'tr' })
    expect(i18n.t('settings:general.language.label')).toBe('Dil')
  })

  it('changeLanguage works', async () => {
    const i18n = await createRendererI18n({ locale: 'en' })
    await i18n.changeLanguage('ar')
    expect(i18n.language).toBe('ar')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @memry/i18n test renderer/index
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `renderer/index.ts`**

```ts
import i18next, { type i18n as I18nInstance } from 'i18next'
import ICU from 'i18next-icu'
import { initReactI18next } from 'react-i18next'
import { type Locale, FALLBACK_LOCALE, I18N_NAMESPACES, DEFAULT_NAMESPACE } from '../shared/config'
import { RESOURCES } from '../locales'

interface CreateRendererI18nOptions {
  locale: Locale
}

/**
 * Creates an i18next instance for the renderer (browser context).
 *
 * Resources are bundled eagerly into the renderer JS bundle. For Phase A
 * with three locales × eight tiny namespaces, the size cost is trivial
 * (under 10KB gzipped). When string volume grows, swap to lazy loading
 * via i18next-resources-to-backend with namespace splitting.
 */
export async function createRendererI18n(
  options: CreateRendererI18nOptions
): Promise<I18nInstance> {
  const instance = i18next.createInstance()
  await instance
    .use(ICU)
    .use(initReactI18next)
    .init({
      lng: options.locale,
      fallbackLng: FALLBACK_LOCALE,
      ns: I18N_NAMESPACES,
      defaultNS: DEFAULT_NAMESPACE,
      resources: RESOURCES,
      interpolation: { escapeValue: false }, // React already escapes
      react: { useSuspense: false } // we boot before mounting <App/>
    })
  return instance
}

export type { I18nInstance }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @memry/i18n test renderer/index
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/src/renderer/index.ts packages/i18n/src/renderer/index.test.ts
git commit -m "feat(i18n): add renderer-process i18next instance factory"
```

---

## Task 18: Implement `<I18nProvider>` Component

**Files:**
- Create: `packages/i18n/src/renderer/provider.tsx`

- [ ] **Step 1: Implement the provider**

```tsx
import { I18nextProvider } from 'react-i18next'
import type { ReactNode } from 'react'
import type { I18nInstance } from './index'

interface I18nProviderProps {
  i18n: I18nInstance
  children: ReactNode
}

export function I18nProvider({ i18n, children }: I18nProviderProps): JSX.Element {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add packages/i18n/src/renderer/provider.tsx
git commit -m "feat(i18n): add <I18nProvider> wrapper"
```

---

## Task 19: Implement `useT` and `useDirection` Hooks

**Files:**
- Create: `packages/i18n/src/renderer/use-t.ts`
- Create: `packages/i18n/src/renderer/use-direction.ts`
- Create: `packages/i18n/src/renderer/index-exports.ts` (barrel for renderer)

- [ ] **Step 1: Implement `use-t.ts`**

```ts
import { useTranslation } from 'react-i18next'
import type { I18nNamespace } from '../shared/config'

/**
 * Strongly-typed translation hook bound to a specific namespace.
 *
 * Usage:
 *   const { t } = useT('inbox')
 *   t('triage.archive')   // checked against en/inbox.json via type augmentation
 */
export function useT(namespace: I18nNamespace) {
  return useTranslation(namespace)
}
```

- [ ] **Step 2: Implement `use-direction.ts`**

```ts
import { useTranslation } from 'react-i18next'
import { localeDirection } from '../shared/direction'

/**
 * React hook returning the current document direction. Re-renders when
 * the active locale changes via i18next's change event.
 */
export function useDirection(): 'ltr' | 'rtl' {
  const { i18n } = useTranslation()
  return localeDirection(i18n.language)
}
```

- [ ] **Step 3: Update `packages/i18n/src/renderer/index.ts` to also export hooks and provider**

Append to the existing `renderer/index.ts`:

```ts
export { I18nProvider } from './provider'
export { useT } from './use-t'
export { useDirection } from './use-direction'
```

(`createRendererI18n` and `I18nInstance` already exported.)

- [ ] **Step 4: Run typecheck**

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/src/renderer/
git commit -m "feat(i18n): add useT and useDirection hooks"
```

---

## Task 20: Implement `applyLocaleToDocument` Helper

**Files:**
- Create: `packages/i18n/src/renderer/apply-document-attrs.ts`

- [ ] **Step 1: Implement**

```ts
import { localeDirection } from '../shared/direction'
import type { Locale } from '../shared/config'

/**
 * Sets <html lang> and <html dir> based on the active locale. Runs once
 * at boot and once per locale change. The DOM is the source of truth
 * for direction; CSS reads it via [dir="rtl"] selectors.
 */
export function applyLocaleToDocument(locale: Locale): void {
  const html = document.documentElement
  html.setAttribute('lang', locale)
  html.setAttribute('dir', localeDirection(locale))
}
```

- [ ] **Step 2: Add to renderer barrel**

Append to `packages/i18n/src/renderer/index.ts`:

```ts
export { applyLocaleToDocument } from './apply-document-attrs'
```

- [ ] **Step 3: Commit**

```bash
git add packages/i18n/src/renderer/apply-document-attrs.ts packages/i18n/src/renderer/index.ts
git commit -m "feat(i18n): add applyLocaleToDocument helper"
```

---

## Task 21: Wire Renderer Boot + Preload Bridge

**Files:**
- Modify: `apps/desktop/src/preload/index.ts` (or wherever preload exposes APIs)
- Modify: `apps/desktop/src/preload/index.d.ts`
- Modify: `apps/desktop/src/renderer/src/main.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx` (apply doc attrs on mount)

- [ ] **Step 1: Find the preload entry**

```bash
ls apps/desktop/src/preload/
cat apps/desktop/src/preload/index.ts | head -40
```

Note how `window.api` is constructed (likely via `contextBridge.exposeInMainWorld`).

- [ ] **Step 2: Add the locale bridge to preload**

In `apps/desktop/src/preload/index.ts`, inside the `api` object exposed via `contextBridge.exposeInMainWorld('api', api)` (or equivalent), add:

```ts
import { LocaleChannels } from '@memry/contracts/ipc-channels'
import type { Locale, LocaleApi } from '@memry/contracts/locale-api'

const localeApi: LocaleApi = {
  get: () => ipcRenderer.invoke(LocaleChannels.Get),
  set: (locale: Locale) => ipcRenderer.invoke(LocaleChannels.Set, locale),
  list: () => ipcRenderer.invoke(LocaleChannels.List)
}

// Expose:
const api = {
  // ...existing api members...
  locale: localeApi,
  onLocaleChanged: (callback: (locale: Locale) => void) => {
    const listener = (_event: unknown, locale: Locale) => callback(locale)
    ipcRenderer.on(LocaleChannels.Changed, listener)
    return () => ipcRenderer.removeListener(LocaleChannels.Changed, listener)
  }
}
```

- [ ] **Step 3: Update preload type declaration**

Edit `apps/desktop/src/preload/index.d.ts`. In the `Api` interface (or equivalent), add:

```ts
locale: LocaleApi
onLocaleChanged: (callback: (locale: Locale) => void) => () => void
```

Add the import at the top:
```ts
import type { Locale, LocaleApi } from '@memry/contracts/locale-api'
```

- [ ] **Step 4: Run `ipc:check` and `ipc:generate` if needed**

```bash
pnpm ipc:check
```

If it complains about missing entries in the IPC invoke map, run:

```bash
pnpm ipc:generate
pnpm ipc:check
```

- [ ] **Step 5: Wire the renderer boot in `main.tsx`**

Edit `apps/desktop/src/renderer/src/main.tsx`. Replace the existing render with an async boot:

```tsx
import { createRoot } from 'react-dom/client'
import {
  createRendererI18n,
  I18nProvider,
  applyLocaleToDocument
} from '@memry/i18n/renderer'
import App from './App'
import './assets/main.css' // or whatever CSS entry exists

async function boot(): Promise<void> {
  const initialLocale = await window.api.locale.get()
  const i18n = await createRendererI18n({ locale: initialLocale })
  applyLocaleToDocument(initialLocale)

  // Subscribe to runtime locale changes broadcast from main.
  window.api.onLocaleChanged(async (locale) => {
    await i18n.changeLanguage(locale)
    applyLocaleToDocument(locale)
  })

  const root = createRoot(document.getElementById('root')!)
  root.render(
    <I18nProvider i18n={i18n}>
      <App />
    </I18nProvider>
  )
}

void boot()
```

If `main.tsx` currently has additional providers wrapping `<App/>`, preserve them. Adapt the JSX to match (keep the existing tree, just wrap with `<I18nProvider>` outside).

- [ ] **Step 6: Run typecheck**

```bash
pnpm typecheck:desktop
```

Expected: passes.

- [ ] **Step 7: Smoke-test boot**

```bash
pnpm dev
```

Expected: app boots normally. UI looks identical (no strings migrated). DevTools console: `document.documentElement.dir` returns `'ltr'`, `document.documentElement.lang` returns `'en'`.

Manual test in DevTools:
```js
await window.api.locale.set('ar')
```

Expected: `<html dir>` becomes `'rtl'`, `<html lang>` becomes `'ar'`. Native menu rebuilds in Arabic. App tree re-renders (mostly unchanged since no strings migrated).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/preload/ apps/desktop/src/renderer/src/main.tsx
git commit -m "feat(i18n): wire renderer i18n boot and preload bridge"
```

---

## Task 22: Add `mirror-rtl` Global Tailwind Class

**Files:**
- Modify: `apps/desktop/src/renderer/src/assets/main.css` (or wherever the global stylesheet is)

- [ ] **Step 1: Find the global stylesheet**

```bash
grep -l "@tailwind\|@import.*tailwind" apps/desktop/src/renderer/ -r | head -3
```

- [ ] **Step 2: Append the mirror utility**

At the end of the global stylesheet (after Tailwind directives):

```css
/* RTL icon mirroring — opt-in via .mirror-rtl class.
   Most icons should NOT mirror in RTL (clocks, settings, magnifier).
   Direction-pointing icons (chevrons, arrows, breadcrumbs) opt in. */
[dir="rtl"] .mirror-rtl {
  transform: scaleX(-1);
}
```

- [ ] **Step 3: Verify build still works**

```bash
pnpm dev
```

Expected: app boots, no CSS errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/assets/main.css
git commit -m "feat(i18n): add .mirror-rtl utility for opt-in icon flipping"
```

---

## Task 23: Build the Settings Language Picker

The settings UI gets a `<Select>` for language. The component lives next to the existing `clockFormat` field in the General section.

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/settings/general-section.tsx`
- Create: `apps/desktop/src/renderer/src/pages/settings/general-section.test.tsx` if not present, else extend it

- [ ] **Step 1: Read the existing general-section to understand the pattern**

```bash
cat apps/desktop/src/renderer/src/pages/settings/general-section.tsx | head -80
```

Note the existing `<Select>` for `clockFormat` — copy its pattern.

- [ ] **Step 2: Add the language field**

Inside the General section component, alongside the existing settings fields:

```tsx
import { useT } from '@memry/i18n/renderer'
import { LOCALE_DISPLAY_NAMES, SUPPORTED_LOCALES } from '@memry/i18n/shared'
import { type Locale } from '@memry/contracts/locale-api'
import { useState } from 'react'
import { toast } from '@/lib/toast' // adapt to memry's toast import

// ...inside the component...
const { t, i18n } = useT('settings')
const [isChanging, setIsChanging] = useState(false)

async function handleLocaleChange(value: Locale): Promise<void> {
  setIsChanging(true)
  try {
    await window.api.locale.set(value)
    toast.success(
      t('general.language.changed', { nativeName: LOCALE_DISPLAY_NAMES[value] })
    )
  } catch (err) {
    toast.error(t('general.language.changeFailed', 'Failed to change language'))
  } finally {
    setIsChanging(false)
  }
}

// In the JSX:
<div className="settings-row">
  <label htmlFor="language-select">{t('general.language.label')}</label>
  <Select
    value={i18n.language as Locale}
    onValueChange={handleLocaleChange}
    disabled={isChanging}
  >
    <SelectTrigger id="language-select">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {SUPPORTED_LOCALES.map((loc) => (
        <SelectItem key={loc} value={loc}>
          {LOCALE_DISPLAY_NAMES[loc]}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
  <p className="settings-helper-text">{t('general.language.helper')}</p>
</div>
```

The `Select` component import path matches whatever shadcn/ui pattern memry already uses elsewhere in `general-section.tsx`. Match the existing import paths and class names — don't introduce new conventions.

- [ ] **Step 3: Run desktop typecheck**

```bash
pnpm typecheck:desktop
```

Expected: passes.

- [ ] **Step 4: Run dev and manually test**

```bash
pnpm dev
```

Open Settings → General. Language picker should:
- Show three options with native script: "English", "Türkçe", "العربية"
- Default to current locale (English)
- Switch on selection: app re-renders, native menu rebuilds, `<html dir>` flips for Arabic, toast appears in the new language

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/general-section.tsx
git commit -m "feat(i18n): add language picker to settings General section"
```

---

## Task 24: Add `extractErrorMessage` Pass-Through for Translation Keys

The existing `extractErrorMessage(err, fallback)` can optionally translate error keys when the error message is a known i18n key starting with `errors:`.

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/ipc-error.ts`

- [ ] **Step 1: Read existing implementation**

```bash
cat apps/desktop/src/renderer/src/lib/ipc-error.ts
```

- [ ] **Step 2: Extend with translation lookup**

Add (preserving existing behavior — translation is a *bonus* path, not a replacement):

```ts
import i18next from 'i18next'

const I18N_KEY_PREFIX = 'errors:'

export function extractErrorMessage(err: unknown, fallback: string): string {
  // ...existing extraction logic returns a `raw` string...
  const raw = /* existing logic */ ''

  if (raw.startsWith(I18N_KEY_PREFIX)) {
    const translated = i18next.t(raw)
    if (translated !== raw) return translated
  }

  return raw || fallback
}
```

The exact insertion point depends on the existing function structure. Pattern: after the raw extraction, before returning, attempt translation if the string looks like an i18n key. Errors that don't use the prefix flow through unchanged.

This is a Phase A *enabler* — Phase B–E migrations can start emitting `errors:sync.network-failed` style messages and have them translate automatically. For Phase A, no errors actually use this yet.

- [ ] **Step 3: Run desktop tests**

```bash
pnpm --filter @memry/desktop test ipc-error
```

Expected: existing tests pass. Add a new test for the translation path:

```ts
it('translates errors-prefixed messages via i18next', () => {
  // Init i18next inline for the test (or use the global instance)
  // For brevity, this test verifies pass-through behavior unchanged for non-prefix.
  const result = extractErrorMessage(new Error('plain error'), 'fallback')
  expect(result).toBe('plain error')
})
```

(A full test of the i18next path requires setting up a test i18n instance; consider deferring to Phase B when an actual translated error key exists.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/ipc-error.ts
git commit -m "feat(i18n): allow extractErrorMessage to resolve i18n keys"
```

---

## Task 25: Add `i18n.spec.ts` Playwright E2E

Three scenarios per the spec: live switch, RTL applied, native menu rebuild.

**Files:**
- Create: `apps/desktop/tests/e2e/i18n.spec.ts`

- [ ] **Step 1: Find the existing E2E pattern**

```bash
ls apps/desktop/tests/e2e/
cat apps/desktop/tests/e2e/utils/electron-helpers.ts | head -40
```

Note: per memry's MEMORY.md, E2E tests run against the **built bundle** (`out/main/index.js`), not source. Need to rebuild before running.

- [ ] **Step 2: Build the desktop app**

```bash
pnpm --filter @memry/desktop build
```

Expected: build succeeds, `out/main/index.js` exists.

- [ ] **Step 3: Write the E2E spec**

`apps/desktop/tests/e2e/i18n.spec.ts`:

```ts
import { test, expect, _electron as electron } from '@playwright/test'
import { launchApp, openSettings } from './utils/electron-helpers' // adapt to actual helpers

test.describe('i18n', () => {
  test('switches language live', async () => {
    const { app, page } = await launchApp()
    await openSettings(page)

    // Pick Türkçe via the language select
    await page.locator('#language-select').click()
    await page.locator('[role="option"][data-value="tr"]').click()

    // The Settings header (or any known string) should now be Turkish.
    await expect(page.getByText('Dil')).toBeVisible()

    // Toast confirms the change in Turkish.
    await expect(page.getByText(/Dil .* olarak değiştirildi/)).toBeVisible()

    await app.close()
  })

  test('applies dir="rtl" for Arabic', async () => {
    const { app, page } = await launchApp()
    await openSettings(page)

    await page.locator('#language-select').click()
    await page.locator('[role="option"][data-value="ar"]').click()

    const dir = await page.locator('html').getAttribute('dir')
    expect(dir).toBe('rtl')

    const lang = await page.locator('html').getAttribute('lang')
    expect(lang).toBe('ar')

    await app.close()
  })

  test('rebuilds native menu in new language', async () => {
    const { app, page } = await launchApp()
    await openSettings(page)

    await page.locator('#language-select').click()
    await page.locator('[role="option"][data-value="tr"]').click()
    await page.waitForTimeout(200) // give the menu rebuild a tick

    const menuLabels = await app.evaluate(({ Menu }) => {
      return Menu.getApplicationMenu()?.items.map((i) => i.label) ?? []
    })

    expect(menuLabels).toContain('Dosya') // Turkish for "File"

    await app.close()
  })
})
```

The `launchApp` and `openSettings` helpers may not exist with those exact names — adapt to whatever utilities `apps/desktop/tests/e2e/utils/electron-helpers.ts` exports. The selectors (`#language-select`, `[role="option"]`) match the picker structure from Task 23 — adjust if shadcn's Select renders different attributes.

- [ ] **Step 4: Run the E2E**

```bash
pnpm --filter @memry/desktop test:e2e i18n
```

Expected: 3 tests pass. If they fail, debug per memry's E2E patterns (rebuild the bundle, check `out/` is fresh).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/tests/e2e/i18n.spec.ts
git commit -m "test(i18n): e2e — live switch, RTL, native menu rebuild"
```

---

## Task 26: Add `docs/i18n-adding-a-locale.md`

Acceptance criterion from the spec: "documented checklist for adding language number 4."

**Files:**
- Create: `docs/i18n-adding-a-locale.md`

- [ ] **Step 1: Write the doc**

```markdown
# Adding a New Locale to memry

This is the checklist to add language number 4 (or any subsequent language) to memry's i18n system.

## 1. Update the Locale enum

Edit `packages/contracts/src/locale-api.ts`:

```ts
export const LocaleSchema = z.enum(['en', 'tr', 'ar', 'es']) // added 'es'
\`\`\`

## 2. Update the supported locales config

Edit `packages/i18n/src/shared/config.ts`:

```ts
export const SUPPORTED_LOCALES = ['en', 'tr', 'ar', 'es'] as const
export const LOCALE_DISPLAY_NAMES: Record<Locale, string> = {
  en: 'English',
  tr: 'Türkçe',
  ar: 'العربية',
  es: 'Español' // added — native script, never translated
}
\`\`\`

## 3. Create the locale resource directory

```bash
mkdir packages/i18n/src/locales/es
for ns in common inbox notes journal calendar settings errors menu; do
  echo '{}' > packages/i18n/src/locales/es/$ns.json
done
\`\`\`

## 4. Update the resources barrel

Edit `packages/i18n/src/locales/index.ts`. Add imports for each `es/*.json` file and a top-level `es:` block in the `RESOURCES` constant matching the shape of `en:` / `tr:` / `ar:`.

## 5. Translate strings

Populate the JSON files with translations. You can leave a file as `{}` if you don't have translations yet — i18next falls back to English automatically.

## 6. Verify

```bash
pnpm --filter @memry/i18n typecheck
pnpm --filter @memry/desktop typecheck
pnpm --filter @memry/desktop test:e2e i18n
\`\`\`

## 7. Commit

```bash
git commit -m "feat(i18n): add Spanish locale"
\`\`\`

The new language now appears in the Settings → General → Language picker automatically.
```

- [ ] **Step 2: Commit**

```bash
git add docs/i18n-adding-a-locale.md
git commit -m "docs(i18n): add 'adding a locale' checklist"
```

---

## Task 27: Update `CLAUDE.md` with Tailwind Logical-Class Rule

The spec mandates new code uses logical Tailwind classes (`ms-*`, `me-*`, etc.). Without a written rule, this won't stick.

**Files:**
- Modify: `CLAUDE.md` (project root)

- [ ] **Step 1: Find the Code Style section**

```bash
grep -n "Code Style\|## Style\|Prettier" CLAUDE.md | head -5
```

- [ ] **Step 2: Add the rule**

Append to the Code Style section:

```markdown
- **Tailwind logical properties (RTL safety)**: New code uses logical classes that flip automatically in RTL. Reject `ml-*` / `mr-*` (use `ms-*` / `me-*`), `pl-*` / `pr-*` (use `ps-*` / `pe-*`), `left-*` / `right-*` (use `start-*` / `end-*`), `text-left` / `text-right` (use `text-start` / `text-end`), `border-l` / `border-r` (use `border-s` / `border-e`), `rounded-l-*` / `rounded-r-*` (use `rounded-s-*` / `rounded-e-*`). Pre-existing files using physical classes are exempt (codemod is a future enhancement).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(i18n): add Tailwind logical-property rule to CLAUDE.md"
```

---

## Task 28: Final Verification — All Checks Pass

**Files:** none modified

- [ ] **Step 1: Lint**

```bash
pnpm lint
```

Expected: passes.

- [ ] **Step 2: Typecheck (full workspace)**

```bash
pnpm typecheck
```

Expected: passes (modulo memry's known pre-existing test-file errors per MEMORY.md).

- [ ] **Step 3: IPC contract check**

```bash
pnpm ipc:check
```

Expected: passes.

- [ ] **Step 4: Unit + integration tests**

```bash
pnpm test
```

Expected: all packages green, including new tests in `@memry/i18n` and `@memry/desktop`.

- [ ] **Step 5: E2E**

```bash
pnpm --filter @memry/desktop build
pnpm --filter @memry/desktop test:e2e
```

Expected: passes including new `i18n.spec.ts`.

- [ ] **Step 6: Manual smoke test**

```bash
pnpm dev
```

Verify in the running app:
- App launches in English
- Settings → General → Language picker shows three options
- Switching to Türkçe: settings UI flips to Turkish, native menu shows "Dosya"
- Switching to العربية: `<html dir="rtl">` applied, layout mirrors (where logical classes apply), menu rebuilds in Arabic
- Restart app: locale persists

- [ ] **Step 7: Open the PR**

```bash
git push -u origin feature/i18n-phase-a
gh pr create --title "feat(i18n): Phase A — infrastructure" --body "$(cat <<'EOF'
## Summary

Ships the i18n infrastructure for memry:

- New `@memry/i18n` shared package wrapping `react-i18next` + `i18next-icu`
- Main and renderer i18next instances with synchronous main-process boot
- Tightens `GeneralSettings.language` from loose string to strict enum (`en` | `tr` | `ar`)
- New `LocaleApi` IPC surface for atomic locale changes (persist + apply + broadcast)
- Native Electron menu rebuilds in the new language
- Document direction (`<html dir>`) flips for RTL locales via `Intl.Locale.textInfo`
- `mirror-rtl` Tailwind utility for opt-in icon flipping
- Settings → General → Language picker

**Zero existing UI strings migrated.** Phase B–E plans cover the migration of the ~939 renderer files and the lint gate. See `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`.

## Test plan

- [ ] Lint passes
- [ ] Typecheck passes
- [ ] All unit tests pass
- [ ] `pnpm ipc:check` passes
- [ ] E2E `i18n.spec.ts` passes (live switch, RTL, menu rebuild)
- [ ] Manual: switch to Turkish → menu shows "Dosya"
- [ ] Manual: switch to Arabic → `<html dir="rtl">` applied
- [ ] Manual: restart app → locale persists
EOF
)"
```

---

## Phase B–E Handoff

After Phase A merges, future plans live at:

- `docs/superpowers/plans/<date>-i18n-phase-b-common-namespace.md` — migrate the ~50 universal strings (Save, Cancel, OK, Loading, Search, etc.) and translate to TR + AR
- `docs/superpowers/plans/<date>-i18n-phase-c-{settings,inbox,notes,...}.md` — one plan per feature
- `docs/superpowers/plans/<date>-i18n-phase-d-main-process.md` — error strings + native menu items beyond what Phase A seeded
- `docs/superpowers/plans/<date>-i18n-phase-e-codemod-and-lint.md` — the ESLint rule, `pnpm i18n:check` script, and codemod sweep

Each phase follows the same TDD-per-task structure as this plan. Each ships a working, mergeable app.
