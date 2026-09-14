//! Device linking's **new-device half**: the phone scans the desktop's code
//! (chapter 03, spec-defect 114).
//!
//! ## What this object is, and what it deliberately is not
//!
//! §3.1 lists five routes. Two are the new device's — `POST
//! /auth/linking/scan` and `POST /auth/linking/complete`, both unauthenticated
//! — and three are the already-unlocked device's. Only the two are here. A
//! phone that could call `approve` would be approving its own link, and the
//! desktop already implements all three.
//!
//! **A separate object rather than methods on [`AuthSession`].** The two share
//! neither an authenticated client nor a state machine: linking's calls carry
//! no `Authorization` header at all (§3.1), and the state they need — one
//! ephemeral X25519 secret, three subkeys and a poll ledger — is the session's
//! business in no way. `AuthSession`'s reason for refusing a sibling does not
//! reach here either: that reason is that a second `TokenManager` over the same
//! keychain entries is a chapter 02 §2.9 device revocation, and this object
//! holds no token manager. The narrower gain is real too — widening
//! `AuthSessionProtocol` breaks every Swift conformance to it, test fakes
//! included, and nothing about linking earns that.
//!
//! ## Linking replaces the recovery phrase, not the sign-in
//!
//! Worth stating because the flow reads as if it should replace both. The
//! phone still signs in (chapter 02: OTP or Google) and still registers its own
//! device with the setup token that sign-in issued. What linking supplies is
//! the **master key**, which the recovery-phrase path otherwise derives from 24
//! words. So the order is: sign in, `DeviceLink::scan`, poll to `Linked`, then
//! `AuthSession::register_device` exactly as before. Nothing in
//! `AuthState`/`AuthEvent` changes, and nothing needed to.
//!
//! ## No key crosses the FFI
//!
//! The master key arrives sealed, is opened here, and goes straight into the
//! [`SecureStore`] seam under [`SecureStoreKey::MasterKey`]. It is never in a
//! return type. The **SAS is the deliberate exception** and is a `String`: six
//! decimal digits that exist to be read aloud (§3.6). It is not key material —
//! it is a 19.93-bit fingerprint of a shared secret that is itself discarded.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use zeroize::Zeroizing;

use crate::api::errors::ApiError;
use crate::protocol::account::VaultSummary;
use crate::protocol::auth::DevicePlatform;
use crate::protocol::http::{ClientIdentity, HttpClient};
use crate::protocol::linking::routes::{self, CompleteOutcome, ScanRequest};
use crate::protocol::linking::{
    self, LinkingError, LinkingSubkeys, confirm_mac, linking_proof_message, scan_confirm_message,
    scan_mac,
};
use crate::seams::secure_store::{SecureStore, SecureStoreKey};
use crate::seams::transport::Transport;

/// §3.4: 30 requests per 60 seconds, per **session** rather than per IP, so a
/// network change does not reset it (§3.1).
pub const POLL_BUDGET_REQUESTS: u32 = 30;
/// The window [`POLL_BUDGET_REQUESTS`] is counted over.
pub const POLL_BUDGET_WINDOW_MS: u64 = 60_000;

/// `deviceName`'s ceiling on `POST /auth/linking/scan`
/// (`apps/sync-server/src/routes/linking.ts:57`). **Not** `POST /auth/devices`'
/// 255 (chapter 02 §2.3): the two fields are different fields on different
/// routes, and only the registration one is sanitised server-side.
const DEVICE_NAME_MAX_CHARS: usize = 100;

/// The first `max` characters, cut on a character boundary so the result is
/// still UTF-8 and still counts as at most `max` to the server's `z.string()`,
/// which measures code points rather than bytes.
fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// What a successful scan gives the user to check, §3.6 and §3.4.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LinkingScan {
    pub session_id: String,
    /// The six-digit short verification code. **Six decimal digits, not
    /// words**, and both devices compute it independently from the raw
    /// scalarmult output, so the user comparing them is comparing the key
    /// agreement itself.
    pub sas_code: String,
    /// The server's `expiresAt`, epoch **seconds** (§3.4). Absolute from
    /// `initiate`, and neither `scan` nor `approve` extends it, so a shell
    /// renders the countdown from this rather than from 300.
    pub expires_at: i64,
}

