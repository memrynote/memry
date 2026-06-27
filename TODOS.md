# TODOS

## Inbox folder suggestion — async staleness / cancellation

- **What:** Guard the suggestion request lifecycle in the inbox drawer — cancel/ignore in-flight results when the active item changes or the drawer closes; de-dupe concurrent requests.
- **Why:** The folder-centric scorer (eng review, D8) blends more signals than the old first-match path, so the async compute window widens — more room for a stale render when a user switches items quickly.
- **Pros:** Prevents a stale-result render; closes a lifecycle gap the scoring rework didn't touch.
- **Cons:** May be partly redundant — react-query per-item keying (`inboxKeys.suggestions(itemId)`) likely already covers the common case.
- **Context:** Verify what react-query keying already cancels/supersedes before building. If gaps remain, add a main-process race/staleness guard. Surfaced by Codex outside-voice (#14) during the inbox-suggestion eng review.
- **Depends on / blocked by:** Best done after the folder-centric scorer lands (the heavier compute is what widens the window).
