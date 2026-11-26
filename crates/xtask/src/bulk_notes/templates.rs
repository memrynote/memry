//! The snippet and sentence tables of `apps/desktop/scripts/seed-data/bulk-notes.ts`, entry
//! for entry and in the same order (see `topics/mod.rs`).

pub(super) const ENGINEERING_SNIPPETS: &[&str] = &[
    r#"```ts
export async function drainQueue(batchSize = 64): Promise<number> {
  let drained = 0
  for (;;) {
    const batch = await queue.take(batchSize)
    if (batch.length === 0) return drained
    await Promise.all(batch.map((job) => job.run()))
    drained += batch.length
  }
}
```"#,
    r#"```sql
SELECT path, count(*) AS revisions
FROM note_history
WHERE modified_at > date('now', '-30 day')
GROUP BY path
HAVING revisions > 5
ORDER BY revisions DESC
LIMIT 25;
```"#,
    r#"```bash
# reproduce the slow path locally
pnpm build
NODE_OPTIONS=--max-old-space-size=4096 node dist/bench.js --iterations 200
```"#,
    r#"```ts
const withRetry = async <T>(fn: () => Promise<T>, attempts = 3): Promise<T> => {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      await sleep(2 ** i * 250)
    }
  }
  throw lastError
}
```"#,
];

pub(super) const OPS_SNIPPETS: &[&str] = &[
    r#"```yaml
readiness:
  path: /healthz
  initialDelaySeconds: 15
  periodSeconds: 10
  failureThreshold: 3
```"#,
    r#"```bash
# 95th percentile latency for the last hour
curl -s "$METRICS/query?q=histogram_quantile(0.95, rate(request_ms_bucket[1h]))" | jq '.data.result'
```"#,
    r#"```json
{
  "retention_days": 30,
  "max_batch_bytes": 4194304,
  "backoff": { "initial_ms": 250, "max_ms": 30000 }
}
```"#,
];

pub(super) const ANALYSIS_SNIPPETS: &[&str] = &[
    r#"```python
rolling = df.set_index("day")["value"].rolling("14d").mean()
print(rolling.describe())
```"#,
    r#"```text
baseline   p50 = 42ms   p95 = 180ms
candidate  p50 = 31ms   p95 = 96ms
delta      -26%         -47%
```"#,
];

pub(super) const LEAD_TEMPLATES: &[&str] = &[
    "Picking this back up because {system} {action}.",
    "Notes from the pass over {subject_lower}: {system} {action}.",
    "Short version — {system} {action}, and the fix is smaller than it looked.",
    "This is the working set of notes on {subject_lower}. Nothing here is final yet.",
    "Wrote this down after the third time I had to re-explain why {system} {action}.",
];

pub(super) const BODY_TEMPLATES: &[&str] = &[
    "The part worth remembering is that {system} {action}.",
    "Measured {metric} before and after; the difference was large enough to keep the change.",
    "Left a note for {person} so the next pass does not start from scratch.",
    "The obvious approach fails here, which is why the first attempt was thrown away.",
    "Kept {artifact} alongside this so the claim is checkable rather than remembered.",
    "Most of the complexity is in the edges, not the common case.",
    "It held up under a second read, which is more than the previous version managed.",
    "Worth revisiting once {metric} stops moving week to week.",
    "The tradeoff is explicit: less flexibility now in exchange for a shape that can be explained.",
    "Everything below assumes the setup described above; it does not generalise cleanly.",
];

pub(super) const BULLET_TEMPLATES: &[&str] = &[
    "{system} {action}",
    "Track {metric} — it is the number that moved first",
    "Produce {artifact} before the next review",
    "Check with {person} before changing the default",
    "Keep the fallback path; it is cheap and it has already saved us once",
    "Write down the assumption instead of re-deriving it every time",
    "Prefer the boring option until there is a measurement that argues otherwise",
    "Revisit after two weeks of real use, not after one afternoon",
];

pub(super) const CALLOUTS: &[&str] = &[
    "> [!info]\n> The numbers here come from a single machine. Treat them as directional.",
    "> [!warning]\n> Do not change the default before the follow-up in this note is done.",
    "> [!tip]\n> The fast path is the one that does nothing. Check that first.",
    "> [!note]\n> Written mid-way through. Some of this will be wrong by the next pass.",
];

pub(super) const LINK_HOSTS: &[&str] = &[
    "https://example.com/reference",
    "https://example.org/notes",
    "https://docs.example.com/guide",
    "https://example.net/thread",
];

pub(super) const STATUS_VALUES: &[&str] = &["draft", "active", "review", "parked", "done"];
pub(super) const PRIORITY_VALUES: &[&str] = &["low", "medium", "high"];
pub(super) const OWNERS: &[&str] = &["Kaan", "Dana", "Ravi", "Marta", "Sam", "Elif"];
