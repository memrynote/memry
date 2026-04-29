# Task 03: Translate `common.json` to Arabic

> **Plan:** Task 3 (Translate `common.json` to Arabic)
> **Depends on:** Task 01 (en vocabulary defined)
> **Dependents:** Task 04 (ICU plural test verifies all six Arabic CLDR categories), Tasks 05–13

## Pre-flight check

```bash
pwd                                                  # ../memry-i18n-phase-b
git status                                           # clean
cat packages/i18n/src/locales/ar/common.json         # confirm Phase A seed
```

## Your job

Replace `packages/i18n/src/locales/ar/common.json` with Arabic translations. Arabic CLDR has **six** plural categories: `zero`, `one`, `two`, `few`, `many`, `other`. ICU/`Intl.PluralRules` picks the right one automatically based on count value. These translations are seeded for *infrastructure validation*; a native-speaker review is tracked separately as a content task.

## Steps

1. Overwrite `packages/i18n/src/locales/ar/common.json` with:

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

Translation notes (informational, do not add to file):
- Arabic plural categories: `zero` (n=0), `one` (n=1), `two` (n=2), `few` (n=3-10), `many` (n=11-99), `other` (n≥100). `Intl.PluralRules('ar').select(n)` returns the right category.
- These ship at "infra validation" quality. Native review is a separate task — until then, untranslated nuance is acceptable; the architecture ships now.
- The dialog `dir="rtl"` flip from Phase A handles bidirectional layout.

2. Validate JSON:

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/ar/common.json', 'utf8'))" && echo OK
```

Expected: prints `OK`.

3. Run typecheck:

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes.

4. Commit:

```bash
git add packages/i18n/src/locales/ar/common.json
git commit -m "feat(i18n): translate common namespace to Arabic"
```

## Exit criteria

- [ ] All 42 keys translated to Arabic
- [ ] All six CLDR plural categories provided for each `count.*` key
- [ ] JSON is valid
- [ ] Typecheck passes
- [ ] One commit created

## Skills to use

None — content task.

## Report back

```
✅ Task 03 complete.
Commit SHA: <abbrev>
Translations: 42 Arabic strings (infra-quality, native review pending as separate content task)
Plural categories: 6 (zero/one/two/few/many/other) per count.* key
Next: Task 04 (ICU plural test)
```
