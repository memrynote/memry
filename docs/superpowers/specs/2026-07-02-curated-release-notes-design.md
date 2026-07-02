# Curated user-facing release notes

## Problem

The in-app "update available" dialog shows the **entire GitHub release body**. That
body is a developer changelog: every PR in the release gets a bullet (including
landing-site, browser-extension, brand-rename, and sync-schema PRs that never
touch the desktop user's experience), every bullet carries a `#NNN` PR number, and
a `## Changelog` section lists all PRs again. Desktop users see noise, PR numbers,
and internal `Documentation` / `Chores` sections they do not care about.

Root cause: the developer changelog and the user-facing notes are the **same
string**. Best practice (Keep a Changelog; most desktop apps) is to split the two
audiences — devs get the full PR list on GitHub, users get a curated subset in-app.

## Goal

`pnpm release -- --humanize --yes` produces a curated, professional, user-facing
release-notes markdown file per release. That file:

- Contains only changes that impact the **desktop app or sync experience** for end
  users (features, improvements/behavior changes, fixes).
- Mentions **no PR numbers and no commit refs**.
- Is committed to the repo as the canonical artifact and is what the **in-app
  update dialog shows**.

Developers keep the full PR changelog on the GitHub release page.

## Approach (chosen: curate the body, reuse the pipeline)

One curated artifact — `release-notes/<version>.md` — is the source of truth. Its
content becomes the top of the GitHub release body; the dev `## Changelog` stays
below it. The desktop app already renders the release body, so it needs only to
**strip everything from `Changelog` onward** to show the curated notes alone.

Rejected alternatives:

- **App fetches the file directly** (raw.githubusercontent / bundled): cleanest
  separation but adds fetch + cache + offline fallback + markdown rendering to the
  app — most new code and a new failure mode. Not worth it.
- **Curated body only, drop dev changelog**: zero app change, but loses the
  developer PR list on the GitHub release page.

## Changes

All in existing files; no new subsystems.

### 1. AI prompt — `scripts/release-notes-utils.mjs` `buildReleaseNotesPrompt`

- **Filter** to user-impacting desktop + sync changes. Signal = the
  conventional-commit scope already present in each PR title:
  - **Keep**: `desktop`, `sync-server`, `sync`, and cross-cutting user features.
  - **Drop**: `landing`, extension / clipper, `brand` / rename, `docs`, `ci`,
    `test`, `chore`, and schema-only / internal refactors.
- **No PR numbers, no commit refs** in bullets.
- Sections reduced to user-facing: `## New Features`, `## Improvements`, `## Fixes`
  (drop `Documentation` and `Chores`).
- Each bullet: one emoji + short title + em dash + one-sentence user benefit.
- If nothing qualifies → a single bullet under `## Improvements`:
  `- ✨ General improvements — performance and stability updates.`

### 2. Validation — `scripts/release-notes-utils.mjs` `validateHumanizedReleaseMarkdown`

- **Remove** the "every bullet must include a PR number" rule (this rule is why
  users see `#NNN`).
- Required sections → `New Features`, `Improvements`, `Fixes`. Empty sections
  allowed (a section heading with no bullets is fine).
- Keep the "must not include a Changelog section" rule.

### 3. Write the committed file — `scripts/humanize-release-notes.mjs`

- After `validateHumanizedReleaseMarkdown` succeeds, write the curated markdown
  (curated content only — no humanized marker, no changelog) to
  `release-notes/<version>.md` at the repo root, named by `preview.appVersion`
  (e.g. `release-notes/2026.7.2.md`).
- `git add` the file so it is staged with the release. **Do not auto-commit or
  push** — the human commits it with the release. Print a one-line reminder of the
  written path.
- Skip the file write on `--dry-run`.

### 4. Body build + in-app strip

- `buildHumanizedReleaseBody` (`release-notes-utils.mjs`): **unchanged** — GitHub
  body stays `marker + curated + ## Changelog` so devs keep the PR list.
- `normalizeReleaseNotes` (`apps/desktop/src/main/updater.ts`): after
  `htmlToPlainText`, cut everything from a line that is just `Changelog` onward, so
  the in-app dialog shows only the curated sections. Apply to both the string and
  the array-entry code paths.

## Data flow

```
PRs in draft release
   │  (humanize-release-notes.mjs)
   ▼
buildReleaseNotesPrompt  ── filter desktop/sync, no PR#, 3 user sections ──▶ claude
   ▼
validateHumanizedReleaseMarkdown  (no PR# rule)
   ├─▶ write release-notes/<version>.md  (curated only) + git add     ← source of truth
   └─▶ buildHumanizedReleaseBody: marker + curated + ## Changelog
          ▼  gh release edit  →  GitHub release body
          ▼  electron-updater reads body via releases.atom (HTML)
       normalizeReleaseNotes: htmlToPlainText → strip from "Changelog" onward
          ▼
       in-app update dialog  ← curated notes only, no PR numbers
```

## Edge cases

- **No user-facing changes in a release** (only landing/extension/chore PRs): prompt
  emits the single fallback "General improvements" bullet. Never empty.
- **HTML vs markdown**: in-app notes arrive as HTML from `releases.atom`; strip the
  Changelog **after** `htmlToPlainText` (match a `Changelog` heading line).
- **`--dry-run`**: prints the body as today; no file written, nothing staged.

## Testing

- `scripts/release-notes-utils.test.mjs`:
  - `validateHumanizedReleaseMarkdown` accepts bullets with no PR number.
  - still rejects a `## Changelog` section.
  - requires the three user sections; allows an empty section.
- `apps/desktop/src/main/updater.test.ts`:
  - `normalizeReleaseNotes` strips the `Changelog` section from a string body.
  - strips it from an array-entry body.
  - leaves curated-only notes untouched.

## Out of scope

- No change to how `release-notes/<version>.md` is consumed by landing/docs (future
  reuse is possible but not built here).
- No auto-commit / auto-push of the notes file from the release script.
- No per-platform note variants.
