//! Cold-launch session restore, spec-defect 121.
//!
//! `AuthSession::new` builds a machine in `SignedOut` while the secure store
//! may still hold the refresh token the previous run wrote. Data-model §C.1
//! drew no edge from "the process started and there are tokens on disk" to
//! `Registered` — the only two ways in were an OTP and a device registration —
//! so a registered user who quit the app was asked to sign in again on every
//! single launch, and T152's unlock screen was reachable only through a sign-in
//! the user had already done.
//!
//! ## Why a method, and not `new`
//!
//! The defect log offered both and leaned the other way. The reason it gave —
//! a constructor that refreshes over the network is a constructor that fails
//! for network reasons — does not survive contact with this implementation,
//! because **this restore makes no request** (see below) and `new` already
//! returns a `Result`. The reason that does survive is the keychain:
//!
//! The five entries are `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
//! (data-model §B, research R11), so a process that starts after a reboot and
//! before the user has unlocked the phone once reads `Locked`, not "absent".
//! A probe inside `new` would have to either propagate that — and then the app
//! cannot construct a session, or render, until the phone is unlocked — or
//! swallow it into `SignedOut`, which is spec-defect 121 again one layer down
//! and exactly the collapse data-model §B exists to prevent. A **method** is
//! retryable: the shell calls it at launch, and calls it again when protected
//! data becomes available, without rebuilding the session and without building
//! the second `TokenManager` over the same keychain entries that chapter 02
//! §2.9 turns into a revocation.
//!
//! ## Why it makes no request
//!
//! An async core call cannot be cancelled — `rust_future_cancel` is zero hits
//! in the generated bindings (spec-defect 108) — and the refresh ladder honours
//! a server `Retry-After` with no ceiling (spec-defect 109). A restore that
//! refreshed would be a launch that can suspend for an hour and cannot be
//! interrupted. It is unnecessary as well as unsafe: a `401` on the first
//! `Auth::Session` request is the refresh-and-replay path `HttpClient` already
//! owns, so the token is validated by the first call that needs it, by the code
//! that already knows how.
//!
//! ## What stays distinct
//!
//! `SignedOut`, `SessionExpired` and `Revoked` are three different facts and
//! this does not collapse them:
//!
//! * **No refresh token** is `SignedOut`, unchanged, and no edge is applied.
//! * **A refresh token** is `Registered` — a claim, which the server
//!   adjudicates on the next call. `SessionExpired` and `Revoked` are both
//!   edges out of `Registered`, so restoring is what makes either reachable;
//!   before this, a relaunched app could reach neither.
//! * **A locked store** is an `Err`, distinct from both, and the state is left
//!   exactly as it was so a later call can try again.

use crate::api::errors::AuthError;

use super::{AuthEvent, AuthSession, AuthState};

#[uniffi::export]
impl AuthSession {
    /// Reads the secure store and applies §C.1's restore edge if there is a
    /// session to restore.
    ///
    /// **Synchronous**: it makes no request, so it is a blocking call and
    /// belongs on the shell's serial core queue rather than being awaited
    /// (spec-defect 90).
    ///
    /// Idempotent, and deliberately not `InvalidState` from another state. The
    /// machine's rule is that a call which is not an edge is reported rather
    /// than swallowed, and that rule is about *user actions*: a second sign-in
    /// racing the first is a bug worth naming. This is driven by the process
    /// lifecycle instead — a launch, a return from protected-data-unavailable —
    /// and a lifecycle signal that arrives twice must not be an error the shell
    /// has to learn to suppress. From anything but `SignedOut` it reports the
    /// state it found and touches nothing.
    ///
    /// - Returns: the state after the probe.
    /// - Throws: `SecureStore` when the store could not be read at all. That is
    ///   **not** "no session": call it again once the device is unlocked.
    pub fn restore(&self) -> Result<AuthState, AuthError> {
        let current = self.state_now();
        if current != AuthState::SignedOut {
            return Ok(current);
        }
        // The read is the whole probe. A token that is present but expired is
        // still a session — chapter 02 §2.10's refresh is what decides, and it
        // decides on the first call that needs a token, not here.
        if self.tokens.refresh_token()?.is_none() {
            return Ok(current);
        }
        self.apply(AuthEvent::SessionRestored, "restore a session")
    }
}
