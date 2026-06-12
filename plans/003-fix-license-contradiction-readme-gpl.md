# Plan 003: Make the README state GPL-3.0 to match the authoritative LICENSE file and all package.json fields

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 86ee0cd1..HEAD -- README.md LICENSE package.json`
> If any changed since this plan was written, re-confirm the "Current state"
> facts before proceeding.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `86ee0cd1`, 2026-06-12
- **Issue**: https://github.com/memrynote/memry/issues/544

## Why this matters

The repo gives contradictory licensing signals on a **public, pre-launch** project. The `LICENSE` file is the **GNU General Public License v3**, and every `package.json` (root + all 11 workspace packages) declares `"license": "GPL-3.0"`. But `README.md` shows an **MIT** badge and an **MIT** footer. A reader — or a company evaluating adoption — who trusts the README's MIT badge would make a wrong assumption about a copyleft project; the difference between permissive and copyleft is exactly the kind of thing that has legal consequences. The maintainer has confirmed **GPL-3.0 is the intended license**, so the fix is to correct the README to match the authoritative `LICENSE` file. (This is a one-directional fix: make the docs match the license, not the reverse.)

## Current state

Authoritative (do NOT change): `LICENSE` begins with `GNU GENERAL PUBLIC LICENSE / Version 3, 29 June 2007`. All `package.json` files declare `"license": "GPL-3.0"`.

Wrong (to fix) in `README.md`:

- Line 14, the badge:
  ```
  [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
  ```
- Line 166, the footer:
  ```
  MIT © Memry contributors
  ```

There may be other "MIT" mentions; Step 1 greps for them so none are missed.

SPDX note: the correct SPDX identifier is `GPL-3.0-only` (or `GPL-3.0-or-later`). The shields.io badge label should read `GPL--3.0` (the double-dash renders as a single dash in shields.io). The package.json files use the older `GPL-3.0` string — leave those as-is (changing them is out of scope and risks touching 12 files for no functional gain).

## Commands you will need

| Purpose                                | Command                                                    | Expected on success                            |
| -------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| Find every MIT mention in README       | `grep -n "MIT" README.md`                                  | lists the lines to fix                         |
| Confirm LICENSE is GPL                 | `head -3 LICENSE`                                          | shows "GNU GENERAL PUBLIC LICENSE / Version 3" |
| Confirm package license                | `node -e "console.log(require('./package.json').license)"` | prints `GPL-3.0`                               |
| Docs build (markdown sanity, optional) | `pnpm docs:build`                                          | exit 0                                         |

## Scope

**In scope** (modify):

- `README.md` — replace MIT badge and footer (and any other MIT mention found) with GPL-3.0.

**Out of scope** (do NOT touch):

- `LICENSE` — it is correct.
- Any `package.json` `"license"` field — already `GPL-3.0`.
- `apps/docs/**`, landing site footers, or any other surface — if those also say MIT, note it for a follow-up but do not change them here (keeps this plan a single-file, trivially reviewable change). Report any you find.

## Git workflow

- Branch: `docs/license-gpl-consistency` (from `origin/main`).
- Commit message: `docs(readme): correct license to GPL-3.0 to match LICENSE file`.
- Do NOT push or open a PR unless instructed. No `Co-Authored-By` trailers.

## Steps

### Step 1: Enumerate every MIT mention

Run `grep -n "MIT" README.md`. Expect at least lines 14 (badge) and 166 (footer). Note every line the grep returns; all must be fixed.

**Verify**: command runs and you have the full list.

### Step 2: Fix the badge (line 14)

Replace:

```
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
```

with:

```
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
```

### Step 3: Fix the footer (line 166) and any other mentions

Replace:

```
MIT © Memry contributors
```

with:

```
GPL-3.0 © Memry contributors
```

Apply the analogous fix to any other MIT line Step 1 surfaced (e.g. a "License: MIT" heading). The "## License" body text that points to `LICENSE` and says "See [LICENSE] for the legal text" can stay.

**Verify**: `grep -n "MIT" README.md` → **no matches** (or only matches that are demonstrably unrelated to licensing, which you must call out in your report).

### Step 4: Markdown sanity

**Verify**: `pnpm docs:build` → exit 0 (the docs site build also lints markdown; this catches a broken badge link). If `docs:build` is unrelated to README and errors for an unrelated reason, fall back to confirming the README renders by eye and note it.

## Test plan

No code tests. Verification is the grep returning no MIT matches plus a clean docs build.

## Done criteria

ALL must hold:

- [ ] `grep -n "MIT" README.md` returns no licensing-related matches.
- [ ] README badge reads GPL-3.0 and links to `LICENSE`.
- [ ] README footer reads `GPL-3.0 © Memry contributors`.
- [ ] `LICENSE` and all `package.json` license fields are unchanged.
- [ ] `git status` shows only `README.md` (plus `plans/README.md`) modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The README already says GPL-3.0 (fixed independently) — mark REJECTED in the index.
- The `LICENSE` file is no longer GPL-3.0, or `package.json` no longer says `GPL-3.0` — the authoritative source changed; the intended license decision (GPL-3.0) may have been reversed. Stop and confirm before editing.

## Maintenance notes

- If the landing site or `apps/docs` also advertises a license, align it in a follow-up so all public surfaces agree.
- A reviewer only needs to confirm the README now matches `LICENSE`; this is intentionally a one-file change.
