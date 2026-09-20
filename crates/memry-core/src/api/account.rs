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

    /// The same read, answering "this account has never been set up" with `nil`
    /// rather than with an error.
    ///
    /// This is what a device asks **before** deciding which screen to show. A
    /// signed-in phone holding no master key is in one of two situations that
    /// look identical locally: the account has a recovery phrase this device
    /// has not been given, or the account has none because nobody finished
    /// setting it up. Asking for the words in the second case is asking for
    /// words that do not exist — which is exactly what a fresh account on
    /// staging did.
    ///
    /// Every other failure still throws. A phone that cannot reach the server
    /// must never be offered a **new** phrase for an account that already has
    /// one.
    pub async fn key_material_if_configured(&self) -> Result<Option<KeyMaterial>, ApiError> {
        account::key_material_if_configured(&self.http()).await
    }

    /// `POST /auth/setup`: publish this account's `{ kdfSalt, keyVerifier }`.
    ///
    /// The caller derives both from a phrase it generated and has already shown
    /// and had confirmed. **Nothing here stores the master key**: the key
    /// belongs in the device's secure store, which is the shell's seam, and a
    /// core writing to a store it does not own is the one thing chapter 02's
    /// split forbids.
    ///
    /// A `409` means another device completed setup first. It crosses rather
    /// than being swallowed: the phrase this device just showed is then not the
    /// account's, and the user has to be told before they write it down.
    pub async fn complete_account_setup(
        &self,
        kdf_salt_base64: String,
        key_verifier: String,
    ) -> Result<(), ApiError> {
        account::complete_setup(&self.http(), &kdf_salt_base64, &key_verifier).await
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
