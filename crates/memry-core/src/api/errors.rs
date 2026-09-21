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

/// Failures of the `Transport` seam (research R5).
///
/// A non-2xx HTTP status is **not** one of these: it is a successful response
/// whose body carries an error code (chapter 00 §0.4). These are the failures
/// where no response exists at all, and the core's retry ladder branches on
/// which one it got.
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum TransportError {
    /// No usable network path. Retryable, and the reachability transition is
    /// what should drive the retry rather than a timer.
    #[error("offline")]
    Offline,

    /// The per-request ceiling elapsed. Chapter 00 §0.6 requires that ceiling
    /// to exist, because a socket frozen by an OS backgrounding the app
    /// otherwise never resolves and latches the in-flight guard permanently.
    #[error("request timed out after {elapsed_ms} ms")]
    Timeout { elapsed_ms: u64 },

    /// TLS refused the peer. **Not retryable**: retrying a certificate failure
    /// turns a possible interception into a loop.
    #[error("TLS failure: {what}")]
    Tls { what: String },

    /// The outer caller cancelled. Distinct from `Timeout` because a cancel is
    /// the user's decision and must not count against a retry budget
    /// (chapter 00 §0.6).
    #[error("cancelled")]
    Cancelled,

    /// Any other transport-level failure, retryable.
    #[error("transport failure: {what}")]
    Failed { what: String },

    /// The socket closed. Reconnect and backoff are the core's policy.
    #[error("socket closed with code {code}: {reason}")]
    SocketClosed { code: u16, reason: String },
}

/// Failures of the `SecureStore` seam (chapter 01 §1.8).
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum SecureStoreError {
    /// The device is locked and the entry's protection class does not permit
    /// access yet. Retryable after unlock, and **never** a reason to re-register
    /// the device: treating it as "no key" would throw away the master key.
    #[error("secure store is locked")]
    Locked,

    /// The platform refused the operation.
    #[error("secure store denied the operation: {what}")]
    Denied { what: String },

    #[error("secure store failure: {what}")]
    Failed { what: String },
}

/// Failures of the storage layer and the `FileProtection` seam.
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum StorageError {
    #[error("database is not open")]
    NotOpen,

    /// A migration failed. The database is left at its previous `user_version`,
    /// because the counter is written outside the migration's transaction and
    /// only after it commits (data-model §A.0).
    #[error("migration {version} failed: {what}")]
    Migration { version: u32, what: String },

    /// The SQLite build has no FTS5. Asserted at startup rather than discovered
    /// on the first search, because a core without FTS5 cannot index anything
    /// and should say so immediately (research R4).
    #[error("this SQLite build has no fts5")]
    MissingFts5,

    /// `index.db` is missing, corrupt, or at an unexpected version. Not fatal:
    /// the file is deleted and rebuilt from `data.db`, which is the whole
    /// reason the index lives in its own file (data-model §A.0).
    #[error("index database must be rebuilt: {what}")]
    IndexRebuildRequired { what: String },

    #[error("not enough space: {needed_bytes} bytes needed, {available_bytes} available")]
    OutOfSpace {
        needed_bytes: u64,
        available_bytes: u64,
    },

    #[error("storage failure: {what}")]
    Failed { what: String },
}

/// Failures of the `Notifications` seam.
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum NotificationError {
    /// The user has not granted permission. A distinct variant so the core can
    /// keep the reminder row and reschedule if permission arrives later, rather
    /// than dropping it.
    #[error("notification permission not granted")]
    NotPermitted,

    /// iOS caps pending local notifications at 64. The core must choose which
    /// reminders to hold, so it has to be told rather than silently truncated.
    #[error("the platform's pending notification limit is full")]
    LimitReached,

    #[error("notification failure: {what}")]
    Failed { what: String },
}

/// Failures of the `BackgroundExec` seam.
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum BackgroundError {
    /// Background App Refresh is off for this app or device-wide. Reported so
    /// the shell can say so, per Constitution IV: an absent capability says it
    /// is absent rather than failing quietly.
    #[error("background refresh is unavailable")]
    Unavailable,

    #[error("background scheduling failed: {what}")]
    Failed { what: String },
}

/// Failures of the `EditorHost` seam (chapter 12).
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum EditorError {
    /// No WebView is attached. The core queues rather than losing the message.
    #[error("no editor host is attached")]
    NotAttached,

    /// The guest did not answer in time.
    #[error("editor bridge timed out after {elapsed_ms} ms")]
    Timeout { elapsed_ms: u64 },

    /// The bundle's `BRIDGE_PROTOCOL_VERSION` is not the one this core speaks.
    /// A hard failure, not a degraded mode: the bundle and the core ship
    /// together, so a mismatch means the build pairing broke.
    #[error("editor bridge speaks version {found}, core speaks {expected}")]
    ProtocolMismatch { expected: u32, found: u32 },

    #[error("editor bridge failure: {what}")]
    Failed { what: String },
}