/// The answer to one poll.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum LinkingPoll {
    /// The desktop has not approved yet. Poll again.
    AwaitingApproval,
    /// The master key is in the secure store. `vaults` is §3.10's transferred
    /// list, and is **empty** when the initiator sent no block — which is not a
    /// failure, and not "this account has no vaults": the client fetches
    /// `GET /sync/vaults` after it registers.
    Linked { vaults: Vec<VaultSummary> },
}

/// What one pending link holds between `scan` and the poll that completes it.
struct Pending {
    session_id: String,
    expires_at_s: u64,
    subkeys: LinkingSubkeys,
    /// One entry per `complete` request, for §3.4's budget.
    polls: VecDeque<Instant>,
}

impl Pending {
    fn subkey_copy(&self) -> LinkingSubkeys {
        LinkingSubkeys {
            encryption: self.subkeys.encryption.clone(),
            mac: self.subkeys.mac.clone(),
            sas: self.subkeys.sas.clone(),
        }
    }

    /// Charges one request against §3.4's budget, or refuses without making
    /// one. Returns how long the caller must wait when it refuses.
    fn charge_poll(&mut self, now: Instant) -> Result<(), LinkingError> {
        let window = std::time::Duration::from_millis(POLL_BUDGET_WINDOW_MS);
        while self.polls.front().is_some_and(|at| now - *at >= window) {
            self.polls.pop_front();
        }
        if self.polls.len() as u32 >= POLL_BUDGET_REQUESTS {
            let oldest = self.polls.front().copied().unwrap_or(now);
            let waited = now - oldest;
            return Err(LinkingError::PollBudgetExhausted {
                retry_in_ms: (window - waited).as_millis() as u64,
            });
        }
        self.polls.push_back(now);
        Ok(())
    }
}

/// The new device's side of chapter 03.
///
/// **Which methods suspend is contract** (spec-defect 90). `new`, `cancel` and
/// `is_pending` **block** and do no I/O at all; `scan` and `poll_once` are
/// **`async`** and each makes **exactly one** HTTP request. Nothing here loops,
/// and nothing here sleeps.
///
/// That shape is the direct answer to spec-defect 108: an async core call
/// cannot be cancelled from Swift, because `rust_future_cancel` does not appear
/// in the bindings. A linking flow has a human in the middle and a 300 s
/// window, so a poll loop *inside* one async call would be unabandonable — the
/// user who walks away could not stop it, and the shell could not either. The
/// loop therefore belongs to the shell's timer, where a cancelled `Task` is an
/// ordinary thing, and each core call is one round trip the shell can simply
/// stop repeating.
#[derive(uniffi::Object)]
pub struct DeviceLink {
    http: Arc<HttpClient>,
    store: Arc<dyn SecureStore>,
    /// §3.1's `scan` body carries the label the approving desktop shows before
    /// a human presses Approve. See [`DeviceLink::new`] for why it is not the
    /// `client_platform` the `HttpClient` already holds.
    device_name: String,
    device_platform: DevicePlatform,
    pending: Mutex<Option<Pending>>,
}

