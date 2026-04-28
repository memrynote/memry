# Task 23: Build the Settings → General → Language picker

> **Plan:** Task 23 (Build the Settings Language Picker)
> **Depends on:** Task 21 (preload bridge available, hooks usable)
> **Dependents:** Task 25 (E2E test interacts with this picker)

## Pre-flight check

```bash
pwd                                                                                 # ../memry-i18n-phase-a
git status                                                                          # clean
cat apps/desktop/src/renderer/src/pages/settings/general-section.tsx | head -80   # see existing pattern
grep -n "Select\|<Select" apps/desktop/src/renderer/src/pages/settings/general-section.tsx | head -5
grep -rn "import.*toast\|from.*['\"]sonner['\"]\|from.*['\"]@/lib/toast" apps/desktop/src/renderer/src/pages/settings/ | head -5
```

The grep tells you which Select primitive memry uses (likely shadcn `<Select>` from `@/components/ui/select`) and which toast library (likely `sonner`).

## Your job

Add a `<Select>` for `Language` to the General section, alongside the existing `clockFormat` field. The picker:

- Shows three options with native script names: `English` / `Türkçe` / `العربية`
- Defaults to current `i18n.language`
- On change: calls `window.api.locale.set(value)` → toast on success/failure
- Has a static helper text below: `t('general.language.helper')`

## Steps

1. **Read the existing `general-section.tsx`** to understand the row/select pattern memry uses for `clockFormat`. Match it.

2. **Add imports** at the top of `apps/desktop/src/renderer/src/pages/settings/general-section.tsx`:

```tsx
import { useT } from '@memry/i18n/renderer'
import { LOCALE_DISPLAY_NAMES, SUPPORTED_LOCALES } from '@memry/i18n/shared'
import { type Locale } from '@memry/contracts/locale-api'
import { useState } from 'react'
// import { toast } from <whatever path memry uses, from your grep>
```

3. **Inside the component**, add the picker state and handler:

```tsx
const { t, i18n } = useT('settings')
const [isChanging, setIsChanging] = useState(false)

async function handleLocaleChange(value: Locale): Promise<void> {
  setIsChanging(true)
  try {
    await window.api.locale.set(value)
    toast.success(
      t('general.language.changed', { nativeName: LOCALE_DISPLAY_NAMES[value] })
    )
  } catch {
    toast.error('Failed to change language. Please try again.')
  } finally {
    setIsChanging(false)
  }
}
```

4. **Add the JSX** wherever existing settings rows are rendered (next to `clockFormat`):

```tsx
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

**Match memry's actual class names** for `settings-row`, `settings-helper-text` — the existing `clockFormat` row will show you the right ones. Don't introduce new conventions; mirror what's there.

5. **Run desktop typecheck**:

```bash
pnpm typecheck:desktop
```

Expected: passes.

6. **Manual test**:

```bash
pnpm dev
```

Open Settings → General. Verify:

- Language picker shows three options: "English", "Türkçe", "العربية"
- Default selection: "English"
- Switch to Türkçe → Settings UI labels in that section flip to Turkish, native menu rebuilds (File → Dosya), toast appears in Turkish
- Switch to العربية → `<html dir="rtl">`, layout flips, native menu rebuilds, toast in Arabic
- Switch back to English → everything reverts
- Restart `pnpm dev` — selected locale persists

Stop dev (Ctrl+C).

7. **Commit**:

```bash
git add apps/desktop/src/renderer/src/pages/settings/general-section.tsx
git commit -m "feat(i18n): add language picker to settings General section"
```

## Exit criteria

- [ ] Picker renders with three options and native script names
- [ ] Default selection shows current locale
- [ ] Switching languages causes: settings text flip, menu rebuild, `<html dir>` flip for RTL, success toast in new language
- [ ] Locale persists across restart
- [ ] Typecheck passes
- [ ] One commit

## Skills to use

- **`superpowers:verification-before-completion`** — manually test all language switches before claiming done

## Report back

```
✅ Task 23 complete.
Commit SHA: <abbrev>
Manual test:
  - Picker shows: English, Türkçe, العربية
  - Switch to Türkçe: settings UI flipped, menu = Dosya, toast = Turkish
  - Switch to ar: html dir=rtl, layout flipped, menu in Arabic, toast in Arabic
  - Restart: persisted locale loaded
typecheck:desktop: passes
Next: Task 24 (extractErrorMessage translation pass-through)
```
