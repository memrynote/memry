//! The two account-scoped reads an unlocked app makes right after it has a
//! session: the key material it unlocks with, and the vaults it can route to.
//!
//! Both are methods on [`AuthSession`] rather than on a new object. The band B3
//! table names a `Client` owning "account identity, tokens, device
//! registration, the runtime", and `AuthSession` is already three of those
//! four; a second object over the same account would need the same
//! authenticated `HttpClient`, and `AuthSession::http`'s own comment says why
//! a second `TokenManager` over the same keychain entries is a device
//! revocation waiting to happen (chapter 02 §2.9). One object, one token
//! manager.
//!
//! **Neither read checks the machine's state, deliberately.** A session
//! restored from the keychain on a cold launch is `SignedOut` in memory while
//! holding a perfectly good refresh token, so a state guard here would refuse
//! the one call the unlock screen makes on exactly the launch it matters. What
//! decides is the token manager: no token is a `401`, and a `401` on an
//! `Auth::Session` request is the refresh-and-replay path the HTTP client
//! already owns.

use crate::api::auth::AuthSession;
use crate::api::errors::ApiError;
use crate::protocol::account::{self, KeyMaterial, VaultSummary};

#[uniffi::export(async_runtime = "tokio")]
impl AuthSession {
    /// `GET /auth/key-verifier`, chapter 02 §2.1.1: `{ kdfSalt, keyVerifier }`.
    ///
    /// The salt is base64 per chapter 01 §1.1 and the verifier is base64 per
    /// §1.4.1, and both cross as `String` rather than as `Data` because §1.4.1
    /// requires the verifier comparison to happen over the encoded strings —
    /// handing Swift decoded bytes would make the wrong comparison the easy one
    /// to write (`core-api.md` rule 1). Neither value is a key.
    ///
    /// §2.7.1: on **this** route the account is already known, so a verifier
    /// mismatch does mean "wrong recovery phrase" — unlike `GET /auth/recovery`,
    /// whose dummy answer makes a wrong email indistinguishable from one.
    pub async fn key_material(&self) -> Result<KeyMaterial, ApiError> {
        account::key_material(&self.http()).await
    }

    /// `GET /sync/vaults`, chapter 05 §5.1. FR-021's "choose one and route to
    /// it" is this list plus the `X-Memry-Vault-Id` header.
    ///
    /// An empty list means the account holds no vaults and never "the rows
    /// could not be read": a row whose id does not parse fails the whole read
    /// with `MalformedResponse`. That rule is not decoration — the reader this
    /// one calls once used `filter_map` and reported "this account has no
    /// vaults" against an account holding four.
    pub async fn vaults(&self) -> Result<Vec<VaultSummary>, ApiError> {
        account::vaults(&self.http()).await
    }
}