/// Failures of the `CodeCapture` seam (chapter 03).
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum CaptureError {
    #[error("camera permission not granted")]
    NotPermitted,

    /// Parental controls or an MDM profile. Distinct from `NotPermitted`
    /// because the user cannot grant it from Settings, so sending them there
    /// is the wrong instruction.
    #[error("camera access is restricted by device policy")]
    Restricted,

    #[error("capture cancelled")]
    Cancelled,

    #[error("capture failure: {what}")]
    Failed { what: String },
}

/// Failures of one HTTP call to the sync server (chapters 00 §0.4, 00 §0.5).
///
/// The split is by **what a caller must do**, not by status: a 429 waits, a 426
/// parks the outbox and offers an update, a 501 from the bootstrap routes says
/// this deployment never had the feature. Everything with no distinct response
/// collapses into `Status`, which carries the status and whatever code the
/// server sent, because §0.5.1 requires a client to accept a code it has never
/// heard of without crashing.
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum ApiError {
    /// No response at all. The retry ladder already ran; this is what it gave
    /// up on.
    #[error("transport failure: {source}")]
    Transport {
        #[from]
        source: TransportError,
    },

    /// A local storage failure, surfaced across a boundary whose other arms
    /// are all server answers.
    ///
    /// It exists because the alternative lies. `PushWave::pending` and `drain`
    /// return `ApiError`, so before this variant a failed SQLite read crossed
    /// as `Transport { Failed { "local storage: …" } }` — which lands in the
    /// right state, because the engine's `is_offline` matches only
    /// [`TransportError::Offline`], but tells every reader that the network
    /// failed when the disk did. A caller cannot tell "the server is
    /// unreachable" from "this device cannot read its own database", and those
    /// want different things said to the user.
    #[error("local storage failure: {what}")]
    Storage { what: String },

    /// A 401. The token is unusable and a refresh either did not happen or did
    /// not help.
    #[error("not authenticated ({code}): {message}")]
    Unauthorized { code: String, message: String },

    /// `AUTH_DEVICE_REVOKED`, 403 or 409. Terminal for this device: data-model
    /// §C.1 sends the session to `Revoked`, which removes local vault content
    /// before it is shown.
    #[error("this device has been revoked: {message}")]
    DeviceRevoked { message: String },

    /// A 429, where `retry_after_s` is the lowercase `retry-after` header the
    /// server sent, when it sent one (chapter 00 §0.6).
    #[error("rate limited: {message}")]
    RateLimited {
        retry_after_s: Option<u64>,
        message: String,
    },

    /// 403 `PLATFORM_WRITES_DISABLED`, chapter 11 §11.6. **Not a sync failure
    /// the user can retry** (§11.9): the outbox parks and accrues no backoff.
    #[error("writes are disabled for this platform: {message}")]
    WritesDisabled { message: String },

    /// 426 `CLIENT_UPGRADE_REQUIRED`, chapter 11 §11.6. `min_version` rides
    /// **inside** the error object on the wire, and is optional because a
    /// server that omits it still means the same thing.
    #[error("this client version is below the write floor: {message}")]
    UpgradeRequired {
        min_version: Option<String>,
        message: String,
    },

    /// 501 `BOOTSTRAP_UNAVAILABLE`, chapter 10 §10.12. A deployment
    /// configuration fact, not a client bug and not a 5xx to retry: the caller
    /// falls back to steady-state sync and says nothing to the user.
    #[error("this deployment has no bootstrap key configured")]
    BootstrapUnavailable,

    /// Any other non-2xx. `code` is absent when the body carried the bare
    /// string form or no JSON at all (chapter 00 §0.4).
    #[error("server returned {status}: {message}")]
    Status {
        status: u16,
        code: Option<String>,
        message: String,
    },

    /// A 2xx whose body was not the shape the route promises.
    #[error("malformed response from {path}: {what}")]
    MalformedResponse { path: String, what: String },

    /// The client's own `x-memry-client` value does not match the server's
    /// grammar. Chapter 11 §11.3: a malformed value silently opts the client
    /// out of the write gate, so it is refused here rather than sent.
    #[error("invalid client identity: {what}")]
    InvalidClientIdentity { what: String },
}

