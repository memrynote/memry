---
tags:
  - tech/sql
  - tech/postgres
area: Learning
language: sql
level: intermediate
---
## When B-tree isn't enough

```sql
-- Partial index for hot path
CREATE INDEX idx_tasks_active
  ON tasks (project_id, modified_at DESC)
  WHERE archived_at IS NULL;

-- GIN for tag arrays
CREATE INDEX idx_tasks_tags
  ON tasks USING GIN (tags);

-- BRIN for time-series, low maintenance
CREATE INDEX idx_events_brin
  ON events USING BRIN (created_at);
```

## Pair with EXPLAIN ANALYZE

Always. Otherwise you're index-cargo-culting.

## Reference

[[CMU Database Course]] — the deep dive that finally made this stick.

#tech/sql #tech/postgres
