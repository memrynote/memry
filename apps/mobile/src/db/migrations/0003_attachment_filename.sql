-- The reference inside a note body is a PATH (`attachments/<noteId>/<file>`),
-- while sync addresses an attachment by its blob id. Desktop bridges the two by
-- writing the downloaded file under the manifest's own filename, so the ref's
-- basename and the manifest filename are the same string by construction.
--
-- Mobile has no vault tree to write into, so it records the pairing instead:
-- the manifest filename lands here at download time and the resolver matches a
-- ref's basename against it, scoped to the note that references it.
--
-- Additive: both columns are nullable, so rows written by the previous build
-- keep working and simply resolve nothing until their next download.

ALTER TABLE attachments ADD COLUMN filename TEXT;
ALTER TABLE attachments ADD COLUMN mime_type TEXT;
