# Docs guide

This directory owns the VitePress docs site (`@memry/docs`) and the docs gate that keeps it current with desktop and the sync server. A push to `main` that touches `apps/docs/` deploys the site to Vercel production.

## Layout

- `src/guide` and `src/user-guide` explain how to use Memry, `src/architecture` explains how it works, and `src/contribute` explains how to work on it. `src/features.md` and `src/roadmap.md` cover what exists and what is planned. `src/public` holds static assets.
- `src/.vitepress/config.ts` owns the nav and the sidebar. Give a new page a sidebar entry.
- Agents read `src/contribute/` for tests, gotchas, workflow, and releases, so keep its commands runnable.

## Commands

Run `pnpm docs:dev` or `pnpm docs:build` from the repo root. A docs change is done when `pnpm docs:build` passes. VitePress fails the build on a dead internal link.

## Docs gate

`scripts/docs-impact.mjs` decides whether a branch needs docs. It flags changes to `apps/desktop` (`src`, `config`, `scripts`, `package.json`), `apps/sync-server` (`src`, `schema`, `package.json`, `wrangler.toml`), and `packages/contracts`, `db-schema`, `rpc`, `shared`, `sync-client`, and `sync-core`. Tests, fixtures, mocks, and shell scripts don't count. The gate passes when the branch also changes anything under `apps/docs/`.

Before pushing, opening a PR, or merging a flagged change:

1. Run `pnpm docs:ai-update --base <base_commit>` to draft updates with the Codex CLI, or edit `apps/docs/src` by hand. Read and correct whatever the updater wrote.
2. Run `pnpm docs:impact --base <base_commit> --strict`, then `pnpm docs:build`.

- Any docs change satisfies the gate, so a stub page would silence it for the whole branch. When impact reports `missing-docs`, write real documentation under `apps/docs/src/`.
- Set `MEMRY_DOCS_IMPACT_SKIP=1` only for a change with no user-facing docs impact, and say why in the PR.
- Pre-push runs the gate with `--strict`, and runs `docs:ai-update` itself only when `MEMRY_DOCS_AI_AUTO=1`. Keep `docs:build` out of pre-push unless Kaan asks.

## Writing

- Document what ships today, in the present tense. Planned work goes only in `src/roadmap.md`. Leave out undocumented flags and screenshots of UI that no longer exists.
- Explain as the problem, then a concrete example or short trace, then the solution.
- Define jargon before using it. Assume the reader knows their computer, not our codebase.
- Use short sentences and plain language, with no emojis. Marketing voice belongs to `apps/landing`.
- Call a workaround a workaround, never a feature. When the honest answer is a known limitation, write that.

## Accuracy

- Update the page that describes a behavior in the same change as the behavior.
- Before editing a page, check that the behavior it describes is still true. Polishing a paragraph around a stale claim keeps the stale claim.
- Link to code paths instead of pasting code that will rot.
