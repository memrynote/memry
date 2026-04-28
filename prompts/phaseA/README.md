# Phase A Implementation Prompts

This directory contains self-contained prompts for executing Phase A of the i18n project. Each file is a complete brief for a **fresh Claude Code session** (or any compatible coding agent).

## Spec & plan (canonical sources)

- **Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
- **Plan:** `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md`

These prompts are derived from the plan. If they drift, the plan wins.

## How to use

For each task, in order:

1. Open a fresh Claude Code session at the repo root (or attach to the worktree from Task 00)
2. Copy the contents of the prompt file (e.g., `04-direction-helper.md`)
3. Paste as the first user message in the new session
4. Let the agent execute end-to-end (including the commit)
5. Verify the agent's report-back: commit SHA appears in `git log`, tests pass
6. Move to the next prompt

## Why a new session per task

- **Clean context:** the agent isn't fighting against 27 prior tasks of conversation
- **Failure isolation:** if Task 14 fails, Tasks 1–13 are committed and Task 15+ are untouched. Re-run just Task 14 with a fresh agent
- **Portable:** any developer or agent can pick up a prompt and run it
- **Auditable:** prompts are in git, so future-you can see exactly what was instructed

## Order & dependencies

Tasks run sequentially **except for these parallel-safe groups** after Task 21:

- Tasks 22, 26, 27 are independent (CSS, docs, CLAUDE.md) — can run in any order or parallel
- Tasks 0a and 0b are independent preflight checks — either order

## File index

| # | File | Depends on | TDD? | Notes |
|---|---|---|---|---|
| 00 | `00-worktree-setup.md` | (clean main) | no | Creates `feature/i18n-phase-a` worktree |
| 0a | `00a-preflight-intl-locale.md` | 00 | no | Verify `Intl.Locale.textInfo` works |
| 0b | `00b-preflight-react-i18next.md` | 00 | no | Verify peer-deps |
| 01 | `01-package-skeleton.md` | 0a, 0b | no | `packages/i18n` scaffold |
| 02 | `02-install-deps.md` | 01 | no | Wire `@memry/i18n` into desktop |
| 03 | `03-locale-api-contracts.md` | 02 | no | `LocaleSchema`, `LocaleApi` in contracts |
| 04 | `04-shared-config.md` | 03 | no | Display names, namespaces |
| 05 | `05-direction-helper.md` | 04 | yes | `localeDirection()` |
| 06 | `06-types-augmentation.md` | 05 | no | i18next type augmentation |
| 07 | `07-shared-barrel.md` | 06 | no | Update `shared/index.ts` |
| 08 | `08-locale-resources.md` | 07 | no | Seed JSONs for en/tr/ar |
| 09 | `09-load-resources.md` | 08 | yes | `loadResources()` helper |
| 10 | `10-main-i18n-instance.md` | 09 | yes | `createMainI18n()` |
| 11 | `11-tighten-language-schema.md` | 10 | no | Tighten `GeneralSettings.language` |
| 12 | `12-validate-ipc-contract.md` | 11 | no | `pnpm ipc:check` |
| 13 | `13-locale-channels.md` | 12 | no | `LocaleChannels` constants |
| 14 | `14-locale-handler.md` | 13 | yes | Main IPC handler |
| 15 | `15-main-boot-wiring.md` | 14 | no | Wire main process boot |
| 16 | `16-native-menu-localize.md` | 15 | no | Use `t()` in native menu |
| 17 | `17-renderer-i18n-instance.md` | 16 | yes | `createRendererI18n()` |
| 18 | `18-i18n-provider.md` | 17 | no | `<I18nProvider>` |
| 19 | `19-hooks-useT-useDirection.md` | 18 | no | React hooks |
| 20 | `20-apply-document-attrs.md` | 19 | no | `applyLocaleToDocument()` |
| 21 | `21-renderer-boot-bridge.md` | 20 | no | Wire renderer boot + preload |
| 22 | `22-mirror-rtl-css.md` | 21 | no | `mirror-rtl` Tailwind class |
| 23 | `23-settings-language-picker.md` | 21 | no | The actual picker UI |
| 24 | `24-extract-error-translation.md` | 21 | no | i18n key resolution in errors |
| 25 | `25-i18n-e2e-spec.md` | 23, 24 | yes | Playwright spec |
| 26 | `26-adding-locale-doc.md` | 21 | no | Doc for adding language N |
| 27 | `27-claude-md-rule.md` | 21 | no | Tailwind logical-class rule |
| 28 | `28-final-verification.md` | 25, 26, 27 | no | Lint + typecheck + e2e + PR |

## Each prompt's structure

```
- Plan/spec links
- Depends on / Dependents (so the agent verifies state)
- Pre-flight check (commands that must succeed before starting)
- Your job (1-2 sentences)
- Steps (with exact code blocks)
- Exit criteria (checklist for completion)
- Skills to use (which superpowers skills the agent should invoke)
- Report back (what to tell you when done)
```

## Reporting back format

After executing a prompt, the agent should reply with:

```
✅ Task NN complete.
Commit SHA: <abbrev>
Tests: <green summary>
Deviations: <none, or "I had to ___ because ___">
Next: Task (N+1)
```

If the agent reports failure, paste the error here and I'll help triage before moving on.

## Phase B onward

Phase A only. Phase B (common namespace migration), C (feature-by-feature), D (main-process strings), and E (codemod + lint gate) get their own prompt directories when those plans are written.
