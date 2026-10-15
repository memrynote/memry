//! [`ApiError`] and [`AuthError`], split out of `errors.rs` at the line ceiling.

use thiserror::Error;

use super::{CryptoError, SecureStoreError, TransportError};

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

    /// 409 `AUTH_DEVICE_LIMIT_REACHED` on `POST /auth/devices` (chapter 02
    /// §2.3.3): the account already holds its maximum of active devices. The
    /// user frees a slot by revoking a device from one that is signed in;
    /// retrying or updating changes nothing (#2944).
    #[error("this account has reached its device limit: {message}")]
    DeviceLimitReached { message: String },

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

    /// A 402 from an account route that needs a plan: `POST /sync/vaults`
    /// answers it with no code when the account has no active sync plan, and
    /// with `SYNC_VAULT_LIMIT_EXCEEDED` when the plan's vault slots are full.
    /// The shell offers a plan; retrying changes nothing. Raised only by the
    /// routes that name it, so the sync engine's 402 handling
    /// (`sync::policy`, which reads `Status`) is unchanged.
    #[error("sync needs a plan: {message}")]
    PaymentRequired {
        code: Option<String>,
        message: String,
    },

    /// 409 on `POST /auth/billing/portal-session`: the account has no web
    /// (Paddle) billing customer, so there is no portal to open. An App Store
    /// subscription is managed in iOS Settings instead.
    #[error("no billing portal for this account: {message}")]
    BillingPortalUnavailable { message: String },

    /// The call needs the master key and this device holds none: the user
    /// has not unlocked with the recovery phrase yet. No request was made.
    #[error("this device holds no master key")]
    NoMasterKey,
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
