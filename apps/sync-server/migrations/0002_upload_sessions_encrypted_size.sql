-- Chunked attachment uploads declare a PLAINTEXT total_size but put CIPHERTEXT
-- on the wire (each chunk is nonce || ciphertext, i.e. plaintext + 40 bytes).
-- Storage accounting must use the encrypted size, while plan file-size limits
-- stay on the plaintext size.
--
-- Nullable and additive: in-flight sessions written by the previous code, and
-- sessions opened by clients that do not send `encryptedSize`, keep NULL here
-- and the server derives the value from total_size + chunk_count.
ALTER TABLE upload_sessions ADD COLUMN encrypted_size INTEGER;
