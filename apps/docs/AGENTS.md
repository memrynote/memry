# Docs Rules

VitePress documentation site (`@memry/docs`). Root `AGENTS.md` applies; this file adds docs rules.

## Layout

- `src/guide`, `src/user-guide` — how to use Memry.
- `src/architecture`, `src/architecture.md` — how it works.
- `src/contribute`, `src/contributing.md` — how to work on it.
- `src/features.md`, `src/roadmap.md` — what exists and what is planned.
- `src/public` — static assets.

## Commands

```bash
pnpm docs:dev     # from repo root
pnpm docs:build
```

`pnpm docs:build` must pass before any docs change is done. VitePress fails the build on a dead internal link, which is the point.

## The Docs Gate

`scripts/docs-impact.mjs` decides whether a code change needs docs. Pre-push runs it, and it is the only gate pre-push runs.

```bash
pnpm docs:impact --base <base_commit> --strict
pnpm docs:ai-update --base <base_commit>
```

- If impact reports `missing-docs`, write real documentation under `apps/docs/src/**`. Do not create a stub page to satisfy the gate; an empty page is worse than a missing one because it stops the gate from ever asking again.
- `pnpm docs:ai-update` drafts. You still read and correct what it wrote.
- `MEMRY_DOCS_IMPACT_SKIP=1` only when the change is genuinely non-docs, and say why.

## Writing

- Document what ships today. No aspirational tense, no undocumented flags, no screenshots of UI that no longer exists.
- Explain as: problem, concrete example or short trace, then solution. Concrete behavior over abstract summary.
- Define jargon before using it. Assume the reader knows their computer, not our codebase.
- Short sentences, plain language, no marketing voice. That lives in `apps/landing`.
- No emojis.
- Never document a workaround as a feature. If the honest answer is "this is a known limitation", write that.

## Accuracy

Docs drift is the default state of every project. Fight it at the source:

- When you change behavior in `apps/desktop` or `apps/sync-server`, update the page that describes it in the same change, not a follow-up.
- Before editing a page, verify the behavior it describes is still true. Fixing a paragraph around a stale claim keeps the stale claim.
- Link to code paths rather than pasting code that will rot.