#[uniffi::export(async_runtime = "tokio")]
impl DeviceLink {
    /// Builds the linking client over the shell's seams.
    ///
    /// The `HttpClient` carries **no token provider**, deliberately: both
    /// routes are unauthenticated (§3.1) and the phone has no session to
    /// refresh. A client with one would spend a refresh on every poll of a
    /// device whose whole problem is that it is not yet a device.
    ///
    /// **`device_platform` is chapter 02 §2.12's registration enumeration and
    /// `client_platform` is `CLIENT_PLATFORMS`, and they are two parameters on
    /// purpose** (spec-defect 140). On a phone both read `ios`, which is
    /// exactly why reusing one for the other would never be caught here: a
    /// desktop built on this same core registers as `macos`, identifies itself
    /// as `desktop`, and sends `macos` on `scan`
    /// (`apps/desktop/src/main/sync/linking-service.ts:276`) — a value
    /// `CLIENT_PLATFORMS` does not contain. The server's own field is a free
    /// `z.string().min(1).max(50)`, so nothing on the wire would reject the
    /// mistake either; taking the typed enum is what refuses it.
    ///
    /// **An empty `device_name` is refused rather than sent.** The route's
    /// `min(1)` would answer a bare `400 VALIDATION_ERROR` — the one sentence
    /// that cost six rounds to read — and a shell that cannot name its device
    /// has a bug worth surfacing where it happened. A name longer than the
    /// route's 100 characters is **truncated on a character boundary**, not
    /// refused: it is a label a human reads, never an identifier, and refusing
    /// to link a computer with a long hostname would be the worse failure.
    #[uniffi::constructor]
    pub fn new(
        transport: Arc<dyn Transport>,
        secure_store: Arc<dyn SecureStore>,
        base_url: String,
        client_platform: String,
        app_version: String,
        device_name: String,
        device_platform: DevicePlatform,
    ) -> Result<Self, ApiError> {
        let identity = ClientIdentity::new(&client_platform, &app_version)?;
        if device_name.is_empty() {
            return Err(ApiError::InvalidClientIdentity {
                what: "deviceName must be 1 to 100 characters, got an empty string".to_string(),
            });
        }
        Ok(Self {
            http: Arc::new(HttpClient::new(transport, &base_url, identity)),
            store: secure_store,
            device_name: truncate_chars(&device_name, DEVICE_NAME_MAX_CHARS),
            device_platform,
            pending: Mutex::new(None),
        })
    }

    /// Scans the desktop's QR payload and posts `POST /auth/linking/scan`.
    ///
    /// The order is §3.8's and it is load-bearing: parse and **refuse an
    /// expired session before doing any crypto**, because an X25519 agreement
    /// against a dead session spends a phone's battery to produce a code the
    /// user would then compare for nothing.
    ///
    /// One request. §3.7's three tags all ride in that one body — `scanProof`
    /// and `scanConfirm` on the scan channel under the decoded `linkingSecret`,
    /// and `newDeviceConfirm` on the confirm channel under `memrymac` — and
    /// `scanProof` and `newDeviceConfirm` cover **identical** CBOR bytes.
    pub async fn scan(&self, qr_payload: String) -> Result<LinkingScan, LinkingError> {
        if self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
        {
            return Err(LinkingError::AlreadyScanned);
        }

        let invitation = linking::parse_invitation(&qr_payload)?;
        linking::assert_not_expired(invitation.expires_at_s, now_epoch_s())?;

        let secret = Zeroizing::new(linking::decode_linking_secret(
            &invitation.linking_secret_b64,
        )?);
        let initiator_public = BASE64_STANDARD
            .decode(&invitation.initiator_public_key_b64)
            .map_err(|_| LinkingError::InvalidBase64 {
                what: "ephemeralPublicKey".into(),
            })?;

        let (device_public, device_secret) = linking::ephemeral_keypair()?;
        let shared = linking::shared_secret(&device_secret, &initiator_public)?;
        let subkeys = linking::derive_subkeys(&shared)?;
        let sas_code = linking::sas_code_from_key(&subkeys.sas)?;
        let device_public_b64 = BASE64_STANDARD.encode(&device_public);

        let proof = linking_proof_message(&invitation.session_id, &device_public_b64)?;
        let confirm = scan_confirm_message(
            &invitation.session_id,
            &invitation.initiator_public_key_b64,
            &device_public_b64,
        )?;

        let request = ScanRequest {
            session_id: invitation.session_id.clone(),
            new_device_public_key: device_public_b64,
            new_device_confirm: BASE64_STANDARD.encode(confirm_mac(&proof, &subkeys.mac)?),
            // §3.3: echoed byte-exact. The server stores
            // `hex(SHA-256(utf8(string)))` and re-hashes what it is sent.
            linking_secret: invitation.linking_secret_b64.clone(),
            scan_confirm: BASE64_STANDARD.encode(scan_mac(&confirm, &secret)?),
            scan_proof: BASE64_STANDARD.encode(scan_mac(&proof, &secret)?),
            // Required by the route and by nothing the core can derive
            // (spec-defect 140). They reach the approving desktop as the label
            // a human approves, and they are held rather than passed in per
            // scan because a device does not change its name mid-link.
            device_name: self.device_name.clone(),
            device_platform: self.device_platform,
        };
        routes::scan(&self.http, &request).await?;

        let scanned = LinkingScan {
            session_id: invitation.session_id.clone(),
            sas_code,
            expires_at: invitation.expires_at_s as i64,
        };
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(Pending {
            session_id: invitation.session_id,
            expires_at_s: invitation.expires_at_s,
            subkeys,
            polls: VecDeque::new(),
        });
        Ok(scanned)
    }

