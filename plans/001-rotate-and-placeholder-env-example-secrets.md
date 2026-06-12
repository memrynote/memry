# Plan 001: Remove real secret values from the committed `apps/landing/.env.example`, rotate the exposed credentials, and replace them with placeholders

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 86ee0cd1..HEAD -- apps/landing/.env.example .gitignore`
> If `apps/landing/.env.example` changed since this plan was written, compare
> the "Current state" notes against the live file before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **SECURITY HANDLING**: This plan concerns leaked credentials. Do NOT paste
> any credential **value** into commits, the rotation tracking note, the PR,
> or the linked issue. Refer to each credential by **name and type only**
> (e.g. "Resend API key"). The values are live in git history; rotation is the
> real fix, not deletion.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `86ee0cd1`, 2026-06-12
- **Issue**: https://github.com/memrynote/memry/issues/542

## Why this matters

`apps/landing/.env.example` is **committed to a public GitHub repo** (`memrynote/memry`) and contains **non-empty, real secret-shaped values**, not placeholders. An example/template file is supposed to show contributors _which_ variables to set, with empty or obviously-fake values. Shipping real keys in it means anyone reading the public repo (or its history) has those credentials. Even "sandbox"/dev keys are abusable: the Resend API key can send email as the project's domain, and the Paddle sandbox key + checkout-token secret expose the billing integration. Because the values are already in git history, editing the file is not enough — **the exposed credentials must be rotated** at their providers, and the example file must be reduced to placeholders so this can't recur.

## Current state

- `apps/landing/.env.example` is tracked in git (confirmed: `git ls-files apps/landing/.env.example` returns the path).
- The real `apps/landing/.env` and `apps/desktop/.env` are **gitignored and untracked** (`.gitignore:20` is `.env*`) — those are fine, leave them alone.
- The committed `.env.example` has these variables with **non-empty values** (verified by length, values not printed here). The ones that are genuinely sensitive and must be treated as exposed credentials:
  - `RESEND_API_KEY` — Resend transactional-email API key (server secret).
  - `RESEND_SEGMENT_ID` — Resend audience/segment identifier (semi-sensitive).
  - `RESEND_WEBHOOK_SECRET` — currently **empty** in the file; leave as a placeholder.
  - `PADDLE_SANDBOX_API_KEY` — Paddle sandbox server API key (server secret).
  - `PADDLE_CHECKOUT_TOKEN_SECRET` — secret used to sign checkout tokens (server secret).
- These variables in the same file are **NOT secrets** and may keep illustrative values (do not treat as exposed): `VITE_SYNC_SERVER_URL` (a URL), `PADDLE_ENVIRONMENT` / `VITE_PADDLE_ENVIRONMENT` (the literal `sandbox`), `VITE_PADDLE_CLIENT_TOKEN` (Paddle **client-side** token, by design shipped to the browser), `PADDLE_PRICE_*` (public price identifiers), `PADDLE_CHECKOUT_URL`. You may still convert them to placeholders for consistency, but they are not part of the rotation list.

Repo convention for env templates: keys are documented with a comment line above each, then `KEY=`. Match that style. There is no `.env.example` for `apps/desktop` or `apps/sync-server` — do not create them in this plan (out of scope).

## Commands you will need

| Purpose                                       | Command                                                                                                   | Expected on success  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------- |
| Confirm tracked                               | `git ls-files apps/landing/.env.example`                                                                  | prints the path      |
| Confirm real .env untracked                   | `git ls-files apps/landing/.env apps/desktop/.env`                                                        | prints nothing       |
| Inspect value lengths without printing values | `git show HEAD:apps/landing/.env.example \| grep -E '^[A-Z_]+=' \| awk -F= '{print $1" len="length($2)}'` | lists keys + lengths |
| Lint (landing)                                | `pnpm lint:landing`                                                                                       | exit 0               |

## Scope

**In scope** (modify):

- `apps/landing/.env.example` — replace sensitive values with placeholders.
- `plans/SECRET-ROTATION.md` (create) — a checklist tracking which credentials were rotated. Names/types only, never values.

**Out of scope** (do NOT touch):

- `apps/landing/.env`, `apps/desktop/.env` — already gitignored; not in git.
- Any rewrite of git history (`git filter-repo`, BFG). History scrubbing is a separate, higher-risk operation the maintainer must run deliberately; this plan makes rotation the mitigation instead. Note it in the rotation file as a recommended follow-up, do not perform it.
- Creating `.env.example` files for other apps.
- Any source code that reads these env vars.

## Git workflow

- Branch: `security/env-example-placeholders` (from `origin/main`).
- Commit message (conventional commits, matching `git log`): `chore(landing): replace real secrets in .env.example with placeholders`.
- Do NOT push or open a PR unless the operator instructed it. Per repo `CLAUDE.md`, do not add `Co-Authored-By` trailers.

## Steps

### Step 1: Replace the sensitive values with placeholders

In `apps/landing/.env.example`, set each **sensitive** variable's value to an obvious placeholder that documents the format without being a real key. Use this style (keep the existing explanatory comments above each key):

```
RESEND_API_KEY=re_your_resend_api_key_here
RESEND_SEGMENT_ID=your_resend_segment_id_here
RESEND_WEBHOOK_SECRET=
PADDLE_SANDBOX_API_KEY=your_paddle_sandbox_api_key_here
PADDLE_CHECKOUT_TOKEN_SECRET=generate_a_random_secret_here
```

Leave the non-secret variables (`VITE_SYNC_SERVER_URL`, `PADDLE_ENVIRONMENT`, `VITE_PADDLE_ENVIRONMENT`, `VITE_PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_*`, `PADDLE_CHECKOUT_URL`) as they are.

**Verify**: `git show HEAD:apps/landing/.env.example | grep -E 'RESEND_API_KEY|PADDLE_SANDBOX_API_KEY|PADDLE_CHECKOUT_TOKEN_SECRET'` shows the OLD values in HEAD, and `grep -E 'RESEND_API_KEY|PADDLE_SANDBOX_API_KEY|PADDLE_CHECKOUT_TOKEN_SECRET' apps/landing/.env.example` shows the new placeholder values in the working tree. They must differ.

### Step 2: Create the rotation checklist

Create `plans/SECRET-ROTATION.md`:

```markdown
# Secret rotation — exposed in committed apps/landing/.env.example

