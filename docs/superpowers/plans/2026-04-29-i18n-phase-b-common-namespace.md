# i18n Phase B — Common Namespace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `common.json` with ~50 universal strings (button verbs, state labels, ICU-pluralized counts), translate to TR + AR, then migrate a representative subset of renderer files so that switching to Turkish/Arabic in the running app shows visible non-English UI beyond the settings picker that Phase A seeded. End-to-end live switching is validated against real user-facing strings.

**Architecture:** No new packages, no new IPC, no new Electron main-process work. Phase B is purely **content + migration** on top of Phase A's plumbing: it extends `packages/i18n/src/locales/{en,tr,ar}/common.json`, exercises `i18next-icu` pluralization for the first time, and rewrites JSX text in ~10 files from raw English to `t('common:…')` calls. The migration set is chosen to cover four representative shapes: simple verb (Cancel), composite verb-with-count (Delete N items), purely informational state (Loading…), and ARIA labels (`aria-label="Search"`).

**Tech Stack:** TypeScript, React 19, `react-i18next` v15+ (already installed in Phase A), `i18next-icu` (already installed in Phase A), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`

**Depends on:** Phase A merged — `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md`. If Phase A is not yet on `main`, rebase this branch onto Phase A's branch and treat this plan as the second of a two-PR stack.

**Out of scope (deferred to Phase C–E plans):**
- Feature-specific strings: inbox titles, note editor chrome, calendar event labels, journal headings, settings panels beyond the language picker — those each get their own Phase C namespace plan.
- Error message strings (Phase D, `errors.json`).
- Native-menu strings beyond the seed Phase A added (Phase D, `menu.json`).
- The `pnpm i18n:check` AST script and ESLint rule that block PRs introducing untranslated strings (Phase E).
- The `jscodeshift` codemod that rewrites pre-existing physical Tailwind classes to logical (deferred enhancement).
- Bidi-correct rendering inside the BlockNote editor (known-issue list, not v1).

**Translation sourcing:** Per the spec, Turkish translations are reviewed by the project owner (native Turkish speaker). Arabic translations are seeded in this plan via Claude/DeepL at a reasonable level — they ship as a *good-enough proof of concept*; a native Arabic speaker review is a content task, not infra, and is tracked separately. Untranslated keys fall back to English automatically; nothing breaks if an AR string is wrong.

---

## Worktree Setup

Per memry's MEMORY.md: *"implement plan changes in git worktrees, not directly on current branch."*

- [ ] **Step 1: Create worktree off `main`**

```bash
git worktree add ../memry-i18n-phase-b -b feature/i18n-phase-b
cd ../memry-i18n-phase-b
```

Expected: worktree on a fresh branch off `main`, with Phase A already merged in.

- [ ] **Step 2: Verify Phase A is present**

```bash
ls packages/i18n/src/shared/config.ts
ls packages/i18n/src/renderer/use-t.ts
ls apps/desktop/src/main/ipc/locale-handler.ts
ls apps/desktop/tests/e2e/i18n.spec.ts
```

Expected: all four files exist. If any is missing, Phase A is not on `main` yet — stop and rebase onto the Phase A branch before continuing.

- [ ] **Step 3: Install + smoke-test the Phase A pipeline**

```bash
pnpm install
pnpm dev
```

In the running app: open Settings → General → Language. Switch to Türkçe and back to English. The picker label and the toast should flip. The native menu should rebuild (File → Dosya). If this doesn't work, Phase A has a regression — fix that first; do not start Phase B on a broken base.

- [ ] **Step 4: Commit (no changes — just verifying base)**

```bash
git status
```

Expected: working tree clean.

---

## Task 1: Expand English `common.json` with the Universal Vocabulary

**Files:**
- Modify: `packages/i18n/src/locales/en/common.json`

This is purely additive. Phase A seeded `button.{save, cancel, close}`. Phase B keeps those and adds the rest.

- [ ] **Step 1: Replace the file content**

Overwrite `packages/i18n/src/locales/en/common.json` with:

```json
{
  "button": {
    "save": "Save",
    "cancel": "Cancel",
    "close": "Close",
    "ok": "OK",
    "yes": "Yes",
    "no": "No",
    "delete": "Delete",
    "confirm": "Confirm",
    "apply": "Apply",
    "done": "Done",
    "discard": "Discard",
    "edit": "Edit",
    "add": "Add",
    "remove": "Remove",
    "retry": "Retry",
    "submit": "Submit",
    "back": "Back",
    "next": "Next",
    "continue": "Continue",
    "reset": "Reset",
    "copy": "Copy",
    "paste": "Paste",
    "create": "Create",
    "open": "Open"
  },
  "state": {
    "loading": "Loading…",
    "saving": "Saving…",
    "deleting": "Deleting…",
    "searching": "Searching…",
    "error": "Error",
    "success": "Success"
  },
  "empty": {
    "noResults": "No results",
    "noItems": "No items",
    "noMatch": "No matches"
  },
  "action": {
    "search": "Search",
    "edit": "Edit",
    "delete": "Delete",
    "close": "Close"
  },
  "count": {
    "item": "{count, plural, one {# item} other {# items}}",
    "note": "{count, plural, one {# note} other {# notes}}",
    "folder": "{count, plural, one {# folder} other {# folders}}",
    "task": "{count, plural, one {# task} other {# tasks}}",
    "project": "{count, plural, one {# project} other {# projects}}"
  }
}
```

Notes on the shape:
- `button.*` = literal label appearing on a clickable element. Imperative/verb form.
- `state.*` = transient indicator text. Includes ellipsis (Unicode `…`, not three dots) for visual consistency with macOS conventions.
- `empty.*` = zero-state messages.
- `action.*` = labels used in `aria-label` / `title` attributes (no visible text but read by AT). Often duplicates `button.*`, but separated so translators can choose register (e.g., "Search" as a button label vs. as an a11y label).
- `count.*` = ICU plural keys. The `#` token is replaced with the actual count by `i18next-icu`. Two CLDR plural categories for English: `one` and `other`.

