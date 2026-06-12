# Plan 004: Align the documented Node/pnpm versions with the versions the repo actually pins

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 86ee0cd1..HEAD -- README.md docs/CONTRIBUTING.md package.json .nvmrc`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `86ee0cd1`, 2026-06-12
- **Issue**: https://github.com/memrynote/memry/issues/545

## Why this matters

A first-time contributor reads the setup docs, installs the stated toolchain, and runs `pnpm install`. The docs name three _different_ pnpm versions, none of which is the one the repo enforces — so the very first command can fail with a packageManager mismatch. This is pure onboarding friction with a trivial fix: make the docs state the versions the repo actually pins.

## Current state

- Root `package.json:5` pins the package manager: `"packageManager": "pnpm@11.5.2"`. This is authoritative — corepack enforces it.
- `.nvmrc` contains `24` (Node 24.x).
- `README.md:124` says: `Requires Node 20+ and pnpm 9+.`
- `docs/CONTRIBUTING.md:13` says: `- [Node.js](https://nodejs.org/) (v24.x; use \`.nvmrc\`)` — Node is fine.
- `docs/CONTRIBUTING.md:14` says: `- [pnpm](https://pnpm.io/) (v10.30+)` — wrong major.

So: README understates both Node (says 20+, repo uses 24) and pnpm (says 9+, repo pins 11.5.2); CONTRIBUTING's pnpm line says 10.30+ (also below the pinned 11.5.2). The Node line in CONTRIBUTING is correct.

## Commands you will need

| Purpose             | Command                                                                             | Expected on success |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------- |
| Confirm pinned pnpm | `node -e "console.log(require('./package.json').packageManager)"`                   | `pnpm@11.5.2`       |
| Confirm Node pin    | `cat .nvmrc`                                                                        | `24`                |
| Find version claims | `grep -rn "pnpm 9\|pnpm@\|v10.30\|Node 20\|Node.js" README.md docs/CONTRIBUTING.md` | lists the lines     |

## Scope

**In scope** (modify):

- `README.md` — the "Requires Node … and pnpm …" line (around line 124).
- `docs/CONTRIBUTING.md` — the pnpm prerequisite line (line 14).

**Out of scope** (do NOT touch):

- `.nvmrc`, `package.json` — they are the source of truth; this plan makes docs match them, not the reverse.
- The CONTRIBUTING Node line (line 13) — already correct.
- Pinning `.nvmrc` to a more specific patch version — a separate, optional change; do not bundle it here.

## Git workflow

- Branch: `docs/align-toolchain-versions` (from `origin/main`).
- Commit message: `docs: align documented Node/pnpm versions with pinned toolchain`.
- Do NOT push or open a PR unless instructed. No `Co-Authored-By` trailers.

## Steps

### Step 1: Fix the README requirement line

In `README.md` (around line 124), replace:

```
Requires Node 20+ and pnpm 9+.
```

with:

```
Requires Node 24 (see `.nvmrc`) and pnpm 11 (the repo pins `pnpm@11.5.2` via corepack).
```

### Step 2: Fix the CONTRIBUTING pnpm line

In `docs/CONTRIBUTING.md` line 14, replace:

```
- [pnpm](https://pnpm.io/) (v10.30+)
```

with:

```
- [pnpm](https://pnpm.io/) (v11.5.2 — the repo pins it via `packageManager`; corepack will use the right version automatically)
```

### Step 3: Verify no stale version claims remain

**Verify**: `grep -rn "pnpm 9\|v10.30\|Node 20" README.md docs/CONTRIBUTING.md` → **no matches**.

## Test plan

No code tests. Verification is the grep above plus an optional docs build:

- **Verify (optional)**: `pnpm docs:build` → exit 0.

## Done criteria

ALL must hold:

- [ ] `grep -rn "pnpm 9\|v10.30\|Node 20" README.md docs/CONTRIBUTING.md` returns no matches.
- [ ] README and CONTRIBUTING name pnpm 11.5.2 / Node 24, consistent with `package.json` and `.nvmrc`.
- [ ] `git status` shows only `README.md` and `docs/CONTRIBUTING.md` (plus `plans/README.md`) modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- The docs already state pnpm 11 / Node 24 (fixed independently) — mark REJECTED.
- `package.json` no longer pins `pnpm@11.5.2` or `.nvmrc` no longer says `24` — the source of truth moved; re-derive the correct numbers before editing.

## Maintenance notes

- When the toolchain is bumped (e.g. pnpm 12 or Node 26), these two doc lines must move with it. Consider a follow-up that references `.nvmrc`/`packageManager` instead of hardcoding numbers, so the docs can't drift again.
