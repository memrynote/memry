# M1 Phase B — Electron Freeze + Spike Cleanup

Temiz session prompt. Phase A tamamlandıktan sonra başlat.

---

## PROMPT START

You are implementing **Phase B of Milestone M1** for Memry's Electron→Tauri migration.

### Context

**Repo:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk`
**Branch:** `spike/tauri-risk-discovery`
**Parent spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
**Implementation plan:** `docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md`

### Prerequisite

**Phase A must be complete.** Verify:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
test -d apps/desktop-tauri/src-tauri/src || echo "PHASE A INCOMPLETE — STOP"
git log --oneline | grep -c "m1(scaffold)"   # expect ≥ 4
```

If Phase A is not complete, STOP and report to user.

### Your scope

Execute **Tasks 5, 6** from the implementation plan. These cover:

- **Task 5:** Freeze `apps/desktop/` with FROZEN banner in README + CI path-guard workflow
- **Task 6:** Delete `spikes/tauri-risk-discovery/` (throwaway prototype code; findings preserved in `docs/spikes/tauri-risk-discovery/`)

### Methodology

1. **Invoke `superpowers:using-superpowers`** first.
2. **Read Tasks 5 and 6 fully** from the plan file before starting.
3. **Verification-before-completion:** Before deleting anything in Task 6, explicitly verify that `docs/spikes/tauri-risk-discovery/findings.md` and s1/s2/s3 reports exist (step 6.1 in the plan). Do NOT skip this check.
4. **No code changes beyond what Tasks 5-6 define.** This phase is pure cleanup + configuration.

### Constraints

- **Destructive ops:** Task 6 uses `git rm -rf spikes/tauri-risk-discovery/`. Before running, grep for any staged or uncommitted changes in that directory and abort if any exist.
- **CI workflow:** `.github/workflows/electron-freeze.yml` must have valid YAML. Test locally if you have `yamllint`; otherwise trust GitHub to validate on push.
- **README.bak preservation:** If an original `apps/desktop/README.md` existed, preserve it as `README.md.bak` (gitignored). This is required by step 5.2.
- **Label bypass is critical (spec Section "Electron freeze discipline"):** The workflow in Task 5.4 implements a two-label escape hatch — `migration/m10-cutover` for the final cutover PR and `migration/emergency-fix` for rare exceptions. Do NOT simplify the YAML to "always fail on apps/desktop/ changes" — that would deadlock the M10 cutover.
- **Manual follow-up after Phase B:** After merging the Phase B PR, Kaan must create the two labels in the repo (Settings → Labels → `migration/m10-cutover` and `migration/emergency-fix`) and restrict who can apply them via CODEOWNERS or repo branch-protection. Include this as a follow-up note in your Phase B completion report.

### TDD notes

This phase has no implementation logic — it's file manipulation + CI config. TDD does not apply. Use verification-before-completion:

- After step 5.2 (README banner): `head -5 apps/desktop/README.md` shows the FROZEN banner
- After step 5.3 (.gitignore): `grep README.md.bak apps/desktop/.gitignore` returns the entry
- After step 5.4 (workflow): `yq '.name' .github/workflows/electron-freeze.yml` returns `Electron Freeze Guard` (if yq installed; else `cat` + visual check)
- After step 6.2 (git rm): `ls spikes/tauri-risk-discovery/ 2>/dev/null` prints nothing
- After step 6.2: `ls docs/spikes/tauri-risk-discovery/findings.md` still exists

### Acceptance criteria (Phase B done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk

# Electron freeze
head -3 apps/desktop/README.md | grep -q "FROZEN"
grep -q "README.md.bak" apps/desktop/.gitignore
test -f .github/workflows/electron-freeze.yml

# Freeze guard label bypass wired up
grep -q 'migration/m10-cutover' .github/workflows/electron-freeze.yml
grep -q 'migration/emergency-fix' .github/workflows/electron-freeze.yml
grep -q 'actions/github-script' .github/workflows/electron-freeze.yml

# Spike cleanup
test ! -d spikes/tauri-risk-discovery
test -f docs/spikes/tauri-risk-discovery/findings.md
test -f docs/spikes/tauri-risk-discovery/s1-blocknote-webview.md
test -f docs/spikes/tauri-risk-discovery/s2-yjs-placement.md
test -f docs/spikes/tauri-risk-discovery/s3-db-placement.md

# Commits
git log --oneline | grep -E "m1\((freeze|cleanup)\)"   # expect 2 commits

# Other paths untouched
git diff --name-only HEAD~5..HEAD -- apps/sync-server/ packages/ | wc -l   # must be 0
```

### When done

Report:

```
Phase B complete.
Tasks covered: 5, 6
Commits: 2 (<first_hash>..<last_hash>)
Verification:
  - Electron README has FROZEN banner
  - CI workflow .github/workflows/electron-freeze.yml present with label-bypass
  - spikes/tauri-risk-discovery/ deleted
  - Spike findings preserved in docs/spikes/
  - apps/sync-server + packages untouched

REQUIRES MANUAL FOLLOW-UP by Kaan (not automatable):
  - Create label 'migration/m10-cutover' in GitHub repo settings
  - Create label 'migration/emergency-fix' in GitHub repo settings
  - Restrict label application via CODEOWNERS or repo role permissions

Next: Phase C — prompts/m1-phase-c-deps-styles.md
Blockers: <none | list>
```

### Ready

1. Invoke `superpowers:using-superpowers`.
2. Read plan Tasks 5 and 6 fully.
3. Run prerequisite check.
4. Start Task 5.

## PROMPT END