- [ ] **Step 2: Verify TypeScript picks up the new keys**

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes. The type augmentation in `packages/i18n/src/shared/types.ts` reads from these JSONs, so autocomplete on `t('common:…')` now sees `button.delete`, `count.item`, etc.

- [ ] **Step 3: Run existing i18n tests to ensure nothing regresses**

```bash
pnpm --filter @memry/i18n test
```

Expected: all Phase A tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/i18n/src/locales/en/common.json
git commit -m "feat(i18n): expand en/common.json with universal vocabulary"
```

---

## Task 2: Translate `common.json` to Turkish

**Files:**
- Modify: `packages/i18n/src/locales/tr/common.json`

- [ ] **Step 1: Replace the file content**

Overwrite `packages/i18n/src/locales/tr/common.json` with:

```json
{
  "button": {
    "save": "Kaydet",
    "cancel": "İptal",
    "close": "Kapat",
    "ok": "Tamam",
    "yes": "Evet",
    "no": "Hayır",
    "delete": "Sil",
    "confirm": "Onayla",
    "apply": "Uygula",
    "done": "Tamam",
    "discard": "Vazgeç",
    "edit": "Düzenle",
    "add": "Ekle",
    "remove": "Kaldır",
    "retry": "Yeniden dene",
    "submit": "Gönder",
    "back": "Geri",
    "next": "İleri",
    "continue": "Devam et",
    "reset": "Sıfırla",
    "copy": "Kopyala",
    "paste": "Yapıştır",
    "create": "Oluştur",
    "open": "Aç"
  },
  "state": {
    "loading": "Yükleniyor…",
    "saving": "Kaydediliyor…",
    "deleting": "Siliniyor…",
    "searching": "Aranıyor…",
    "error": "Hata",
    "success": "Başarılı"
  },
  "empty": {
    "noResults": "Sonuç bulunamadı",
    "noItems": "Öğe yok",
    "noMatch": "Eşleşme bulunamadı"
  },
  "action": {
    "search": "Ara",
    "edit": "Düzenle",
    "delete": "Sil",
    "close": "Kapat"
  },
  "count": {
    "item": "{count, plural, one {# öğe} other {# öğe}}",
    "note": "{count, plural, one {# not} other {# not}}",
    "folder": "{count, plural, one {# klasör} other {# klasör}}",
    "task": "{count, plural, one {# görev} other {# görev}}",
    "project": "{count, plural, one {# proje} other {# proje}}"
  }
}
```

Translation notes:
- Turkish has **no plural suffix** when a number precedes the noun ("5 öğe", not "5 öğeler"). Both `one` and `other` ICU plural forms are therefore the same word — but ICU still requires both keys to be defined; `i18next-icu` will pick `one` for n=1 and `other` for n≠1, both producing the same output. This is correct.
- `İptal` is the universally-used Turkish for the Cancel button (literally "cancellation"). `İptal et` ("cancel it") is the verb form but `İptal` alone is the convention on UI buttons.
- `Tamam` doubles as both "OK" and "Done" in Turkish UI conventions; that's intentional — it's not a translation slip.
- `Vazgeç` ("give up") is the natural fit for "Discard" in dialog context (discarding unsaved changes).

- [ ] **Step 2: Verify file is valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/tr/common.json', 'utf8'))" && echo OK
```

Expected: prints `OK`. (Catches mismatched braces, bad escapes.)

- [ ] **Step 3: Commit**

```bash
git add packages/i18n/src/locales/tr/common.json
git commit -m "feat(i18n): translate common namespace to Turkish"
```

---

## Task 3: Translate `common.json` to Arabic

**Files:**
- Modify: `packages/i18n/src/locales/ar/common.json`

- [ ] **Step 1: Replace the file content**

Overwrite `packages/i18n/src/locales/ar/common.json` with:

```json
{
  "button": {
    "save": "حفظ",
    "cancel": "إلغاء",
    "close": "إغلاق",
    "ok": "موافق",
    "yes": "نعم",
    "no": "لا",
    "delete": "حذف",
    "confirm": "تأكيد",
    "apply": "تطبيق",
    "done": "تم",
    "discard": "تجاهل",
    "edit": "تعديل",
    "add": "إضافة",
    "remove": "إزالة",
    "retry": "إعادة المحاولة",
    "submit": "إرسال",
    "back": "رجوع",
    "next": "التالي",
    "continue": "متابعة",
    "reset": "إعادة تعيين",
    "copy": "نسخ",
    "paste": "لصق",
    "create": "إنشاء",
    "open": "فتح"
  },
  "state": {
    "loading": "جارٍ التحميل…",
    "saving": "جارٍ الحفظ…",
    "deleting": "جارٍ الحذف…",
    "searching": "جارٍ البحث…",
    "error": "خطأ",
    "success": "نجح"
  },
  "empty": {
    "noResults": "لا توجد نتائج",
    "noItems": "لا توجد عناصر",
    "noMatch": "لا توجد مطابقات"
  },
  "action": {
    "search": "بحث",
    "edit": "تعديل",
    "delete": "حذف",
    "close": "إغلاق"
  },
  "count": {
    "item": "{count, plural, zero {لا توجد عناصر} one {عنصر واحد} two {عنصران} few {# عناصر} many {# عنصراً} other {# عنصر}}",
    "note": "{count, plural, zero {لا توجد ملاحظات} one {ملاحظة واحدة} two {ملاحظتان} few {# ملاحظات} many {# ملاحظة} other {# ملاحظة}}",
    "folder": "{count, plural, zero {لا توجد مجلدات} one {مجلد واحد} two {مجلدان} few {# مجلدات} many {# مجلداً} other {# مجلد}}",
    "task": "{count, plural, zero {لا توجد مهام} one {مهمة واحدة} two {مهمتان} few {# مهام} many {# مهمة} other {# مهمة}}",
    "project": "{count, plural, zero {لا توجد مشاريع} one {مشروع واحد} two {مشروعان} few {# مشاريع} many {# مشروعاً} other {# مشروع}}"
  }
}
```

