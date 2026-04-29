# Task 11: Migrate "Loading…" states in settings

> **Plan:** Task 11 (Migrate "Loading…" States in Settings Section)
> **Depends on:** Task 01
> **Dependents:** Task 15

## Pre-flight check

```bash
pwd                                                                                                  # ../memry-i18n-phase-b
git status                                                                                           # clean
grep -n "Loading\.\.\." apps/desktop/src/renderer/src/pages/settings/account-section.tsx
grep -n "Loading\.\.\." apps/desktop/src/renderer/src/pages/settings/ai-inline-section.tsx
grep -n "Loading\.\.\." apps/desktop/src/renderer/src/components/settings/recovery-key-dialog.tsx
```

Expected matches:
- `account-section.tsx:~93`: `<SettingsHeader title="Account" subtitle="Loading..." />`
- `ai-inline-section.tsx:~144`: `<p className="text-xs/4 text-muted-foreground">Loading...</p>`
- `recovery-key-dialog.tsx:~78`: `<p className="text-sm text-muted-foreground">Loading...</p>`

## Your job

Replace `Loading...` literals in three settings-related files with `t('common:state.loading')`. **Do NOT** translate `title="Account"` or any other settings-specific copy — those go in Phase C settings.

## Steps

1. **Edit `apps/desktop/src/renderer/src/pages/settings/account-section.tsx`:**

Add the import:

```ts
import { useT } from '@memry/i18n/renderer'
```

In the component function, add:

```ts
const { t } = useT('common')
```

Replace `subtitle="Loading..."` with `subtitle={t('state.loading')}`.

(Leave `title="Account"` untouched — feature-specific.)

2. **Edit `apps/desktop/src/renderer/src/pages/settings/ai-inline-section.tsx`:**

Add the import + `const { t } = useT('common')` in the component. Replace `>Loading...<` with `>{t('state.loading')}<`.

3. **Edit `apps/desktop/src/renderer/src/components/settings/recovery-key-dialog.tsx`:**

Same pattern: add import, add hook call inside the component, replace `>Loading...<` with `>{t('state.loading')}<`.

4. Run typecheck:

```bash
pnpm typecheck:web
```

Expected: passes.

5. Commit:

```bash
git add apps/desktop/src/renderer/src/pages/settings/account-section.tsx apps/desktop/src/renderer/src/pages/settings/ai-inline-section.tsx apps/desktop/src/renderer/src/components/settings/recovery-key-dialog.tsx
git commit -m "feat(i18n): migrate settings Loading states to common namespace"
```

## Exit criteria

- [ ] All three files use `t('state.loading')` for the Loading placeholder
- [ ] No feature-specific text changed (`title="Account"` etc. preserved)
- [ ] `pnpm typecheck:web` passes
- [ ] One commit created

## Skills to use

`superpowers:rigorous-coding` — surgical, three identical edits.

## Report back

```
✅ Task 11 complete.
Commit SHA: <abbrev>
Loading… migrations: 3 files
Next: Task 12 (aria-label="Search")
```
