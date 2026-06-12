# Plan 011: Produce the importers design spec (Obsidian + generic Markdown folder v1) and a validated import contract

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 86ee0cd1..HEAD -- packages/contracts/src/settings-schemas.ts packages/app-core/src/note-files.ts ideas/ideas.md`
> If any of these changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M (spike + spec; the build it specifies is M–L and is NOT part of this plan)
- **Risk**: LOW (this plan produces a design document; no source code changes)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `86ee0cd1`, 2026-06-13

## Why this matters

Importers (Obsidian, Notion, Roam, generic Markdown folder) are listed as **Active** on the public roadmap (`apps/landing/src/pages/Roadmap.tsx:38-40`), and the shipped waitlist marketing emails (`apps/marketing-emails/src/waitlist-program-content.ts`) promise users they can "copy your vault folder directly, .md files just work" (Obsidian) and "export pages as Markdown + Files, then drop the folder into your vault" (Notion). Today **zero importer code exists** — only an unused contract schema. Migration is the single biggest onboarding gate for a notes app, and public launch is targeted for end of July 2026. This plan does NOT build the importer; it produces the design spec and resolves the open product decisions so a build plan can execute without ambiguity.

## Current state

- `packages/contracts/src/settings-schemas.ts:254-273` — import/export contracts exist but are referenced nowhere outside their own test file:

```ts
// packages/contracts/src/settings-schemas.ts:254
export const ExportRequestSchema = z.object({
  format: z.enum(['json', 'markdown']),
  destPath: z.string().min(1)
})
// ...
export const ImportRequestSchema = z.object({
  sourcePath: z.string().min(1),
  format: z.enum(['notion', 'obsidian', 'json'])
})
// ...
export const ImportResultSchema = z.object({
  imported: z.number().int(),
  skipped: z.number().int()
})
```

- `packages/app-core/src/note-files.ts` — markdown **export** already works (`exportMarkdown` and HTML/PDF export options around lines 59-100+). The export shape is the closest thing to a spec of what an imported note must round-trip to.
- `ideas/ideas.md:341-352` — a decided product direction for _capture-style_ imports (Google Keep named first): "Imported items should land in the inbox for triage rather than auto-filing" and the boundary "Import should not silently scatter content across the app. Bring it in as reviewable material the user can sort."
- **Tension the spike must resolve**: the marketing emails promise bulk vault migration (notes land as notes, folders preserved), while `ideas.md` mandates inbox-triage landing for imports. These are likely two different import modes (bulk vault migration vs. item-level capture import). The spec must name both, decide v1 scope, and reconcile the "don't silently scatter" boundary (e.g. a dry-run report + explicit confirmation for bulk mode).
- `packages/contracts/src/inbox-api.ts:42` — the triage model the capture-style mode would reuse: `TriageAction = 'discard' | 'convert-to-task' | 'expand-to-note' | 'file' | 'defer'`.
- Critical repo constraint (from `docs/goal.md`, "Project-specific rules"): **all vault mutations must go through the same domain entry points renderer IPC uses**, so field-clock / sync-queue bookkeeping fires. An importer that writes files or DB rows directly would silently break sync. Quote: "Never invent a wrapper that bypasses sync queueing or vector clocks."
- Design-spec convention: specs live at `docs/superpowers/specs/YYYY-MM-DD-<name>-design.md` — see `docs/superpowers/specs/2026-06-11-free-plan-sync-gating-design.md` as a structural exemplar (problem → decisions → architecture → phases → out of scope).

## Commands you will need

| Purpose               | Command                                                                                                                        | Expected on success                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Confirm schema unused | `grep -rn "ImportRequestSchema" apps/ packages/ --include="*.ts" --include="*.tsx" -l \| grep -v node_modules \| grep -v test` | only `packages/contracts/src/settings-schemas.ts` |
| Lint (unchanged)      | `pnpm lint`                                                                                                                    | exit 0 (spec-only change must not affect it)      |
| Working tree check    | `git status --porcelain`                                                                                                       | only the new spec file + plans/README.md row      |

## Scope

**In scope** (the only files you may create or modify):

- `docs/superpowers/specs/2026-06-13-importers-design.md` (create)
- `plans/README.md` (status row update)

**Out of scope** (do NOT touch):

- Any file under `apps/desktop/src`, `packages/*/src` — this is a spec-only spike. No prototype code in the repo.
- `packages/contracts/src/settings-schemas.ts` — the spec may _propose_ changes to `ImportRequestSchema`; do not apply them.
- Notion API integration and Roam — name them in the spec's "later phases" section only.

## Git workflow

- Branch: `importers-design-spec` (repo rule: code-context branch names; never `claude/`, `codex/`, or random names).
- Commit style: conventional commits, e.g. `docs(specs): importers design spec (obsidian + markdown folder v1)`. Do NOT add Co-Authored-By lines.
- Do NOT push or open a PR unless the operator instructed it. If pushing and the pre-push docs gate blocks, `MEMRY_DOCS_IMPACT_SKIP=1` is acceptable for this spec-only change (no `apps/desktop`/`apps/sync-server` code touched).

## Steps

### Step 1: Investigate the note-creation domain path

Read (do not modify): `packages/app-core/src/note-files.ts` (import/export surface), the note-creation entry point in `packages/app-core/src/` (find via `grep -rn "createNote" packages/app-core/src --include="*.ts" -l`), and how the desktop main process creates notes such that sync bookkeeping fires (`grep -rn "createNote" apps/desktop/src/main --include="*.ts" -l`). Record in the spec: the exact function(s) a bulk importer must call per note, and per attachment (`grep -rn "storeInboxAttachment\|attachment" apps/desktop/src/main/inbox/attachments.ts | head`).

**Verify**: the spec's "Integration points" section names at least one concrete function with file path for: note creation, tag attachment, folder placement, attachment storage.

### Step 2: Inventory the markdown dialect gap

Read the repo's serializer (`grep -rn "serializeBlocksPreservingBlanks" apps/desktop/src --include="*.ts" -l` — note it exists in BOTH `markdown-utils.ts` and the main-process `blocknote-converter.ts`; the spec must state imports go through one canonical parse path). List in the spec the Obsidian constructs that need mapping decisions: wikilinks `[[...]]` (repo already supports wiki-links per the editor), frontmatter → properties, `#tags`, callouts, embeds `![[...]]`, attachments folder, daily-notes folder → journal entries (or not, v1 decision).

**Verify**: spec contains a "Mapping table" section with one row per construct: source syntax → Memry target → v1 decision (map / preserve-as-text / skip-with-report).

### Step 3: Resolve the product decisions

Write the "Decisions" section answering, with rationale:

1. **Two modes or one**: bulk vault migration (notes→notes) vs capture import (items→inbox triage, per `ideas/ideas.md:345-347`). Recommended resolution to document: bulk mode for Obsidian/Markdown-folder with a mandatory dry-run report (satisfies the "don't silently scatter" boundary); inbox-triage mode reserved for item-level sources (Keep, clipper) in a later phase.
2. **Dedup/conflict**: re-import of the same folder — skip by content hash? by path? `ImportResultSchema` already has `{imported, skipped}`.
3. **Sync interaction**: imported notes enqueue for sync like any created note (entitlement-gated for free users). Large imports → R2 payloads; state expected behavior for a 2,000-note vault on a free (local-only) account.
4. **Contract shape**: keep or extend `ImportRequestSchema` (e.g. add `mode`, `dryRun`); propose the result shape for a dry-run report (counts + per-file issues list).
5. **UX surface**: where import lives (Settings → Data? vault switcher?), progress, cancellation, partial-failure semantics.

**Verify**: `grep -c "^### Decision" docs/superpowers/specs/2026-06-13-importers-design.md` → ≥ 5

### Step 4: Define v1 scope, phases, and test fixtures

Spec sections: "V1 scope" (Obsidian vault folder + generic Markdown folder; Notion-markdown-export likely free if the parser is dialect-tolerant — state explicitly), "Later phases" (Notion API, Roam JSON, Google Keep per `ideas/ideas.md:341`), "Test fixtures" (commit a tiny sample vault under `apps/desktop/tests/fixtures/` — describe its contents: nested folders, wikilinks, frontmatter, an image attachment, a duplicate-name pair), and "Open questions" (anything genuinely unresolved, each with a recommended answer).

**Verify**: spec file contains sections: Problem, Integration points, Mapping table, Decisions, V1 scope, Later phases, Test fixtures, Open questions.

## Test plan

No code tests — this plan ships a spec. The spec itself must define the build plan's test plan: round-trip tests (import fixture vault → export markdown → diff), dry-run report unit tests, and a sync-bookkeeping assertion (imported note appears in the sync queue on an entitled account).

## Done criteria

- [ ] `docs/superpowers/specs/2026-06-13-importers-design.md` exists and contains all eight sections listed in Step 4's verify
- [ ] Every "Decision" section has a stated recommendation (no decision left as a bare question)
- [ ] `git status --porcelain` shows only the spec file and `plans/README.md`
- [ ] `pnpm lint` exits 0
- [ ] `plans/README.md` status row for 011 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `ImportRequestSchema` is now referenced outside `settings-schemas.ts`/its test (someone started building an importer — reconcile with their direction instead of spec'ing over them).
- You cannot locate a domain-level note-creation entry point that fires sync bookkeeping (Step 1) — the spec cannot be honest without it.
- `ideas/ideas.md` no longer contains the import section (lines ~341-352) — the product boundary may have changed.

## Maintenance notes

- The build plan that follows this spec must re-verify the serializer duplication (renderer `markdown-utils.ts` vs main `blocknote-converter.ts`) — both have round-trip test blocks that must stay green.
- Reviewer should scrutinize: the bulk-vs-inbox mode reconciliation against `ideas/ideas.md`'s stated boundary, and the free-account (local-only) import behavior.
- Explicitly deferred: Notion API client, Roam JSON, Google Keep, import _scheduling_ (watch-folder continuous import).