Translation notes:
- Arabic CLDR has six plural categories: `zero`, `one`, `two`, `few`, `many`, `other`. ICU/`Intl.PluralRules` picks the right one automatically based on the count value.
- These translations are seeded for *infrastructure validation*, not native-speaker quality. A follow-up content task (tracked separately, not in this plan) will have a native speaker refine the morphology and dialect choice (MSA vs. Levantine vs. Gulf).
- The dialog `dir="rtl"` flip from Phase A handles bidirectional layout; the strings here render correctly in both LTR contexts (mixed text) and RTL contexts (full Arabic UI).

- [ ] **Step 2: Verify file is valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/ar/common.json', 'utf8'))" && echo OK
```

Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
git add packages/i18n/src/locales/ar/common.json
git commit -m "feat(i18n): translate common namespace to Arabic"
```

---

## Task 4: Verify ICU Pluralization Works in All Three Locales (TDD)

This is the first time `i18next-icu` is exercised by real plural keys. Add a unit test that verifies the plural selection works correctly across en/tr/ar.

**Files:**
- Create: `packages/i18n/src/shared/icu-plural.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/i18n/src/shared/icu-plural.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createMainI18n } from '../main'

describe('ICU pluralization', () => {
  describe('English', () => {
    it('uses "one" form for count=1', async () => {
      const i18n = await createMainI18n({ locale: 'en' })
      expect(i18n.t('common:count.item', { count: 1 })).toBe('1 item')
    })

    it('uses "other" form for count=0', async () => {
      const i18n = await createMainI18n({ locale: 'en' })
      expect(i18n.t('common:count.item', { count: 0 })).toBe('0 items')
    })

    it('uses "other" form for count=5', async () => {
      const i18n = await createMainI18n({ locale: 'en' })
      expect(i18n.t('common:count.note', { count: 5 })).toBe('5 notes')
    })
  })

  describe('Turkish', () => {
    it('produces same output for one and other (no plural -s in Turkish)', async () => {
      const i18n = await createMainI18n({ locale: 'tr' })
      expect(i18n.t('common:count.item', { count: 1 })).toBe('1 öğe')
      expect(i18n.t('common:count.item', { count: 5 })).toBe('5 öğe')
    })

    it('translates note correctly', async () => {
      const i18n = await createMainI18n({ locale: 'tr' })
      expect(i18n.t('common:count.note', { count: 3 })).toBe('3 not')
    })
  })

  describe('Arabic', () => {
    it('uses zero form for count=0', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      expect(i18n.t('common:count.item', { count: 0 })).toBe('لا توجد عناصر')
    })

    it('uses one form for count=1', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      expect(i18n.t('common:count.item', { count: 1 })).toBe('عنصر واحد')
    })

    it('uses two form for count=2', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      expect(i18n.t('common:count.item', { count: 2 })).toBe('عنصران')
    })

    it('uses few form for count=3', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      // few = 3-10 in Arabic CLDR
      expect(i18n.t('common:count.item', { count: 5 })).toBe('5 عناصر')
    })

    it('uses many form for count=11', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      // many = 11-99 in Arabic CLDR
      expect(i18n.t('common:count.item', { count: 11 })).toBe('11 عنصراً')
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails (or passes — the keys exist now)**

```bash
pnpm --filter @memry/i18n test icu-plural
```

Expected: the tests should PASS now, because Tasks 1–3 already added the plural keys and the i18next-icu plugin is wired by Phase A. If they fail, debug:
- If "key not found", verify the JSON syntax in en/tr/ar common.json.
- If "expected '5 items' got '{count} items'" — the ICU plugin isn't being applied; check that `createMainI18n` calls `.use(ICU)` (it should from Phase A Task 9).
- If Arabic plural categories don't match — verify `Intl.PluralRules.prototype.select` works as expected via a quick `node -e "console.log(new Intl.PluralRules('ar').select(11))"` (should print `'many'`).

- [ ] **Step 3: Commit**

```bash
git add packages/i18n/src/shared/icu-plural.test.ts
git commit -m "test(i18n): verify ICU pluralization across en/tr/ar"
```

---

## Task 5: Migrate `tabs/unsaved-changes-dialog.tsx`

The simplest possible migration shape: three universal buttons, no plurals, no count. Validates that `useT('common')` returns translated strings and re-renders on `changeLanguage`.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/tabs/unsaved-changes-dialog.tsx`
- Modify: existing test if present (search for it first)

- [ ] **Step 1: Read the existing component**

```bash
cat apps/desktop/src/renderer/src/components/tabs/unsaved-changes-dialog.tsx
```

Identify the three button labels: `Save`, `Discard`, `Cancel` (or similar). Note the imports and the props.

- [ ] **Step 2: Add the `useT` import and replace the strings**

Edit `apps/desktop/src/renderer/src/components/tabs/unsaved-changes-dialog.tsx`. Add at the top with the other React imports:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside the component function (above the `return`):

```ts
const { t } = useT('common')
```

Replace the literal strings in JSX:

| Before | After |
|---|---|
| `>Save<` | `>{t('button.save')}<` |
| `>Discard<` | `>{t('button.discard')}<` |
| `>Cancel<` | `>{t('button.cancel')}<` |

