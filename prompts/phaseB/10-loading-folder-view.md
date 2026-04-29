# Task 10: Migrate "Loading…" states in folder-view

> **Plan:** Task 10 (Migrate "Loading…" States in Folder View)
> **Depends on:** Task 01 (en/common.json has `state.loading`)
> **Dependents:** Task 15

## Pre-flight check

```bash
pwd                                                                                # ../memry-i18n-phase-b
git status                                                                         # clean
grep -n "Loading\.\.\." apps/desktop/src/renderer/src/components/folder-view/folder-table-view.tsx
grep -n "Loading\.\.\." apps/desktop/src/renderer/src/components/folder-view/grouped-table.tsx
```

Each file should have one match around line 971 / 992 respectively (`<div className="text-muted-foreground">Loading...</div>`).

## Your job

Replace `Loading...` text with `t('common:state.loading')` in both folder-view tables. The translated string uses Unicode ellipsis `…` (single character) — minor visual drift from `...` is intentional and acceptable.

## Steps

1. **Edit `apps/desktop/src/renderer/src/components/folder-view/folder-table-view.tsx`:**

Add the import at the top:

```ts
import { useT } from '@memry/i18n/renderer'
```

In the component function rendering the loading state, add:

```ts
const { t } = useT('common')
```

Replace `>Loading...<` with `>{t('state.loading')}<`.

2. **Edit `apps/desktop/src/renderer/src/components/folder-view/grouped-table.tsx`:**

Same pattern — add the import, add `const { t } = useT('common')` in the component, replace `Loading...` with `{t('state.loading')}`.

3. Run typecheck:

```bash
pnpm typecheck:web
```

Expected: passes.

4. Smoke-test:

```bash
pnpm dev
```

Open a folder view that triggers a loading state. Verify `Loading…` appears in English. Switch to Türkçe and re-trigger; verify `Yükleniyor…` appears.

5. Commit:

```bash
git add apps/desktop/src/renderer/src/components/folder-view/folder-table-view.tsx apps/desktop/src/renderer/src/components/folder-view/grouped-table.tsx
git commit -m "feat(i18n): migrate folder-view Loading state to common namespace"
```

## Exit criteria

- [ ] Both files use `t('state.loading')` for the Loading placeholder
- [ ] No other text in either file changed
- [ ] `pnpm typecheck:web` passes
- [ ] Manual smoke: Loading flips en ↔ tr
- [ ] One commit created

## Skills to use

`superpowers:rigorous-coding` — only the Loading text changes.

## Report back

```
✅ Task 10 complete.
Commit SHA: <abbrev>
Loading… migrations: 2 files
Next: Task 11 (Loading… in settings)
```
