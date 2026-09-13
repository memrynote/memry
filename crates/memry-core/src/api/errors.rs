//! The typed error surfaces that cross the FFI.
//!
//! Constitution II: an error crosses as a **variant**, never as a rendered
//! string. A shell that receives `CryptoError::OutOfMemory` can tell the user to
//! close some apps; a shell that receives `"error: -1"` can only apologise. Each
//! surface gets its own enum so that a caller's match is exhaustive over the
//! things that surface can actually fail with.
//!
//! `Display` text exists for logs and for `unwrap` messages. It is never the
//! payload: the variant is.

use thiserror::Error;

/// Failures of the primitives in `crypto::sodium` and the derivations above them.
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum CryptoError {
    /// A buffer was not the length its primitive requires.
    #[error("{what}: expected {expected} bytes, got {actual}")]
    InvalidLength {
        what: String,
        expected: u64,
        actual: u64,
    },

    /// A primitive rejected its arguments for a reason other than a length.
    #[error("invalid parameter: {what}")]
    InvalidParameter { what: String },

    /// AEAD authentication failed: wrong key, wrong nonce, or altered bytes.
    ///
    /// Deliberately carries no detail. Chapter 01 §1.7 is the reason this is
    /// never a routing signal either: every vault on an account shares one key,
    /// so a foreign ciphertext decrypts cleanly and the absence of this error
    /// proves nothing about which vault a record belongs to.
    #[error("decryption failed")]
    DecryptionFailed,

    /// AEAD encryption failed. Unreachable in practice; not silently ignored.
    #[error("encryption failed")]
    EncryptionFailed,

    /// `crypto_pwhash` could not allocate `memlimit` bytes.
    ///
    /// The whole reason this variant exists: at 64 MiB under memory pressure
    /// libsodium returns the same -1 it returns for bad parameters, and
    /// reporting that as "wrong recovery phrase" tells the user to re-type a
    /// phrase that was correct (research R3, chapter 01 §1.1).
    #[error("could not allocate {requested_bytes} bytes for key derivation")]
    OutOfMemory { requested_bytes: u64 },

    /// Base64 that is not in the standard alphabet, or not correctly padded
    /// (chapter 04 §4.5).
    #[error("invalid base64 input")]
    InvalidBase64,

    /// Hex that is not an even number of hex digits.
    #[error("invalid hex input")]
    InvalidHex,
}

/// Failures of the recovery-phrase path (chapter 01 §1.3).
///
/// "Not in the wordlist" and "checksum failed" are separate because they call
/// for different user instructions: the first names a word to fix, the second
/// says the words are all real but the phrase is not one Memry issued.
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum RecoveryError {
    /// A word is not in the English BIP-39 list.
    #[error("word not in the English BIP-39 wordlist: {word}")]
    UnknownWord { word: String },

    /// Every word is real but the phrase's checksum does not verify.
    #[error("recovery phrase checksum failed")]
    BadChecksum,

    /// The phrase did not have 24 words after normalisation.
    #[error("expected 24 words, got {actual}")]
    WrongWordCount { actual: u64 },

    /// A byte outside ASCII survived normalisation (chapter 01 §1.3).
    #[error("recovery phrase contains a non-ASCII character")]
    NonAscii,

    /// The phrase was valid but did not unlock this account: the derived
    /// account key verifier did not match the server's.
    #[error("recovery phrase did not match this account")]
    VerifierMismatch,

    /// Key derivation failed under a valid phrase. Carries the crypto variant so
    /// an out-of-memory does not surface as "wrong phrase".
    #[error("key derivation failed: {source}")]
    Crypto {
        #[from]
        source: CryptoError,
    },
}

/// Failures of the canonical CBOR encoder (chapter 04 §4.7).
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum CborError {
    /// A defined top-level key was not in the payload's allowlist.
    ///
    /// Chapter 04 §4.7: this is a hard throw, never a silent exclusion, because
    /// silently dropping a field produces a signature over a different field set
    /// than the sender believes it signed.
    #[error(
        "CBOR encoding rejected: fields not in ordering would be excluded: {fields}. Update CBOR_FIELD_ORDER."
    )]
    FieldNotInOrdering { fields: String },

    /// A value the canonical encoder has no defined encoding for.
    #[error("value cannot be canonically encoded: {what}")]
    Unencodable { what: String },

    /// Malformed CBOR on the way in.
    #[error("malformed CBOR: {what}")]
    Malformed { what: String },
}

/// Failures of the compression frame (chapter 04 §4.1).
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum CompressError {
    /// A `0x01` frame whose zlib stream never reached its end.
    ///
    /// Chapter 04 §4.1 requires this to be a hard error. Returning an empty
    /// buffer instead turns a truncated body into a successful decrypt of an
    /// empty item, which the applier writes as a content wipe.
    #[error("Failed to decompress payload: incomplete deflate stream")]
    IncompleteDeflateStream,

    /// zlib rejected the stream for a reason other than truncation.
    #[error("Failed to decompress payload: {what}")]
    Corrupt { what: String },
}
