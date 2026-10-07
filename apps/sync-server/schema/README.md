# Sync D1 schema

`../migrations/` is the canonical D1 schema, and [`../migrations/README.md`](../migrations/README.md) owns the rules for changing it. `d1.test.ts` applies every migration, in order, to a fresh SQLite database and checks the schema they produce.

Staging and production hold real users' data. Never reset a remote database to change the schema. Add the next migration instead: additive by default, never editing an applied file, and removing a column by expand-then-contract across two releases. Both deploy workflows apply pending migrations before `wrangler deploy`, so each migration must work with the Worker that is already running.
