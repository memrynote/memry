//! Account-level state: cached user identity in `settings`, sign-out
//! cleanup of auth tokens, and recovery-confirmation tracking.
//!
//! All persisted account fields live under the canonical settings keys
//! declared at the top of this module. Renderer code never sees these
//! keys directly: M4 commands read/write through the helpers here so a
//! future migration can rename them without touching the renderer.
//!
//! Sign-out clears the access/refresh/setup tokens stored in the
//! keychain under `SERVICE_VAULT`. It deliberately leaves the master
//! key, recovery phrase, and any provider keys in place so that the
//! local vault remains usable after sign-out.

use crate::app_state::AppState;
use crate::db::settings;
use crate::error::AppResult;
use crate::keychain::SERVICE_VAULT;

/// Settings key for the cached server-issued user id.
pub const ACCOUNT_USER_ID: &str = "account.userId";
/// Settings key for the cached account email.
pub const ACCOUNT_EMAIL: &str = "account.email";
/// Settings key for the auth provider that minted the current session
/// (e.g. `otp`, `google`).
pub const ACCOUNT_AUTH_PROVIDER: &str = "account.authProvider";
/// Settings key for the user-confirmed recovery phrase flag.
pub const ACCOUNT_RECOVERY_CONFIRMED: &str = "account.recoveryConfirmed";

/// Keychain accounts under `SERVICE_VAULT` that sign-out clears.
pub const KEYCHAIN_ACCESS_TOKEN: &str = "access-token";
pub const KEYCHAIN_REFRESH_TOKEN: &str = "refresh-token";
pub const KEYCHAIN_SETUP_TOKEN: &str = "setup-token";

/// Persisted view of the signed-in account. `auth_provider` tracks
/// which provider issued the most recent session token so the renderer
/// can show the correct "Sign out from <provider>" affordance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountInfo {
    pub user_id: String,
    pub email: String,
    pub auth_provider: String,
}

pub fn set_account_info(state: &AppState, info: &AccountInfo) -> AppResult<()> {
    settings::set(&state.db, ACCOUNT_USER_ID, &info.user_id)?;
    settings::set(&state.db, ACCOUNT_EMAIL, &info.email)?;
    settings::set(&state.db, ACCOUNT_AUTH_PROVIDER, &info.auth_provider)?;
    Ok(())
}

/// Returns the cached account identity, if all three canonical fields
/// are set. A partial state (only email but no user id) returns
/// `Ok(None)` so callers do not act on an incomplete record.
pub fn get_account_info(state: &AppState) -> AppResult<Option<AccountInfo>> {
    let user_id = settings::get(&state.db, ACCOUNT_USER_ID)?;
    let email = settings::get(&state.db, ACCOUNT_EMAIL)?;
    let auth_provider = settings::get(&state.db, ACCOUNT_AUTH_PROVIDER)?;

    match (user_id, email, auth_provider) {
        (Some(user_id), Some(email), Some(auth_provider)) => Ok(Some(AccountInfo {
            user_id,
            email,
            auth_provider,
        })),
        _ => Ok(None),
    }
}

pub fn clear_account_info(state: &AppState) -> AppResult<()> {
    settings::set(&state.db, ACCOUNT_USER_ID, "")?;
    settings::set(&state.db, ACCOUNT_EMAIL, "")?;
    settings::set(&state.db, ACCOUNT_AUTH_PROVIDER, "")?;
    Ok(())
}

pub fn get_recovery_confirmed(state: &AppState) -> AppResult<bool> {
    Ok(settings::get_bool(&state.db, ACCOUNT_RECOVERY_CONFIRMED)?.unwrap_or(false))
}

pub fn set_recovery_confirmed(state: &AppState, value: bool) -> AppResult<()> {
    settings::set_bool(&state.db, ACCOUNT_RECOVERY_CONFIRMED, value)
}

/// Local sign-out: clears the access, refresh, and setup tokens from
/// the keychain. Leaves the master key, recovery phrase, provider
/// keys, and account settings intact so the user can sign back in
/// against the same local vault without re-derivation.
///
/// The auth runtime is *not* locked here: the caller decides whether a
/// soft sign-out (keep vault unlocked) or a hard sign-out (also lock
/// the runtime) makes sense for the calling flow.
pub fn sign_out(state: &AppState) -> AppResult<()> {
    let kc = state.auth.keychain();
    kc.delete_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN)?;
    kc.delete_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN)?;
    kc.delete_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN)?;
    Ok(())
}
