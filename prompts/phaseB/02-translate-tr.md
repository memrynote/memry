# Task 02: Translate `common.json` to Turkish

> **Plan:** Task 2 (Translate `common.json` to Turkish)
> **Depends on:** Task 01 (en/common.json expanded with universal vocabulary)
> **Dependents:** Task 04 (ICU plural test), Tasks 05–13 (migrations rely on tr translations to validate switching)

## Pre-flight check

```bash
pwd                                                  # ../memry-i18n-phase-b
git status                                           # clean
cat packages/i18n/src/locales/tr/common.json         # confirm Phase A seed (button.save/cancel/close)
```

## Your job

Replace `packages/i18n/src/locales/tr/common.json` with Turkish translations of every key from Task 01. Translations are reviewed by the project owner (native Turkish speaker); the values below are the approved set.

## Steps

1. Overwrite `packages/i18n/src/locales/tr/common.json` with:

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

Translation notes (informational, do not add to file):
- Turkish has **no plural suffix** when a number precedes the noun ("5 öğe", not "5 öğeler"). Both `one` and `other` ICU forms are the same word — `i18next-icu` still requires both keys to be defined.
- `İptal` is the universally-used Turkish for the Cancel button. `İptal et` is the verb form but `İptal` alone is the convention on UI buttons.
- `Tamam` doubles as both "OK" and "Done" — UI convention, not a translation slip.
- `Vazgeç` ("give up") is the natural fit for "Discard" in dialog context.

2. Validate JSON:

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/tr/common.json', 'utf8'))" && echo OK
```

Expected: prints `OK`.

3. Run typecheck (Turkish keys must mirror English shape):

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes.

4. Commit:

```bash
git add packages/i18n/src/locales/tr/common.json
git commit -m "feat(i18n): translate common namespace to Turkish"
```

## Exit criteria

- [ ] All 42 keys translated to Turkish
- [ ] Key shape matches `en/common.json` exactly
- [ ] JSON is valid
- [ ] Typecheck passes
- [ ] One commit created

## Skills to use

None — content task.

## Report back

```
✅ Task 02 complete.
Commit SHA: <abbrev>
Translations: 42 Turkish strings, native-reviewed
Next: Task 03 (translate to Arabic)
```