    /// **One** `POST /auth/linking/complete`. The shell repeats it; this makes
    /// no second request and never sleeps.
    ///
    /// Three things happen before a request is sent, in this order: there must
    /// be a pending session, §3.4's window must still be open against the
    /// server's own `expiresAt`, and §3.4's 30-per-60-s budget must have room.
    /// Each refusal is its own variant and costs no request.
    ///
    /// On approval, §3.9's ordering is enforced structurally rather than
    /// remembered: `keyConfirm` is verified **before** the master key is
    /// decrypted, and §3.10's vault transfer is verified and decrypted before
    /// anything is stored. A failure of either wipes the subkeys and clears the
    /// session, so the next poll says [`LinkingError::NotScanned`] rather than
    /// retrying against a secret that did not agree.
    pub async fn poll_once(&self) -> Result<LinkingPoll, LinkingError> {
        let (session_id, subkeys) = {
            let mut guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            let pending = guard.as_mut().ok_or(LinkingError::NotScanned)?;
            if linking::assert_not_expired(pending.expires_at_s, now_epoch_s()).is_err() {
                // The window is gone and no poll will ever complete. Dropping
                // the pending session here zeroes all three subkeys.
                *guard = None;
                return Err(LinkingError::SessionExpired);
            }
            pending.charge_poll(Instant::now())?;
            (pending.session_id.clone(), pending.subkey_copy())
        };

        let outcome = match routes::complete(&self.http, &session_id).await {
            Ok(outcome) => outcome,
            Err(error) => {
                if is_terminal(&error) {
                    // §3.11.3: on `LINKING_IP_MISMATCH` a client MUST zero the
                    // linking subkeys and MUST NOT retry. The same holds for
                    // every other permanent refusal — §3.12's 403, 404 and 410
                    // all mean this session is over — and only a rate limit or
                    // a transport failure is worth polling through. Describing
                    // a permanent refusal as transient is what burns the rest
                    // of a 300 s window on a session the server has forgotten.
                    *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
                }
                return Err(error);
            }
        };

        let CompleteOutcome::Approved(link) = outcome else {
            return Ok(LinkingPoll::AwaitingApproval);
        };

        // Everything below fails the link rather than half-completing it, so
        // the session is cleared on the way out either way.
        let result = self.adopt(&session_id, &link, &subkeys);
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
        result
    }

    /// Abandons a pending link, zeroing the shared secret's three subkeys.
    ///
    /// Blocking, and safe to call with nothing pending: a user who backs out of
    /// the screen is not an error.
    pub fn cancel(&self) {
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Whether a scanned session is still pending. Blocking.
    pub fn is_pending(&self) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }
}