These credentials were committed (with real values) to the public repo and are
in git history. Editing the file does not revoke them. Rotate each at its
provider, then update the local untracked `apps/landing/.env` with the new value.
Do NOT record any value here.

- [ ] Resend API key — regenerate at https://resend.com/api-keys, revoke the old key
- [ ] Resend segment ID — confirm whether it is sensitive; rotate/recreate segment if so
- [ ] Paddle sandbox API key — regenerate in Paddle sandbox dashboard (Developer Tools → Authentication), revoke old
- [ ] Paddle checkout-token secret — regenerate the signing secret, update server config
- [ ] (Recommended follow-up, maintainer-run) Scrub the values from git history with git filter-repo/BFG, then force-push and rotate again if needed

Owner: <fill in> Date opened: 2026-06-12
```

**Verify**: `test -f plans/SECRET-ROTATION.md && echo ok` → `ok`.

### Step 3: Confirm no secret values are in your changes

**Verify**: `git diff --staged apps/landing/.env.example plans/SECRET-ROTATION.md` (after `git add`) — read it and confirm the diff only _removes_ real values and _adds_ placeholders/checklist text. No real credential value appears in any added line.

## Test plan

No unit tests apply (config/doc change). Verification is the grep/diff checks above plus lint.

- **Verify lint unaffected**: `pnpm lint:landing` → exit 0.

## Done criteria

ALL must hold:

- [ ] `apps/landing/.env.example` sensitive keys (`RESEND_API_KEY`, `RESEND_SEGMENT_ID`, `PADDLE_SANDBOX_API_KEY`, `PADDLE_CHECKOUT_TOKEN_SECRET`) contain placeholder values, not the originals.
- [ ] `plans/SECRET-ROTATION.md` exists with the rotation checklist.
- [ ] `git status` shows only `apps/landing/.env.example` and `plans/SECRET-ROTATION.md` (plus `plans/README.md`) modified/created.
- [ ] No real credential value appears anywhere in the diff.
- [ ] `pnpm lint:landing` exits 0.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- `apps/landing/.env.example` has already been converted to placeholders (the finding was fixed independently) — mark this plan REJECTED in the index with that note.
- You find that `apps/landing/.env` or `apps/desktop/.env` IS tracked in git (`git ls-files` returns them) — that is a more severe finding than this plan covers; report it.
- The drift check shows the file changed since `86ee0cd1` and the variable set no longer matches "Current state".

## Maintenance notes

- The real remediation is **rotation**, completed outside this repo; this plan only prevents recurrence and tracks the work. A reviewer should confirm the rotation checklist is being actioned, not just merged.
- Consider adding a CI secret-scanner (e.g. gitleaks) so a real value in any `.env*` example fails the build. The repo already has `scripts/check-staged-secrets.mjs` (`pnpm check:staged-secrets`) — verify whether it scans `.env.example`; if not, extending it is a sensible follow-up (out of scope here).
- A reviewer should scrutinize that no _new_ real value was introduced and that non-secret illustrative values weren't accidentally broken (they feed the landing dev experience).
