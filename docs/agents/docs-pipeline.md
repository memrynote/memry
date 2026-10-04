# Docs

- `scripts/docs-impact.mjs` is the docs-routing source of truth.
- Pre-push is intentionally docs-only for code-relevant changes: branch-name guard, base commit resolution, `pnpm docs:impact --base "$base_commit" --strict`, and `pnpm docs:ai-update --base "$base_commit"` only when `MEMRY_DOCS_AI_AUTO=1`. Do not re-add local lint/typecheck/test/docs-build to regular pre-push unless Kaan explicitly asks.
- Before push, PR, or merge after desktop/sync-server changes, run `pnpm docs:ai-update --base <base_commit>` or update `apps/docs/src` by hand, then `pnpm docs:impact --base <base_commit> --strict` and `pnpm docs:build`.
- If docs impact says `missing-docs`, update only real docs under `apps/docs/src/**`.
- Use `MEMRY_DOCS_IMPACT_SKIP=1` only when the change is intentionally non-docs and you can explain why.
