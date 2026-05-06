# User Release Notes

`CHANGELOG.md` stays technical. User-facing release notes come from fragments in
`docs/releases/unreleased/`.

Add one fragment for each user-visible PR:

```md
---
category: improvement
emoji: '🧱'
title: 'Improved Editor Blocks'
---

Dragging across note and journal blocks now selects the blocks themselves.
```

Rules:

- `category` must be `new`, `improvement`, `fix`, `security`, or `maintenance`.
- `emoji` must contain exactly one emoji.
- `title` should name the user-visible change.
- Body must be one user-facing sentence ending with a period.
- Avoid implementation details, commit IDs, and raw technical wording.

Release Drafter creates a draft release after changes land on `main`. The manual stable release
workflow renders fragments changed since the previous release tag into that draft body before
publishing the actual date tag, such as `v2026-05-07` or `v2026-05-07.2`.