The exact JSX shape depends on the component — likely uses `<AlertDialogAction>`, `<AlertDialogCancel>`, and a custom button. Match the existing structure; only the *visible label* changes.

**Do NOT translate the dialog title or description** in this task — those are likely feature-specific copy ("Unsaved changes", "You have unsaved changes in this tab. Save before closing?") and belong to a Phase C tabs/feature plan. This task is **buttons only**.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck:web
```

Expected: passes. If it fails with "Property 'button.discard' does not exist", verify `discard` is in `packages/i18n/src/locales/en/common.json` from Task 1.

- [ ] **Step 4: Run unit tests for this component (if any exist)**

```bash
pnpm --filter @memry/desktop test unsaved-changes-dialog
```

Expected: passes. If existing tests assert text like `expect(screen.getByText('Save'))`, they still pass because the default locale is English. If a test asserts an exact string that's no longer literal (e.g., snapshot tests), update the assertion.

- [ ] **Step 5: Smoke-test in the running app**

```bash
pnpm dev
```

Trigger the dialog (open a note, modify, attempt to close the tab). Confirm:
- Buttons read "Save", "Discard", "Cancel" in English. ✅
- Switch language to Türkçe via Settings → re-trigger the dialog → buttons now read "Kaydet", "Vazgeç", "İptal". ✅

If the buttons don't flip on language switch, check that `useT` re-renders correctly. (Phase A's `useT` is just `useTranslation(namespace)`, and `react-i18next` subscribes the consuming component to language change events automatically.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tabs/unsaved-changes-dialog.tsx
git commit -m "feat(i18n): migrate unsaved-changes dialog buttons to common namespace"
```

---

## Task 6: Migrate `bulk/delete-confirmation-dialog.tsx` with ICU Plural

This is the first migration that exercises ICU pluralization end-to-end. The "Delete N item(s)" button expression becomes `t('common:count.item', {count})` plus the verb. Approach: keep the verb as a *separate* translation key so word order is locale-controlled.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/bulk/delete-confirmation-dialog.tsx`
- Modify: `packages/i18n/src/locales/en/common.json`, `tr/common.json`, `ar/common.json` — add a `count.itemDelete` ICU key

The body text ("These items will be removed from your inbox…") and the title ("Delete N items?") stay English in this task — they're feature-specific (inbox copy) and belong to Phase C inbox.

- [ ] **Step 1: Add `count.itemDelete` to all three common.json files**

This key wraps the verb *inside* the ICU pattern so each language can pick its own word order (e.g., German "X Elemente löschen" puts the verb at the end).

Add to `packages/i18n/src/locales/en/common.json`, inside the `count` object:

```json
"itemDelete": "{count, plural, one {Delete # item} other {Delete # items}}"
```

Add to `packages/i18n/src/locales/tr/common.json`, inside the `count` object:

```json
"itemDelete": "{count, plural, one {# öğeyi sil} other {# öğeyi sil}}"
```

(Turkish word order: object before verb. "Sil" = delete; "öğeyi" = the item, accusative case.)

Add to `packages/i18n/src/locales/ar/common.json`, inside the `count` object (Arabic uses VSO order — verb first):

```json
"itemDelete": "{count, plural, zero {حذف العناصر} one {حذف عنصر واحد} two {حذف عنصرين} few {حذف # عناصر} many {حذف # عنصراً} other {حذف # عنصر}}"
```

- [ ] **Step 2: Read the current component**

```bash
cat apps/desktop/src/renderer/src/components/bulk/delete-confirmation-dialog.tsx
```

Note the two strings to migrate:
- Line ~58: `Delete {itemCount} item{itemCount !== 1 ? 's' : ''}?` — *the title*; **leave it for Phase C inbox** (it's followed by a "?" which is locale-specific punctuation in some scripts; full migration deserves a feature pass)
- Line ~65: `<AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>` — migrate
- Line ~67: `Delete {itemCount} item{itemCount !== 1 ? 's' : ''}` — *the action button*; migrate via `t('common:count.itemDelete', {count: itemCount})`

This task migrates only the **action button label** (the cancel button and the delete button). The dialog title is untouched.

- [ ] **Step 3: Migrate the buttons**

Edit `apps/desktop/src/renderer/src/components/bulk/delete-confirmation-dialog.tsx`. Add the import:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside the component function, near the other hooks (above the `useEffect`):

```ts
const { t } = useT('common')
```

Replace the Cancel button:

```tsx
<AlertDialogCancel onClick={onCancel}>{t('button.cancel')}</AlertDialogCancel>
```

Replace the Delete action button label:

```tsx
<AlertDialogAction onClick={onConfirm} className="bg-red-500 text-white hover:bg-red-600">
  {t('count.itemDelete', { count: itemCount })}
</AlertDialogAction>
```

The `count.itemDelete` ICU key handles the entire "Delete N items" composition — the engineer never concatenates "Delete" + count manually.

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck:web
```

Expected: passes.

- [ ] **Step 5: Add a component-level test for the ICU plural**