/// Failures of the authentication and session machine (chapter 02,
/// data-model §C.1).
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum AuthError {
    #[error("{source}")]
    Api {
        #[from]
        source: ApiError,
    },

    #[error("{source}")]
    SecureStore {
        #[from]
        source: SecureStoreError,
    },

    #[error("{source}")]
    Crypto {
        #[from]
        source: CryptoError,
    },

    /// The call is not an edge of the machine from the state it is in
    /// (data-model §C.1). A caller bug, surfaced rather than papered over,
    /// because the alternative is a silent second sign-in racing the first.
    #[error("cannot {action} from {state}")]
    InvalidState { action: String, state: String },

    /// A JWT this client holds is not decodable, or lacks a claim chapter 02
    /// §2.2 requires. Never a verification failure: the signing key is the
    /// server's and a client does not hold it.
    #[error("malformed token: {what}")]
    MalformedToken { what: String },

    /// Refresh is inside a rejection backoff window (chapter 02 §2.10). No
    /// network call was made, deliberately.
    #[error("refresh is blocked for another {retry_in_ms} ms")]
    RefreshBlocked { retry_in_ms: u64 },

    /// Three 401s on refresh. Permanently blocked for this session; the user
    /// must sign in again (chapter 02 §2.10).
    #[error("the session has expired and refresh is permanently blocked")]
    SessionExpired,

    /// A sign-in response carried no setup token, so there is nothing to
    /// register a device with (data-model §C.1: the edge is to `SignedOut`).
    #[error("sign-in did not return a setup token")]
    NoSetupToken,
}

/// Failures of the read-only sync a shell can drive (T236, spec-defect 136).
///
/// **Every arm is a variant, never a rendered string** (Constitution II), and
/// the two that are not simply forwarded exist because collapsing them lies:
///
/// - [`SyncError::Locked`] is "this device holds no master key", which is a
///   local state the user fixes by unlocking. Folded into
///   [`SecureStoreError::Locked`] it would read as "the keychain is locked",
///   which is a different sentence and a different remedy; folded into an
///   `ApiError` it would read as a server answer, and no request was made.
/// - [`SyncError::UnknownNote`] is a refusal, never a transient fault. A body
///   fetched for a note this vault has no live record of would land with no row
///   to hang it on (chapter 07 §7.15), so the fetch is refused. **No copy may
///   describe it as something to retry.**
///
/// A non-2xx arrives as [`SyncError::Api`] carrying [`ApiError::Status`] or one
/// of its named arms — a **response**, never a transport failure — so a
/// permanent refusal from the server can never be mistaken for a lost
/// connection.
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum SyncError {
    #[error("{source}")]
    Api {
        #[from]
        source: ApiError,
    },

    #[error("{source}")]
    Storage {
        #[from]
        source: StorageError,
    },

    #[error("{source}")]
    SecureStore {
        #[from]
        source: SecureStoreError,
    },

    #[error("{source}")]
    Crypto {
        #[from]
        source: CryptoError,
    },

    /// No master key in the secure store: nothing has unlocked this device, so
    /// there is no vault key to open a record with. The keychain answered
    /// **absent**, not locked — a locked keychain crosses as
    /// [`SyncError::SecureStore`] and is the transient one of the two.
    #[error("this device is locked: no master key")]
    Locked,

    /// This vault holds no live note by that id, so there is no record to hang
    /// a body on. Permanent for this id, not a retryable fault.
    #[error("no live note `{id}` in this vault")]
    UnknownNote { id: String },

    /// This device's own identity could not be read.
    ///
    /// Forwarded rather than flattened, exactly as the four above are: an
    /// `AuthError` reaching the shell inside a sync is the same fact as one
    /// reaching it inside a sign-in, and a second set of sentences for it
    /// would be a second set to keep true.
    ///
    /// Reachable because a **write** needs a signing key and a device id where
    /// a read does not: an attachment manifest is signed, so uploading one
    /// asks for the identity that a pull never had to.
    #[error("{source}")]
    Auth {
        #[from]
        source: AuthError,
    },

    /// An attachment manifest could not be authenticated.
    ///
    /// **Its own variant, and never folded into [`SyncError::Api`] or
    /// [`SyncError::Crypto`]** (chapter 14 §14.4.1). The manifest is the only
    /// thing that names a file, so this is the one failure that means "the
    /// server may be pointing this note's picture at somebody else's bytes"
    /// rather than "something is broken". A shell must not offer a retry over
    /// it, which is why it does not look like a transport fault.
    ///
    /// Also the answer for a signer device this vault cannot resolve, which
    /// §14.4.1 makes a **hard failure rather than a fallback** — deliberately
    /// unlike a record, where chapter 01 §1.4.0 leaves an unresolvable signer
    /// *unverified* and refetches the directory.
    #[error("the attachment manifest signed by `{device_id}` could not be verified")]
    AttachmentUnverified { device_id: String },

    /// The bytes arrived and were not the bytes the manifest describes.
    ///
    /// A failed chunk hash, a failed whole-file checksum, or a chunk that
    /// would not decrypt. Separate from `AttachmentUnverified` because the
    /// manifest was trustworthy and the transfer was not, so a retry is
    /// reasonable here and is not there.
    #[error("the attachment bytes failed their integrity check: {what}")]
    AttachmentCorrupt { what: String },
}
