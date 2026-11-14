//! The inline AI row and key under test (Step 22, #3539). `specs/editor/ai-keys.e2e.ts` seeds
//! the `ai-inline` row the way Electron left it, around [`InlineAiStore`], and asks where the key
//! of the selected provider is. The key goes in, never out: the answer is two booleans.

use serde::Serialize;
use serde_json::{Map, Value};
use zeroize::Zeroizing;

use crate::ai::provider::AiProvider;
use crate::ai::settings::{GROUP, InlineAiSettings, InlineAiStore, SERVICE};
use crate::seams::secure_store::GenericSecrets;
use crate::session::OpenVault;
use crate::settings::SettingsService;

/// Writes `patch` into the `ai-inline` row as stored, with no key move.
pub fn seed_row(
    settings: &SettingsService,
    vault: &OpenVault,
    patch: Map<String, Value>,
) -> Result<(), String> {
    settings
        .write_secret_group(vault, GROUP, patch)
        .map_err(|error| error.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyState {
    /// The keychain holds `expected` for the provider and origin the row selects.
    pub keychain_matches: bool,
    /// The row's `apiKey` is absent or empty.
    pub row_key_empty: bool,
}

/// Where the key of the row's selection is, read from the keychain itself, not the store's cache.
pub fn key_state(
    store: &InlineAiStore,
    settings: &SettingsService,
    secrets: &dyn GenericSecrets,
    vault: &OpenVault,
    expected: &str,
) -> Result<KeyState, String> {
    let row = settings
        .read_secret_group(vault, GROUP)
        .map_err(|error| error.to_string())?;
    let defaults = InlineAiSettings::default();
    let provider = row
        .get("provider")
        .and_then(|value| serde_json::from_value::<AiProvider>(value.clone()).ok())
        .unwrap_or(defaults.provider);
    let base_url = row
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or(&defaults.base_url);
    let keychain_matches = match store.key_account(&vault.vault_id, provider, base_url) {
        Some(account) => secrets
            .get_secret(SERVICE, &account)
            .map_err(|error| error.to_string())?
            .map(Zeroizing::new)
            .is_some_and(|key| key.as_slice() == expected.as_bytes()),
        None => false,
    };
    Ok(KeyState {
        keychain_matches,
        row_key_empty: row
            .get("apiKey")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty),
    })
}
