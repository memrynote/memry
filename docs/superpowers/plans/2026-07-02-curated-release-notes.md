# Curated User-Facing Release Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm release -- --humanize --yes` produce a curated, user-facing release-notes markdown file per release and show only that curated content (no PR numbers, no dev noise) in the in-app update dialog.

**Architecture:** One curated artifact `release-notes/<version>.md` is the source of truth. Its content is the top of the GitHub release body; the dev `## Changelog` stays below it for GitHub. The desktop app already renders the release body, so it only strips everything from `Changelog` onward. Three focused changes: (1) AI prompt + validation in `scripts/release-notes-utils.mjs`, (2) write the committed file in `scripts/humanize-release-notes.mjs`, (3) strip the changelog in-app in `apps/desktop/src/main/updater.ts`.

**Tech Stack:** Node ESM scripts, `node:test` for script tests; Electron main + Vitest for the desktop app; `claude` CLI (headless) for note generation.

## Global Constraints

- Prettier: single quotes, no semicolons, 100 char width, no trailing commas. Copy the existing style in each file.
- Script tests use `node:test` + `node:assert/strict` and run via `node --test`.
- User-facing release-note bullets must contain **no PR numbers, no issue numbers, no commit hashes**.
- User-facing sections are exactly: `## New Features`, `## Improvements`, `## Fixes`.
- The GitHub release body still keeps its `## Changelog` section (dev PR list) — do not remove it.
- Do not auto-commit or auto-push the notes file from the release script; only `git add` (stage) it.

---

### Task 1: Curated prompt + validation in `release-notes-utils.mjs`

**Files:**

- Modify: `scripts/release-notes-utils.mjs` (`buildReleaseNotesPrompt`, `validateHumanizedReleaseMarkdown`, `requiredHumanizedSections`)
- Test: `scripts/release-notes-utils.test.mjs`

**Interfaces:**

- Consumes: existing `buildReleaseNotesPrompt({ finalTag, pullRequests })`, `validateHumanizedReleaseMarkdown(markdown)`.
- Produces: `validateHumanizedReleaseMarkdown` that (a) requires sections `New Features`, `Improvements`, `Fixes`, (b) still rejects a `## Changelog` section, (c) **rejects** any bullet containing a `#NNN` number, (d) accepts bullets with no number. `buildReleaseNotesPrompt` unchanged signature.

- [ ] **Step 1: Rewrite the two existing tests that hardcode the old sections**

Two existing tests in `scripts/release-notes-utils.test.mjs` use the old sections (`Bug Fixes`/`Documentation`/`Chores`) and bullets containing `(#124)`. Both must be **replaced in place** — leaving them alongside the new rules would fail. (The prompt test "builds a prompt that asks the model to rewrite facts…" is unaffected — leave it as is.)

Replace the whole `it('validates humanized markdown shape before editing a release', …)` test (currently lines ~115–155) with:

