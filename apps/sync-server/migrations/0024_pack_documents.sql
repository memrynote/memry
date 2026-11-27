-- 0024_pack_documents: the documents each body pack holds (#5229, protocol 08
-- §8.13). Additive only. A JSON array of the distinct note and journal ids of
-- a crdt_snapshot or crdt_update pack's entries, so a body purge rewrites only
-- the packs that hold the deleted document. NULL on record packs and on every
-- pack a Worker built before this migration: the purge then treats the kind as
-- unknown and drops and rebuilds all of its packs, as it did before.
ALTER TABLE pack_index ADD COLUMN documents TEXT;
