-- data.db, migration 0019: when this device first held, or last removed, each
-- picture a journal day names (#5800, chapter 14 §14.7.2).
--
-- Additive only: one new table, no existing table or row touched. A day's
-- pictures are named to peers by the `note j<date>` record, and its
-- `attachmentReferences` is one list under one document clock. To merge a
-- concurrent record without losing a picture or resurrecting a removal, the
-- apply needs to know, per id, whether the sender could have seen it: it could
-- when the sender's clock dominates the clock this device held (or removed) the
-- id at. `held` is 1 for held and 0 for removed; `clock` is that vector clock
-- as JSON. No row means no knowledge, which the merge reads as "the sender
-- could not have seen it" and so keeps the picture. An older build ignores the
-- table and keeps last-write-wins.
CREATE TABLE IF NOT EXISTS day_picture_ref_clocks (
  note_id       TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  held          INTEGER NOT NULL,
  clock         TEXT NOT NULL,
  PRIMARY KEY (note_id, attachment_id)
);