Create or extend `apps/desktop/src/renderer/src/components/bulk/delete-confirmation-dialog.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, beforeAll } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { DeleteConfirmationDialog } from './delete-confirmation-dialog'

describe('DeleteConfirmationDialog (i18n)', () => {
  let i18nEn: I18nInstance
  let i18nTr: I18nInstance

  beforeAll(async () => {
    i18nEn = await createRendererI18n({ locale: 'en' })
    i18nTr = await createRendererI18n({ locale: 'tr' })
  })

  it('renders English Cancel + "Delete 5 items" for itemCount=5', () => {
    render(
      <I18nextProvider i18n={i18nEn}>
        <DeleteConfirmationDialog
          isOpen={true}
          itemCount={5}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </I18nextProvider>
    )
    expect(screen.getByText('Cancel')).toBeInTheDocument()
    expect(screen.getByText('Delete 5 items')).toBeInTheDocument()
  })

  it('renders English "Delete 1 item" (singular) for itemCount=1', () => {
    render(
      <I18nextProvider i18n={i18nEn}>
        <DeleteConfirmationDialog
          isOpen={true}
          itemCount={1}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </I18nextProvider>
    )
    expect(screen.getByText('Delete 1 item')).toBeInTheDocument()
  })

  it('renders Turkish "İptal" + "5 öğeyi sil" when locale is tr', () => {
    render(
      <I18nextProvider i18n={i18nTr}>
        <DeleteConfirmationDialog
          isOpen={true}
          itemCount={5}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </I18nextProvider>
    )
    expect(screen.getByText('İptal')).toBeInTheDocument()
    expect(screen.getByText('5 öğeyi sil')).toBeInTheDocument()
  })
})
```

If `@testing-library/react` isn't already a dev dependency on `apps/desktop`, install it:

```bash
pnpm --filter @memry/desktop add -D @testing-library/react @testing-library/jest-dom
```

(Search the existing tree first — memry likely already uses Testing Library since several `*.test.tsx` files exist.)

- [ ] **Step 6: Run the new test**

```bash
pnpm --filter @memry/desktop test delete-confirmation-dialog
```

Expected: 3 tests pass. If the test renders zero buttons (because the dialog is conditionally hidden), verify the `isOpen` prop is set and that AlertDialog from Radix actually renders content when `isOpen=true` in the testing-library jsdom environment. Some Radix components portal to `document.body` — Testing Library's `screen.getByText` queries the whole document, so this works.

- [ ] **Step 7: Commit**

```bash
git add packages/i18n/src/locales/en/common.json packages/i18n/src/locales/tr/common.json packages/i18n/src/locales/ar/common.json apps/desktop/src/renderer/src/components/bulk/delete-confirmation-dialog.tsx apps/desktop/src/renderer/src/components/bulk/delete-confirmation-dialog.test.tsx
git commit -m "feat(i18n): migrate bulk delete dialog buttons + ICU itemDelete key"
```

---

## Task 7: Migrate `note-tree-dialogs.tsx` Cancel Button

The note-tree delete dialog has multiple internal feature-specific strings (folder vs. note vs. mixed). Those stay English. Only the universal Cancel button is migrated.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/note-tree-dialogs.tsx`

- [ ] **Step 1: Open the file**

```bash
head -80 apps/desktop/src/renderer/src/components/note-tree-dialogs.tsx
```

Locate the `<AlertDialogCancel>Cancel</AlertDialogCancel>` line (around line 57).

- [ ] **Step 2: Migrate**

Add the import at the top:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside the `NoteTreeDeleteDialog` component (and any other component in this file that has a Cancel button — `head` showed at least one), add:

```ts
const { t } = useT('common')
```

Replace `<AlertDialogCancel>Cancel</AlertDialogCancel>` with `<AlertDialogCancel>{t('button.cancel')}</AlertDialogCancel>`.

**Do NOT migrate** the title (`Delete Folder`, `Delete Note`, `Delete N Items`), the body text, or the deleting-state spinner label (`Deleting...`) — those are tree-feature-specific and go in Phase C notes namespace. Cancel is the only universal-vocabulary string.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck:web
```

Expected: passes.

- [ ] **Step 4: Smoke-test**

```bash
pnpm dev
```

In the app, trigger the note-tree delete dialog (right-click a folder or note → Delete). Switch locale to Türkçe → reopen the dialog. Verify "Cancel" → "İptal".

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note-tree-dialogs.tsx
git commit -m "feat(i18n): migrate note-tree delete dialog Cancel button"
```

---

## Task 8: Migrate `tasks/delete-task-dialog.tsx` Cancel Button

Same pattern as Task 7. Cancel-only.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/tasks/delete-task-dialog.tsx`

- [ ] **Step 1: Locate the Cancel button**

```bash
grep -n "Cancel\|AlertDialogCancel" apps/desktop/src/renderer/src/components/tasks/delete-task-dialog.tsx
```

- [ ] **Step 2: Migrate**

Add the import:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside the component, add:

```ts
const { t } = useT('common')
```

Replace the Cancel button text with `{t('button.cancel')}`.

**Do NOT migrate** the title, body, or feature-specific buttons (`Delete task`, `Delete recurring task`) — those go in Phase C tasks.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck:web
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tasks/delete-task-dialog.tsx
git commit -m "feat(i18n): migrate task delete dialog Cancel button"
```

---

## Task 9: Migrate `calendar/delete-calendar-event-dialog.tsx` Cancel Button

Same pattern. Cancel-only.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/calendar/delete-calendar-event-dialog.tsx`

- [ ] **Step 1: Locate the Cancel button**

```bash
grep -n "Cancel\|AlertDialogCancel" apps/desktop/src/renderer/src/components/calendar/delete-calendar-event-dialog.tsx
```

- [ ] **Step 2: Migrate**

Add the `useT` import + `const { t } = useT('common')` inside the component. Replace the Cancel button label with `{t('button.cancel')}`.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck:web
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/delete-calendar-event-dialog.tsx
git commit -m "feat(i18n): migrate calendar delete dialog Cancel button"
```

---

## Task 10: Migrate "Loading…" States in Folder View

Folder view tables show a `Loading...` placeholder while data fetches. The string is universal.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/folder-view/folder-table-view.tsx` (line ~971)
- Modify: `apps/desktop/src/renderer/src/components/folder-view/grouped-table.tsx` (line ~992)

- [ ] **Step 1: Identify the exact JSX in folder-table-view.tsx**

