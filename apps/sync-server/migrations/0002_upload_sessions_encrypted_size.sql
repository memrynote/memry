-- Chunked attachment uploads declare a PLAINTEXT total_size but put CIPHERTEXT
-- on the wire (each chunk is nonce || ciphertext, i.e. plaintext + 40 bytes).
-- Storage accounting must use the encrypted size, while plan file-size limits
-- stay on the plaintext size.
--
-- Nullable and additive. Sessions the previous code left in flight reserved the
-- PLAINTEXT total_size, so they are backfilled to total_size: this column records
-- what was actually reserved, and the refund paths pay back exactly that. Deriving
-- a ciphertext total for these rows would refund bytes that were never reserved and
-- permanently drift users.storage_used down.
--
-- Migrations apply before the Worker deploys, so the old code can still open new
-- sessions with a NULL encrypted_size during the rollout window; the refund paths
-- fall back to total_size for those.
ALTER TABLE upload_sessions ADD COLUMN encrypted_size INTEGER;
UPDATE upload_sessions SET encrypted_size = total_size WHERE encrypted_size IS NULL;
