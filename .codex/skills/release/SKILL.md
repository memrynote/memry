---
name: release
description: Polish and publish Memry desktop releases. Use when the user asks to prepare, beautify, summarize, polish, publish, or ship a GitHub draft release for Memry; when a Memry date draft release should be rewritten from PR descriptions; or when release assets should be produced only through the existing publish workflow.
---

# Memry Release

Use this skill to publish a Memry desktop release from the current date draft.

## Contract

- Keep stable tags as `vYYYY-MM-DD[.N]`.
- Keep release names as `Memry vYYYY-MM-DD[.N]`.
- Keep draft updates asset-free.
- Create release assets only through `.github/workflows/release.yml`.
- Never publish a non-draft release.
- Never include AI/tool branding in release notes.
- Keep every public release-note bullet tied to a PR number as `(#123)` when a PR exists.

## Inputs

- Optional draft tag from the user, for example `v2026-05-09`.
- If no tag is given, resolve the newest draft matching `^v20[0-9]{2}-[0-9]{2}-[0-9]{2}(\\.[2-9][0-9]*)?$`.

## Preflight

1. Run `git status --short --branch`.
2. Run `gh auth status`.
3. Run `gh repo view --json nameWithOwner,defaultBranchRef`.
4. Resolve the draft:

```bash
gh release view "$TAG" --json databaseId,tagName,name,isDraft,targetCommitish,body,assets,url
```

If no tag was provided:

```bash
gh release list --limit 100 --json tagName,name,isDraft,createdAt,publishedAt
```

Stop if:

- no matching draft exists,
- the release is not a draft,
- the tag is not a Memry date tag,
- the draft already has assets.

## Check Freshness

Read the default branch SHA:

```bash
gh api "repos/{owner}/{repo}/git/ref/heads/main" --jq '.object.sha'
```

If the draft `targetCommitish` is not the current default branch SHA or branch name, inspect the
latest Release Drafter run:

```bash
gh run list --workflow "Release Drafter" --branch main --limit 5
```

Stop if the latest relevant run is still in progress or failed.

## Gather PR Material

1. Parse PR numbers from the draft body with `(#123)`.
2. For each PR, read:

```bash
gh pr view 123 --json number,title,body,author,labels,mergedAt,url
```

3. Use PR descriptions as the primary source.
4. Ignore template checklists, empty headings, screenshot-only sections, and CI/test-plan boilerplate.
5. Fall back to the PR title only when the body has no useful release-note material.
6. Keep direct commits only when they are clearly release-relevant.

## Rewrite Notes

Use this shape:

```markdown
## Highlights

- 🚀 Human-facing summary of the biggest shipped capability. (#123)

## What's Changed

### 🚀 Features and Improvements

- Improve something users can understand from the PR body. (#123)

### 🐛 Bug Fixes

- Fix a concrete behavior or reliability issue. (#124)

**Full Changelog**: https://github.com/OWNER/REPO/compare/PREVIOUS_TAG...TAG
```

Rules:

- Preserve the draft `Full Changelog` URL when present.
- Keep only sections that have bullets.
- Use at most 3 highlight bullets.
- Prefer one bullet per PR.
- Explain product impact, not implementation trivia.
- Do not mention tests, lint, refactors, or CI unless that is the user-visible shipped change.

## Patch Draft

Save the final body to a temp file, then patch the draft:

```bash
gh api \
  --method PATCH \
  "repos/{owner}/{repo}/releases/RELEASE_ID" \
  -F name="Memry TAG" \
  -F tag_name="TAG" \
  -F draft=true \
  -F prerelease=false \
  -F body=@/tmp/memry-release-body.md
```

Use the real release name, for example `Memry v2026-05-09`.

Confirm the patch:

```bash
gh release view "$TAG" --json name,isDraft,body,assets,url
```

## Publish

Dispatch the existing workflow:

```bash
gh workflow run release.yml --ref main -f draft_tag="$TAG"
```

Find and watch the run:

```bash
gh run list --workflow Release --branch main --limit 5
gh run watch RUN_ID --exit-status
```

If the run fails, inspect failed logs with `gh run view RUN_ID --log-failed`, report the first
actionable error, and do not retry unless the failure is clearly transient.

## Final Check

After the workflow succeeds:

```bash
gh release view "$TAG" --json name,isDraft,isPrerelease,assets,url
gh release list --limit 20 --json tagName,isLatest --jq ".[] | select(.tagName == \"$TAG\")"
```

Confirm:

- `isDraft` is `false`,
- `isPrerelease` is `false`,
- the release-list row has `isLatest: true`,
- assets are present,
- release name is `Memry TAG`.

Report the release URL and asset count.