```bash
grep -n "Loading\.\.\." apps/desktop/src/renderer/src/components/folder-view/folder-table-view.tsx
```

Expected: one match around line 971 — `<div className="text-muted-foreground">Loading...</div>`.

- [ ] **Step 2: Migrate folder-table-view.tsx**

Add the import:

```ts
import { useT } from '@memry/i18n/renderer'
```

In the component function (the one rendering the loading state), add `const { t } = useT('common')`. Replace `>Loading...<` with `>{t('state.loading')}<`.

- [ ] **Step 3: Migrate grouped-table.tsx**

```bash
grep -n "Loading\.\.\." apps/desktop/src/renderer/src/components/folder-view/grouped-table.tsx
```

Same edit: add `useT` import, `const { t } = useT('common')`, replace `Loading...` with `{t('state.loading')}`.

**Note on the ellipsis character:** the source has three ASCII dots `...`. The translation uses Unicode ellipsis `…` (single character). React renders both correctly, but mixing creates inconsistency. The migrated string uses whatever is in `state.loading` — which is `…` per Task 1. This is intentional (macOS HIG convention), and acceptable visual drift from the original `...` on the legacy English text.

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck:web
```

Expected: passes.

- [ ] **Step 5: Smoke-test**

```bash
pnpm dev
```

Open a folder view that triggers a loading state (e.g., create a large folder, scroll to a virtualized chunk). Verify `Loading…` appears, then switch to Türkçe and re-trigger; verify `Yükleniyor…` appears.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/folder-view/folder-table-view.tsx apps/desktop/src/renderer/src/components/folder-view/grouped-table.tsx
git commit -m "feat(i18n): migrate folder-view Loading state to common namespace"
```

---

## Task 11: Migrate "Loading…" States in Settings Section

Settings panels show their own loading placeholders. Migrate these for additional coverage of the language picker → settings UI path.

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/settings/account-section.tsx` (line ~93)
- Modify: `apps/desktop/src/renderer/src/pages/settings/ai-inline-section.tsx` (line ~144)
- Modify: `apps/desktop/src/renderer/src/components/settings/recovery-key-dialog.tsx` (line ~78)

- [ ] **Step 1: Migrate account-section.tsx**

```bash
grep -n "Loading\.\.\." apps/desktop/src/renderer/src/pages/settings/account-section.tsx
```

The match shows: `<SettingsHeader title="Account" subtitle="Loading..." />`.

Add the import + `const { t } = useT('common')` inside the component. Replace `subtitle="Loading..."` with `subtitle={t('state.loading')}`.

**Note:** the `title="Account"` prop is feature-specific (settings/account namespace) — leave it for Phase C settings.

- [ ] **Step 2: Migrate ai-inline-section.tsx**

```bash
grep -n "Loading\.\.\." apps/desktop/src/renderer/src/pages/settings/ai-inline-section.tsx
```

The match: `<p className="text-xs/4 text-muted-foreground">Loading...</p>`.

Same edit pattern: add import + hook + replace literal with `{t('state.loading')}`.

- [ ] **Step 3: Migrate recovery-key-dialog.tsx**

```bash
grep -n "Loading\.\.\." apps/desktop/src/renderer/src/components/settings/recovery-key-dialog.tsx
```

The match: `<p className="text-sm text-muted-foreground">Loading...</p>`.

Same edit pattern.

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck:web
```

Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/account-section.tsx apps/desktop/src/renderer/src/pages/settings/ai-inline-section.tsx apps/desktop/src/renderer/src/components/settings/recovery-key-dialog.tsx
git commit -m "feat(i18n): migrate settings Loading states to common namespace"
```

---

## Task 12: Migrate `aria-label="Search"` Instances

Two known places use a literal `aria-label="Search"`. Screen readers should hear the localized term.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-toolbar.tsx` (line ~116)
- Modify: `apps/desktop/src/renderer/src/components/window-controls.tsx` (line ~39)

- [ ] **Step 1: Migrate calendar-toolbar.tsx**

```bash
grep -n 'aria-label="Search"' apps/desktop/src/renderer/src/components/calendar/calendar-toolbar.tsx
```

Add the import:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside the component:

```ts
const { t } = useT('common')
```

Replace `aria-label="Search"` with `aria-label={t('action.search')}`.

- [ ] **Step 2: Migrate window-controls.tsx**

Same pattern. Add the import, the hook, and replace `aria-label="Search"` with `aria-label={t('action.search')}`.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck:web
```

Expected: passes.

- [ ] **Step 4: Smoke-test in DevTools**

```bash
pnpm dev
```

In the running app:
- Open DevTools → Elements
- Find the search button (calendar toolbar or window control)
- Inspect: `aria-label` should read "Search"
- Switch locale to Türkçe → re-inspect → `aria-label` should now read "Ara"

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-toolbar.tsx apps/desktop/src/renderer/src/components/window-controls.tsx
git commit -m "feat(i18n): migrate aria-label='Search' to common.action.search"
```

---

## Task 13: Migrate "N notes" Pluralization in `column-selector.tsx`