```javascript
it('validates humanized markdown shape before editing a release', () => {
  const markdown = [
    '## New Features',
    '- 📑 Table of Contents Shortcut — Open note outlines faster.',
    '',
    '## Improvements',
    '- 🚀 Faster Startup — The app opens more quickly.',
    '',
    '## Fixes',
    '- 🔗 Better Media Paths — PDF links resolve more consistently.'
  ].join('\n')

  assert.equal(validateHumanizedReleaseMarkdown(markdown), markdown)
  assert.throws(
    () => validateHumanizedReleaseMarkdown('## New Features\n- Missing sections'),
    /Improvements/
  )
  assert.throws(() => validateHumanizedReleaseMarkdown(`${markdown}\n\n## Changelog`), /Changelog/)
  assert.throws(
    () =>
      validateHumanizedReleaseMarkdown(
        [
          '## New Features',
          '📑 No bullet dash — nope.',
          '',
          '## Improvements',
          '',
          '## Fixes'
        ].join('\n')
      ),
    /must be Markdown bullets/
  )
  assert.throws(
    () =>
      validateHumanizedReleaseMarkdown(
        [
          '## New Features',
          '- 📑 Table of Contents Shortcut — Open note outlines faster. (#124)',
          '',
          '## Improvements',
          '',
          '## Fixes'
        ].join('\n')
      ),
    /must not include a PR or issue number/
  )
})
```

Replace the `humanized` fixture inside `it('builds final release notes with marker, prose, and changelog', …)` (currently lines ~178–191) with the curated form (no old sections, no PR numbers in bullets):

```javascript
const humanized = [
  '## New Features',
  '- 📑 Table of Contents Shortcut — Open note outlines faster.',
  '',
  '## Improvements',
  '- 🚀 Faster Startup — The app opens more quickly.',
  '',
  '## Fixes',
  '- 🔗 Better Media Paths — PDF links resolve more consistently.'
].join('\n')
```

Leave the rest of that test unchanged — the `#124` it asserts comes from the `## Changelog` section built from `pullRequests`, which is not affected by the curated rules.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/release-notes-utils.test.mjs`
Expected: FAIL — the rewritten "validates humanized markdown shape" test fails because the current validator requires `Bug Fixes`/`Documentation`/`Chores` and requires a PR number in every bullet (so the curated `markdown` throws instead of validating, and the `(#124)` case does not throw the new message yet).

- [ ] **Step 3: Update `requiredHumanizedSections` and validation**

In `scripts/release-notes-utils.mjs`, change the constant near the top:

```javascript
const requiredHumanizedSections = ['New Features', 'Improvements', 'Fixes']
```

In `validateHumanizedReleaseMarkdown`, replace the PR-number-required loop:

```javascript
const bulletLines = contentLines.filter((line) => line.startsWith('- '))
for (const line of bulletLines) {
  if (!/#\d+\b/.test(line)) {
    throw new Error(`Humanized release note bullet is missing a PR number: ${line}`)
  }
}
```

with the inverse rule:

```javascript
const bulletLines = contentLines.filter((line) => line.startsWith('- '))
for (const line of bulletLines) {
  if (/#\d+\b/.test(line)) {
    throw new Error(`Humanized release note bullet must not include a PR or issue number: ${line}`)
  }
}
```

Leave the Changelog rejection and the "items must be Markdown bullets" checks unchanged.

- [ ] **Step 4: Rewrite the prompt in `buildReleaseNotesPrompt`**

Replace the returned array (the `return [ ... ].join('\n')`) with:

```javascript
return [
  'You are writing Memry desktop release notes for end users.',
  '',
  'Audience: people using the Memry desktop app. They do not care about the',
  'marketing website, browser extension, internal refactors, or developer tooling.',
  '',
  'Rules:',
  '- Do not invent changes. Use only the provided PR titles, labels, authors, and release notes.',
  '- Include only changes that affect the desktop app or the sync experience for end users.',
  '- Judge relevance from each PR title scope and labels. Keep changes scoped to desktop, sync-server, or sync, plus cross-cutting user-facing features.',
  '- Skip changes scoped to the landing site, browser extension or web clipper, brand or rename, documentation, CI, tests, chores, and schema-only or internal refactors.',
  '- Do not include any PR numbers, issue numbers, or commit hashes.',
  '- Rewrite technical PR names into short human-friendly release-note bullets.',
  '- Keep each bullet to one sentence.',
  '- Every release-note item must be a Markdown bullet line starting with "- ".',
  '- Start every bullet with one relevant emoji, then a concise title, an em dash, and the explanation.',
  '- Use exactly these sections: ## New Features, ## Improvements, ## Fixes.',
  '- Leave a section empty if no provided change belongs there.',
  '- If no change is user-facing, output only the "## Improvements" section with a single bullet "- ✨ General improvements — performance and stability updates." and leave the other sections empty.',
  '- Do not include a Changelog section.',
  '- Return Markdown only. Do not wrap the answer in a code fence.',
  '- Begin the response with the "## New Features" heading. Add no greeting, preamble, or closing remarks.',
  '',
  'Input JSON:',
  JSON.stringify(input, null, 2)
].join('\n')
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/release-notes-utils.test.mjs`
Expected: PASS (all cases, including any pre-existing tests). If a pre-existing test asserted the old sections (`Bug Fixes`/`Documentation`/`Chores`) or required PR numbers in bullets, update that test to the new curated rules in the same commit.