impl DeviceLink {
    /// §3.9 and §3.10, in the one order that never touches unverified material.
    fn adopt(
        &self,
        session_id: &str,
        link: &routes::ApprovedLink,
        subkeys: &LinkingSubkeys,
    ) -> Result<LinkingPoll, LinkingError> {
        let master_key = linking::receive_master_key(
            session_id,
            &link.master_key,
            &link.key_confirm_b64,
            subkeys,
        )?;

        // §3.10: vault transfer is **hard-fail**; provider auth is soft and is
        // ignored entirely, which that section explicitly permits — the refresh
        // tokens transited the server as ciphertext either way, so the only
        // effect is that Google Calendar is not pre-connected.
        let vaults = match &link.vault_transfer {
            Some(block) => linking::open_vault_transfer(session_id, block, subkeys)?,
            None => Vec::new(),
        };

        // The last step, and the only one that leaves a trace: a key stored
        // before the transfer was checked would survive a link that failed.
        self.store
            .set(SecureStoreKey::MasterKey, master_key.to_vec())?;
        Ok(LinkingPoll::Linked { vaults })
    }
}

/// §3.12, read as "what must the client do": a 429 waits and a transport
/// failure is the next poll's problem, and everything else is over.
fn is_terminal(error: &LinkingError) -> bool {
    !matches!(
        error,
        LinkingError::Api {
            source: ApiError::RateLimited { .. } | ApiError::Transport { .. }
        }
    )
}

fn now_epoch_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> Pending {
        Pending {
            session_id: "s".into(),
            expires_at_s: 0,
            subkeys: LinkingSubkeys {
                encryption: Zeroizing::new(vec![0u8; 32]),
                mac: Zeroizing::new(vec![0u8; 32]),
                sas: Zeroizing::new(vec![0u8; 32]),
            },
            polls: VecDeque::new(),
        }
    }

    /// §3.4's budget, at its edge: the thirtieth request is inside it and the
    /// thirty-first is not.
    #[test]
    fn the_thirty_first_poll_in_a_window_is_refused() {
        let mut pending = pending();
        let now = Instant::now();
        for _ in 0..POLL_BUDGET_REQUESTS {
            pending.charge_poll(now).expect("inside the budget");
        }
        assert!(matches!(
            pending.charge_poll(now),
            Err(LinkingError::PollBudgetExhausted { retry_in_ms })
                if retry_in_ms == POLL_BUDGET_WINDOW_MS
        ));
    }

    /// The window slides; it does not latch. A session that spent its budget
    /// must be pollable again a minute later, because §3.4's 300 s window
    /// outlives five of these.
    #[test]
    fn the_budget_window_slides() {
        let mut pending = pending();
        let start = Instant::now();
        for _ in 0..POLL_BUDGET_REQUESTS {
            pending.charge_poll(start).expect("inside the budget");
        }
        let later = start + std::time::Duration::from_millis(POLL_BUDGET_WINDOW_MS);
        assert_eq!(pending.charge_poll(later), Ok(()));
    }

    /// A rate limit and a dropped connection are the only two answers worth
    /// polling through; §3.12's permanent refusals are not.
    #[test]
    fn only_a_rate_limit_or_a_transport_failure_keeps_the_session() {
        use crate::api::errors::TransportError;
        assert!(!is_terminal(&LinkingError::Api {
            source: ApiError::RateLimited {
                retry_after_s: Some(2),
                message: String::new()
            }
        }));
        assert!(!is_terminal(&LinkingError::Api {
            source: ApiError::Transport {
                source: TransportError::Offline
            }
        }));
        // §3.11.3, and §3.12's 404 and 410.
        assert!(is_terminal(&LinkingError::Api {
            source: ApiError::Status {
                status: 403,
                code: Some("LINKING_IP_MISMATCH".into()),
                message: String::new()
            }
        }));
        assert!(is_terminal(&LinkingError::ConfirmMacInvalid));
    }
}