The column selector subtitle uses ad-hoc pluralization (`note${count !== 1 ? 's' : ''}`) — a perfect ICU plural target.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/folder-view/column-selector.tsx` (line ~207)

- [ ] **Step 1: Identify the exact line**

```bash
grep -n 'note\${' apps/desktop/src/renderer/src/components/folder-view/column-selector.tsx
```

Expected match around line 207:

```ts
subtitle: `${prop.usageCount} note${prop.usageCount !== 1 ? 's' : ''}`,
```

- [ ] **Step 2: Migrate**

Add the import + hook (or reuse if `useT` already imported earlier in the file):

```ts
import { useT } from '@memry/i18n/renderer'
// ...
const { t } = useT('common')
```

Replace the template-literal subtitle with:

```ts
subtitle: t('count.note', { count: prop.usageCount }),
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck:web
```

Expected: passes. The `count: prop.usageCount` argument matches the ICU `{count, plural, ...}` parameter named `count`.

- [ ] **Step 4: Smoke-test**

```bash
pnpm dev
```

Open Folder view → Column selector. Subtitles should read "5 notes", "1 note", "0 notes" depending on usage count. Switch to Türkçe → re-open → "5 not", "1 not" (Turkish has no plural-s; both forms are the same word — that's correct, not a bug). Switch to Arabic → re-open → "5 ملاحظات", "ملاحظة واحدة", etc.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/folder-view/column-selector.tsx
git commit -m "feat(i18n): migrate column-selector usage count to ICU plural"
```

---

## Task 14: Extend Phase A's `i18n.spec.ts` E2E with Visible-Flip Assertion

Phase A's e2e verifies the picker label flips and the native menu rebuilds. Phase B adds a scenario asserting that a *real* renderer-process button (Cancel in a delete dialog) flips, proving the user-facing migration works in production-builds.

**Files:**
- Modify: `apps/desktop/tests/e2e/i18n.spec.ts`

- [ ] **Step 1: Read the existing spec**

```bash
cat apps/desktop/tests/e2e/i18n.spec.ts
```

Note the existing three tests (live switch, RTL, native menu rebuild) and the helpers (`launchApp`, `openSettings`).

- [ ] **Step 2: Add the new scenario**

Append a new test inside the existing `test.describe('i18n', () => { ... })` block:

```ts
test('migrated common-namespace strings flip in renderer UI', async () => {
  const { app, page } = await launchApp()

  // 1. Switch to Turkish via the language picker.
  await openSettings(page)
  await page.locator('#language-select').click()
  await page.locator('[role="option"][data-value="tr"]').click()
  await page.waitForTimeout(200)

  // 2. Trigger a delete-confirmation dialog. The simplest path is:
  //    select inbox items, press Delete via keyboard. Adjust to whatever
  //    the actual app flow is; what matters is that the bulk delete dialog opens.
  await page.keyboard.press('Escape') // close settings modal first
  // Navigate to inbox (adjust selector to memry's actual sidebar item)
  await page.locator('[data-testid="sidebar"] >> text=Inbox').first().click()
  // If there are no items to select, this scenario can be skipped — the test
  // at minimum proves the test-helper structure works. For now, assert on
  // *any* migrated string visible in the Settings modal itself:

  await openSettings(page)

  // The Cancel button on the settings close action (or Save button in any tab)
  // should now read in Turkish.
  // Find a known migrated button — easiest is to re-open settings and verify
  // that any button label is the Turkish version. The picker's helper text
  // and label are settings-specific (Phase A) — they always flip.
  // To assert specifically Phase B's common-namespace work, look for
  // anything visible in the dialog footer that uses a common button.

  // Pragmatic approach: open the unsaved-changes dialog instead (Task 5
  // migrated it). Trigger by editing a note and trying to close.

  // For maximum reliability, just assert the document direction reset
  // and the picker label flipped — proven proxies for the runtime change.
  const lang = await page.locator('html').getAttribute('lang')
  expect(lang).toBe('tr')

  // And assert one common.* string appears somewhere visible.
  // The "İptal" Cancel button on Settings close (if memry's settings has one)
  // or in any open dialog.
  // Fallback: query all buttons with text "İptal" and expect at least one.
  const cancelButtons = page.locator('button', { hasText: 'İptal' })
  await expect(cancelButtons.first()).toBeVisible({ timeout: 5000 })

  await app.close()
})
```

This test uses a *forgiving* assertion: it locates any button reading "İptal" anywhere in the rendered document. As Phase B migrates more `<AlertDialogCancel>` instances and the settings modal opens, at least one such button is reliably visible.

If memry's settings modal does **not** have a visible Cancel button at idle (the modal might use only the Esc key or close-X), then trigger one of the migrated dialogs explicitly:
- Open a note (any note), tweak it, attempt to close the tab → unsaved-changes dialog opens → the Cancel button reads "İptal".

Adjust the test to match what's reliably reachable in the test environment.

- [ ] **Step 3: Build and run the e2e**

```bash
pnpm --filter @memry/desktop build
pnpm --filter @memry/desktop test:e2e i18n
```

Expected: 4 tests pass (3 from Phase A + 1 new). If the new test fails because the Cancel button isn't reachable, refactor the test to navigate to a flow that *guarantees* a `<AlertDialogCancel>` is on screen post-migration.

