-- Coverage of a record pack waiting for its purge rewrite (#5247, protocol 08
-- section 8.13). A purge or a tombstone shed takes a record pack that holds a
-- deleted item out of the listing and records its object here as a pending
-- rewrite. The rewrite lists the same range again under the same coverage, so
-- the record chain keeps tiling, and reads it from these columns because the
-- pack_index row is gone by then.
--
-- Backward compatibility:
--   * Nullable columns, no backfill. NULL is a cache-only pack, the value a
--     body pack and every row written before this migration carry.
--   * A Worker deployed before this migration (or rolled back after it) never
--     reads or writes the columns. It does not rewrite record packs, and marks
--     a pending record rewrite due instead, which leaves a coverage gap a
--     reader treats as unpacked (section 8.10), never wrong data.
ALTER TABLE pack_replaced_objects ADD COLUMN cover_from INTEGER;
ALTER TABLE pack_replaced_objects ADD COLUMN cover_through INTEGER;
