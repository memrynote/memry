---
tags:
  - tech/sql
  - tech/embeddings
project:
  - memrynote Launch
area: Learning
language: sql
level: advanced
---
## Setup

```typescript
import * as sqliteVec from 'sqlite-vec'
sqliteVec.load(sqliteDb)

sqliteDb.exec(`
  CREATE VIRTUAL TABLE vec_notes USING vec0(
    note_id TEXT PRIMARY KEY,
    embedding float[384] distance_metric=cosine
  )
`)
```

## Querying

```sql
SELECT note_id, distance
FROM vec_notes
WHERE embedding MATCH ?
  AND k = 10
ORDER BY distance;
```

#tech/sql #tech/embeddings
