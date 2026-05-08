Polish and publish a Memry desktop release from the current date draft.

## Input

```text
$ARGUMENTS
```

`$ARGUMENTS` may be empty or a draft tag such as `v2026-05-09`.

## Goal

Turn the current Release Drafter body into a concise, human release summary based on PR
descriptions, patch the draft release, dispatch the existing publish workflow, and watch it until it
finishes.

## Rules

- Keep the stable release contract: tag `vYYYY-MM-DD[.N]`, name `Memry vYYYY-MM-DD[.N]`.
- Never build or upload release assets in this command; assets are created only by
  `.github/workflows/release.yml`.
- Never publish a non-draft release.
- Never include Codex, Claude, OpenAI, T3Code, Cursor, or AI-tool branding in the release notes.
- Use concise, user-facing language. Explain product impact, not implementation trivia.
- Keep PR numbers in every bullet as `(#123)`.
- Use emojis intentionally, not on every word.
- Stop before publishing if the draft has existing assets, unless they are clearly stale publish
  artifacts from a failed release run and the user explicitly approves cleanup.

## Step 0 - Preflight

1. Run `git status --short --branch`.
2. Run `gh auth status`.
3. Resolve repository metadata:
   - `gh repo view --json nameWithOwner,defaultBranchRef`
   - Treat the default branch as `main` unless the command output says otherwise.
4. Ensure local branch state is not needed for the release body. This command reads GitHub draft
   releases and merged PR metadata; it should not require local source edits.

## Step 1 - Resolve the draft

If `$ARGUMENTS` contains a tag, use it:

```bash
gh release view "$TAG" --json databaseId,tagName,name,isDraft,targetCommitish,body,assets,url
```

If `$ARGUMENTS` is empty, find the latest date draft:

```bash
gh release list --limit 100 --json tagName,name,isDraft,createdAt,publishedAt
```

Select the newest draft whose `tagName` matches:

```text
^v20[0-9]{2}-[0-9]{2}-[0-9]{2}(\\.[2-9][0-9]*)?$
```

Stop if no matching draft exists.

Validate:

- `isDraft` is `true`.
- `tagName` matches the date-tag pattern.
- `name` is either the tag or `Memry <tag>`.
- `assets` is empty.

## Step 2 - Check draft freshness

1. Read the draft `targetCommitish`.
2. Read the current default branch commit:

```bash
gh api "repos/{owner}/{repo}/git/ref/heads/main" --jq '.object.sha'
```

3. If `targetCommitish` is not the current default branch SHA or branch name, inspect the latest
   `Release Drafter` workflow run:

```bash
gh run list --workflow "Release Drafter" --branch main --limit 5
```

Stop if the latest run is still in progress or failed.

## Step 3 - Gather PR source material

1. Parse PR numbers from the draft body with `(#123)`.
2. For each PR number, run:

```bash
gh pr view 123 --json number,title,body,author,labels,mergedAt,url
```

3. Use the PR body as the primary source. Ignore template checklist noise, empty headings,
   screenshots-only sections, and CI/test-plan boilerplate.
4. If a PR has no useful body, fall back to the title.
5. If the draft includes direct commits without PR numbers, keep them only if they are clearly
   release-relevant; otherwise omit them from the public summary.

## Step 4 - Write the polished body

Rewrite the draft body into this shape:

```markdown
## Highlights

- 🚀 Human-facing summary of the biggest shipped capability. (#123)

## What's Changed

### 🚀 Features and Improvements

- Improve something users can understand from the PR body. (#123)

### 🐛 Bug Fixes

- Fix a concrete behavior or reliability issue. (#124)

### 📝 Documentation

- Clarify a user-facing or contributor-facing workflow. (#125)

**Full Changelog**: https://github.com/OWNER/REPO/compare/PREVIOUS_TAG...TAG
```

Formatting rules:

- Keep the `Full Changelog` URL from the draft when present.
- Keep only sections that have bullets.
- Use at most 3 highlight bullets.
- Prefer one bullet per PR.
- Group labels from Release Drafter when obvious; otherwise infer the closest section from the PR
  body.
- Do not mention tests, lint, refactors, or CI unless that is the user-visible shipped change.

## Step 5 - Patch the draft

1. Save the final body to a temp file.
2. Patch the release:

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

Use the actual release name format: `Memry vYYYY-MM-DD[.N]`.

3. Re-read the release and confirm the body was patched:

```bash
gh release view "$TAG" --json name,isDraft,body,assets,url
```

## Step 6 - Publish through the existing workflow

Dispatch the existing release workflow:

```bash
gh workflow run release.yml --ref main -f draft_tag="$TAG"
```

Find and watch the run:

```bash
gh run list --workflow Release --branch main --limit 5
gh run watch RUN_ID --exit-status
```

If the run fails:

1. Run `gh run view RUN_ID --log-failed`.
2. Report the failing job and the first actionable error.
3. Do not retry unless the failure is clearly transient.

## Step 7 - Final checks

After the workflow succeeds:

```bash
gh release view "$TAG" --json name,isDraft,isPrerelease,assets,url
gh release list --limit 20 --json tagName,isLatest --jq ".[] | select(.tagName == \"$TAG\")"
```

Confirm:

- `isDraft` is `false`.
- `isPrerelease` is `false`.
- the matching release-list row has `isLatest` set to `true`.
- assets are present.
- release name is `Memry TAG`.

Then report the release URL and asset count.