- [ ] **Step 6: Commit**

```bash
git add scripts/release-notes-utils.mjs scripts/release-notes-utils.test.mjs
git commit -m "feat(release): curate release-note prompt and drop PR numbers"
```

---

### Task 2: Write the committed `release-notes/<version>.md` file

**Files:**

- Modify: `scripts/humanize-release-notes.mjs` (imports, add `writeCuratedReleaseNotes`, call it after the dry-run early return)

**Interfaces:**

- Consumes: `humanizedMarkdown` (the validated curated markdown, already computed at line ~97) and `preview.appVersion` (already computed at line ~55).
- Produces: on a non-dry-run, `release-notes/<preview.appVersion>.md` written with the curated markdown and `git add`-ed. No new exports.

- [ ] **Step 1: Extend the `node:fs` import**

At the top of `scripts/humanize-release-notes.mjs`, change:

```javascript
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
```

to:

```javascript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
```

(`execFileSync` and `path` are already imported.)

- [ ] **Step 2: Add the `writeCuratedReleaseNotes` helper**

Add this function near the other top-level helpers (e.g. above `writeTempNotes`):

```javascript
function writeCuratedReleaseNotes({ appVersion, markdown }) {
  const dir = path.resolve(process.cwd(), 'release-notes')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${appVersion}.md`)
  writeFileSync(file, `${markdown.trim()}\n`)
  execFileSync('git', ['add', file], { stdio: 'inherit' })
  console.log(
    `Wrote curated release notes: ${path.relative(process.cwd(), file)} (staged; commit with your release)`
  )
}
```

- [ ] **Step 3: Call it on a non-dry-run**

In `runCli`, the dry-run block already returns early:

```javascript
if (options.dryRun) {
  console.log('')
  console.log(finalBody.trim())
  return
}
```

Immediately after that block (before the `if (!options.yes)` confirmation), add:

```javascript
writeCuratedReleaseNotes({ appVersion: preview.appVersion, markdown: humanizedMarkdown })
```

This guarantees the file is never written during `--dry-run` and is written before the GitHub edit.

- [ ] **Step 4: Verify the script parses and lints**

Run: `node --check scripts/humanize-release-notes.mjs`
Expected: exits 0, no output.

Run: `pnpm exec eslint scripts/humanize-release-notes.mjs`
Expected: no errors. (Fix any import-order or style complaints to match the file.)

- [ ] **Step 5: Commit**

```bash
git add scripts/humanize-release-notes.mjs
git commit -m "feat(release): write curated release-notes/<version>.md and stage it"
```

---

### Task 3: Strip the dev changelog from in-app notes

**Files:**

- Modify: `apps/desktop/src/main/updater.ts` (add `stripDeveloperChangelog`, apply in `normalizeReleaseNotes` both paths)
- Test: `apps/desktop/src/main/updater.test.ts`

**Interfaces:**

- Consumes: existing `htmlToPlainText` and `normalizeReleaseNotes(info)`.
- Produces: `stripDeveloperChangelog(text: string): string` that returns `text` unchanged when there is no `Changelog` heading line, otherwise everything before that line (trimmed). `normalizeReleaseNotes` applies it after `htmlToPlainText` in both the string and array-entry paths.

- [ ] **Step 1: Write the failing tests**

Add to `apps/desktop/src/main/updater.test.ts` inside the `describe('updater', ...)` block, mirroring the existing `update-available` string test (around line 196):

```typescript
it('strips the developer changelog from string release notes', async () => {
  const updater = await loadUpdater()
  updater.initializeUpdater()
  mocks.autoUpdater.emit('update-available', {
    version: '1.2.4',
    releaseNotes:
      '<h2>Fixes</h2><ul><li>Sync fix</li></ul><h2>Changelog</h2><p>Full Changelog: https://x</p><p>#123 title @a</p>'
  })
  expect(updater.getUpdateState().releaseNotes).toBe('Fixes\n• Sync fix')
})