Per memry's MEMORY.md, e2e runs against the **built bundle** in `out/`, so always rebuild after source edits.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/tests/e2e/i18n.spec.ts
git commit -m "test(i18n): assert migrated common buttons flip in Turkish e2e"
```

---

## Task 15: Final Verification — All Checks Pass

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

If `pnpm ipc:check` is part of the typecheck pipeline and fails on flaky pre-existing issues unrelated to Phase B, fall back to `pnpm typecheck:node && pnpm typecheck:web` per the MEMORY.md note about typecheck hook gotchas.

- [ ] **Step 3: IPC contract check**

```bash
pnpm ipc:check
```

Expected: passes. Phase B added zero new IPC surface, so this is just regression coverage.

- [ ] **Step 4: Unit + integration tests**

```bash
pnpm test
```

Expected: all packages green. The new tests:
- `packages/i18n/src/shared/icu-plural.test.ts`
- `apps/desktop/src/renderer/src/components/bulk/delete-confirmation-dialog.test.tsx`

…plus all Phase A tests still passing.

- [ ] **Step 5: E2E**

```bash
pnpm --filter @memry/desktop build
pnpm --filter @memry/desktop test:e2e
```

Expected: passes including the extended `i18n.spec.ts` (4 scenarios).

- [ ] **Step 6: Manual smoke test — full flip across the migration set**

```bash
pnpm dev
```

Walk through every migrated location and confirm Turkish renders correctly. Checklist:

- [ ] Settings → General → Language: switch to Türkçe.
- [ ] Try to close a tab with unsaved edits → dialog buttons read "Kaydet", "Vazgeç", "İptal".
- [ ] Bulk-select items in Inbox → press Delete → dialog buttons read "İptal" and "5 öğeyi sil".
- [ ] Right-click a folder in the sidebar → Delete → dialog Cancel button reads "İptal".
- [ ] Right-click a task → Delete → dialog Cancel button reads "İptal".
- [ ] Right-click a calendar event → Delete → dialog Cancel button reads "İptal".
- [ ] Open a folder view that triggers loading → placeholder reads "Yükleniyor…".
- [ ] Open Settings → Account: subtitle reads "Yükleniyor…" while loading.
- [ ] Open the calendar toolbar's Search → DevTools shows `aria-label="Ara"`.
- [ ] Open Folder view's Column selector → row subtitles read "5 not" instead of "5 notes".

Then switch to Arabic:

- [ ] All of the above flip to the Arabic translations from `ar/common.json`.
- [ ] `<html dir="rtl">` is set; layout flips for components using logical Tailwind classes.
- [ ] Cancel buttons read "إلغاء"; Loading reads "جارٍ التحميل…"; counts use Arabic plural categories.

- [ ] **Step 7: Open the PR**

```bash
git push -u origin feature/i18n-phase-b
gh pr create --title "feat(i18n): Phase B — common namespace + migrations" --body "$(cat <<'EOF'
## Summary

Builds on the Phase A infrastructure by:

- Expanding `packages/i18n/src/locales/{en,tr,ar}/common.json` with ~50 universal strings — button verbs, state labels, empty-state text, ARIA action labels, and ICU-pluralized counts.
- Migrating ~12 renderer files to use the new keys via `useT('common')`. Targets cover four representative shapes:
  - Simple verb buttons (Cancel, Save, Discard) in unsaved-changes / delete-confirmation dialogs.
  - ICU-pluralized verb-with-count (`Delete N items`).
  - State labels (`Loading…`) in folder view and settings panels.
  - ARIA labels (`aria-label="Search"`) in calendar toolbar and window controls.
  - Pure plural counts (`N notes` in column-selector subtitles).
- First real exercise of `i18next-icu` pluralization, with a unit-test matrix covering English (`one`/`other`), Turkish (no plural -s), and Arabic (six CLDR categories).
- Extended e2e (`i18n.spec.ts`) asserts that migrated renderer-process strings flip live, not just the settings picker label.

Phase B is the proof-of-concept for end-to-end live language switching: switching to Türkçe in the running app now visibly affects renderer UI beyond the settings panel itself. Untranslated keys still fall back to English per Phase A's plumbing — nothing breaks.

**Out of scope:** feature-specific copy (titles like "Delete folder", inbox-zero text, note-editor chrome) — those land in Phase C per-feature plans. Error and main-process strings land in Phase D. The `pnpm i18n:check` lint gate lands in Phase E.

## Test plan

- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm ipc:check` passes
- [ ] `pnpm test` passes (new ICU plural test + new dialog component test)
- [ ] `pnpm test:e2e` passes including extended `i18n.spec.ts` (4 scenarios)
- [ ] Manual: switch to Türkçe → bulk delete dialog shows "İptal" + "5 öğeyi sil"
- [ ] Manual: switch to Türkçe → unsaved-changes dialog shows "Kaydet" / "Vazgeç" / "İptal"
- [ ] Manual: switch to Arabic → Loading reads "جارٍ التحميل…", `<html dir="rtl">`
- [ ] Manual: switch to Arabic → ICU plural picks correct category (1 → "عنصر واحد", 2 → "عنصران", 11 → "11 عنصراً")

## Translation review

- Turkish strings reviewed by Kaan (project owner, native speaker).
- Arabic strings seeded by Claude/DeepL at infra-validation quality. A native-speaker review is tracked separately as a content task; until then, untranslated nuance is acceptable for the v1 architecture ship.
EOF
)"
```

---

## Phase C–E Handoff

After Phase B merges, future plans live at:

- `docs/superpowers/plans/<date>-i18n-phase-c-settings.md` — full settings UI (every panel, not just the language picker)
- `docs/superpowers/plans/<date>-i18n-phase-c-inbox.md` — inbox feature strings (titles, empty states, action labels beyond Cancel)
- `docs/superpowers/plans/<date>-i18n-phase-c-notes.md` — note editor chrome, note-tree titles and bodies
- `docs/superpowers/plans/<date>-i18n-phase-c-calendar.md`, `-journal.md`, `-tasks.md`, `-graph.md` — one per feature folder, runs in parallel
- `docs/superpowers/plans/<date>-i18n-phase-d-main-process.md` — `errors.json` migration, full native menu (`menu.json` beyond Phase A's File / Edit / View seed)
- `docs/superpowers/plans/<date>-i18n-phase-e-codemod-and-lint.md` — `pnpm i18n:check` AST script, ESLint rule rejecting JSX text literals, codemod to wrap straggler strings with `// TODO(i18n): wrap in t()`

Each Phase C plan **does NOT** add new keys to `common.json` unless the string is genuinely universal across multiple features. The temptation is to dump everything into common; resist. Feature-specific keys go in feature namespaces.

Each phase follows the same TDD-per-task structure as this plan. Each ships a working, mergeable app — partial migration is fine because the i18next fallback chain transparently uses English for unmigrated strings.
