# Health

The Health tab is the inbox's actionable punch list — failed sync jobs, broken source URLs, and items that need user input.

<!-- screenshot: inbox health tab with failed jobs and retry buttons -->

## What Shows Up

The Health view collects:

- **Failed sync jobs** — items that couldn't push, pull, or upload an attachment
- **Broken source URLs** — saved links that no longer resolve (404, DNS failure)
- **Missing fields** — items captured without required metadata (rare; usually from older builds)
- **Stale items** — past the threshold from [Settings → Tasks](/user-guide/settings#tasks)
- **Quota warnings** — when the vault is approaching its storage limit

If everything is healthy, the tab is empty.

## Failed Sync Jobs

Each failed job shows:

- The item the job was for (with a link)
- The error message
- A **Retry** button
- The number of retry attempts so far

Retrying re-queues the job. If retries keep failing, the underlying cause is likely:

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Network unreachable" | Offline | Reconnect |
| "Unauthorized" | Sign-in expired | Sign in again |
| "Quota exceeded" | Vault at storage limit | Free up space or upgrade |
| "Blob hash mismatch" | Rare corruption | Push from the source device |

## Broken Source URLs

Saved links that fail an integrity check (HEAD request returns 4xx / 5xx, or DNS fails) get a broken-URL chip.

Per-item actions:

- **Open archived copy** (if available)
- **Update URL** (paste a new link)
- **Convert to note** (capture whatever you remember as content)
- **Archive** (acknowledge it's gone)

## Missing Fields

Older builds occasionally captured items with required fields missing. The Health tab surfaces them and offers a one-click form to fill in missing metadata.

You won't see these on a fresh install — they're a migration artifact.

## Stale Items

Items older than the **Stale Inbox Days** setting show a stale chip. Stale doesn't break anything; it's a periodic reminder.

The default is 30 days; tune it in [Settings → Tasks](/user-guide/settings#tasks).

## Quota Warnings

Approaching the vault's storage limit triggers a warning row. From there:

- See storage breakdown by category — same as [Settings → Vault](/user-guide/settings#vault)
- Find largest items (helpful for attachment cleanup)
- Empty Trash and clear orphaned attachments

## When to Visit

- After a long offline stretch (sync jobs to retry)
- After a sign-in or device-rotation event (auth-related failures)
- Periodically (stale items, quota)

A quick weekly pass through Health keeps things tidy.

## See Also

- [How Sync Works](/user-guide/sync/how-sync-works)
- [Conflict & Health](/user-guide/sync/conflict-health) — the sync-side health view (different surface, similar idea)
- [Settings → Vault](/user-guide/settings#vault)