it('strips the developer changelog from array release notes', async () => {
  const updater = await loadUpdater()
  updater.initializeUpdater()
  mocks.autoUpdater.emit('update-available', {
    version: '1.2.4',
    releaseNotes: [
      { note: '<h2>Fixes</h2><ul><li>Sync fix</li></ul><h2>Changelog</h2><p>#1 x</p>' }
    ]
  })
  expect(updater.getUpdateState().releaseNotes).toBe('Fixes\n• Sync fix')
})

it('leaves curated-only notes untouched', async () => {
  const updater = await loadUpdater()
  updater.initializeUpdater()
  mocks.autoUpdater.emit('update-available', {
    version: '1.2.4',
    releaseNotes: '<h2>New Features</h2><ul><li>Calendar sync</li></ul>'
  })
  expect(updater.getUpdateState().releaseNotes).toBe('New Features\n• Calendar sync')
})
```

(Use the same `loadUpdater` / `mocks` helpers the existing tests use — match their exact setup, including any `beforeEach`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memry/desktop test:main`
Expected: the two "strips the developer changelog" cases FAIL (output still contains `Changelog` / `#123`). The "leaves curated-only notes untouched" case may already pass.

- [ ] **Step 3: Add the `stripDeveloperChangelog` helper**

In `apps/desktop/src/main/updater.ts`, add above `normalizeReleaseNotes`:

```typescript
function stripDeveloperChangelog(text: string): string {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.trim().toLowerCase() === 'changelog')
  if (index === -1) {
    return text
  }
  return lines.slice(0, index).join('\n').trimEnd()
}
```

- [ ] **Step 4: Apply it in `normalizeReleaseNotes`**

Change the string path:

```typescript
if (typeof releaseNotes === 'string') {
  return stripDeveloperChangelog(htmlToPlainText(releaseNotes)) || null
}
```

Change the array path's map body:

```typescript
const combined = releaseNotes
  .map((entry) => {
    const heading = entry.version ? `${formatAppVersionForDisplay(entry.version)}\n` : ''
    return `${heading}${stripDeveloperChangelog(htmlToPlainText(entry.note ?? ''))}`.trim()
  })
  .filter(Boolean)
  .join('\n\n')
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:main`
Expected: PASS (new cases plus the pre-existing `update-available` / `update-downloaded` tests, which contain no `Changelog` line and are unaffected).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/updater.ts apps/desktop/src/main/updater.test.ts
git commit -m "fix(desktop): hide developer changelog from in-app update notes"
```

---

## Final verification (after all tasks)

- [ ] `node --test scripts/release-notes-utils.test.mjs` — PASS
- [ ] `pnpm --filter @memry/desktop test:main` — PASS
- [ ] `pnpm --filter @memry/desktop typecheck:node` — clean
- [ ] `pnpm lint` — clean for touched files
- [ ] `git diff --check` — no whitespace errors

## Notes for the PR

- No PR numbers in user-facing bullets; devs keep the full `## Changelog` on the GitHub release page.
- `release-notes/<version>.md` is the committed source of truth for the in-app dialog.
- Docs gate: this touches `apps/desktop` — run `pnpm docs:impact --base <base_commit> --strict`; if it flags `missing-docs`, either add a short note under `apps/docs/src/**` or use `MEMRY_DOCS_IMPACT_SKIP=1` for this non-user-doc change with a one-line reason.
