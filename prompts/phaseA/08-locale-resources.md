# Task 08: Seed locale resource JSONs (en/tr/ar) + resources barrel

> **Plan:** Task 7 (Seed Locale Resource JSONs)
> **Depends on:** Task 07 (shared barrel exists)
> **Dependents:** Tasks 06 (types augmentation references these), 09, 10, 17 (i18next instances load them)

## Pre-flight check

```bash
pwd                                       # ../memry-i18n-phase-a
git status                                # clean
ls packages/i18n/src/locales/             # see en/ tr/ ar/ directories from Task 01
```

## Your job

Populate eight JSON files per locale (`common`, `inbox`, `notes`, `journal`, `calendar`, `settings`, `errors`, `menu`). For Phase A we only need *seed strings* in `common`, `settings`, and `menu` — those are exercised by the picker and the E2E test. The rest are `{}` (i18next falls back to English automatically). Then add a `locales/index.ts` barrel that exports a typed `RESOURCES` constant.

## Steps

1. **English `common.json`** — `packages/i18n/src/locales/en/common.json`:

```json
{
  "button": {
    "save": "Save",
    "cancel": "Cancel",
    "close": "Close"
  }
}
```

2. **English `settings.json`** — `packages/i18n/src/locales/en/settings.json`:

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

3. **English `menu.json`** — `packages/i18n/src/locales/en/menu.json`:

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

4. **Empty English JSONs** — for the remaining five namespaces:

```bash
echo '{}' > packages/i18n/src/locales/en/inbox.json
echo '{}' > packages/i18n/src/locales/en/notes.json
echo '{}' > packages/i18n/src/locales/en/journal.json
echo '{}' > packages/i18n/src/locales/en/calendar.json
echo '{}' > packages/i18n/src/locales/en/errors.json
```

5. **Turkish `common.json`**:

```json
{
  "button": {
    "save": "Kaydet",
    "cancel": "İptal",
    "close": "Kapat"
  }
}
```

6. **Turkish `settings.json`**:

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

7. **Turkish `menu.json`**:

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

8. **Empty Turkish JSONs**:

```bash
echo '{}' > packages/i18n/src/locales/tr/inbox.json
echo '{}' > packages/i18n/src/locales/tr/notes.json
echo '{}' > packages/i18n/src/locales/tr/journal.json
echo '{}' > packages/i18n/src/locales/tr/calendar.json
echo '{}' > packages/i18n/src/locales/tr/errors.json
```

9. **Arabic `common.json`**:

```json
{
  "button": {
    "save": "حفظ",
    "cancel": "إلغاء",
    "close": "إغلاق"
  }
}
```

10. **Arabic `settings.json`**:

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

11. **Arabic `menu.json`**:

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

12. **Empty Arabic JSONs**:

```bash
echo '{}' > packages/i18n/src/locales/ar/inbox.json
echo '{}' > packages/i18n/src/locales/ar/notes.json
echo '{}' > packages/i18n/src/locales/ar/journal.json
echo '{}' > packages/i18n/src/locales/ar/calendar.json
echo '{}' > packages/i18n/src/locales/ar/errors.json
```

13. **Resources barrel** — `packages/i18n/src/locales/index.ts`:

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

14. **Run typecheck on the i18n package** — should now pass:

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes. The JSON imports in `types.ts` and `locales/index.ts` resolve.

15. Commit:

```bash
git add packages/i18n/src/locales/
git commit -m "feat(i18n): seed locale JSONs for en/tr/ar and resources barrel"
```

## Exit criteria

- [ ] All 24 locale JSON files exist (3 locales × 8 namespaces)
- [ ] `common`, `settings`, `menu` populated in en/tr/ar; other 5 namespaces are `{}`
- [ ] `locales/index.ts` barrel exports `RESOURCES`
- [ ] `pnpm --filter @memry/i18n typecheck` passes
- [ ] One commit created

## Skills to use

None — content authoring + barrel.

## Report back

```
✅ Task 08 complete.
Commit SHA: <abbrev>
Files: 24 locale JSONs + locales/index.ts
typecheck (i18n package): passes
Next: Task 09 (load-resources, TDD)
```
