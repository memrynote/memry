---
tags:
  - tech/git
  - reference
area: Learning
level: intermediate
language: shell
---
## Daily

```bash
git switch -c feat/inbox-snooze
# work...
git add -p
git commit -m "feat: snooze inbox items with reason"
git push -u origin HEAD
gh pr create --fill
```

## Rebase, don't merge

Until the branch lands. After that, it's history.

#tech/git
