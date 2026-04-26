//! Provider API key storage internals.
//!
//! Raw provider keys live only in the keychain under
//! `SERVICE_VAULT` / `provider-key:<provider>`. Their masked metadata
//! (label, last4, updatedAt) is serialised as JSON and stored
//! separately under `SERVICE_VAULT` / `provider-key-meta:<provider>` so
//! status reads never need to read the raw key back out.
//!
//! `ProviderKeyStatus` is the only type that crosses the IPC boundary;
//! it intentionally has no `raw_key` field, so neither serde output nor
//! `Debug` formatting can leak the secret.
//!
//! Provider names are validated against a fixed allowlist:
//! `openai | anthropic | openrouter | google`. Anything else returns
//! `AppError::Validation` and never touches the keychain.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{AppError, AppResult};
use crate::keychain::{KeychainStore, SERVICE_VAULT};

pub const PROVIDER_OPENAI: &str = "openai";
pub const PROVIDER_ANTHROPIC: &str = "anthropic";
pub const PROVIDER_OPENROUTER: &str = "openrouter";
pub const PROVIDER_GOOGLE: &str = "google";

/// Allowlist of supported provider identifiers. All public entry points
/// validate against this list before reading or writing keychain items.
pub const ALLOWED_PROVIDERS: &[&str] = &[
    PROVIDER_OPENAI,
    PROVIDER_ANTHROPIC,
    PROVIDER_OPENROUTER,
    PROVIDER_GOOGLE,
];

/// Public masked-metadata view of a provider key. Crosses the IPC
/// boundary; never carries the raw key.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeyStatus {
    pub provider: String,
    pub configured: bool,
    pub label: Option<String>,
    pub last4: Option<String>,
    pub updated_at: Option<String>,
}

/// Internal JSON representation of the metadata blob stored under
/// `provider-key-meta:<provider>`. Only masked fields, no raw key.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProviderKeyMetadata {
    label: Option<String>,
    last4: Option<String>,
    updated_at: String,
}

/// Stores `raw_key` under the canonical keychain location and writes a
/// masked metadata blob alongside it. Returns the public status view
/// without echoing the raw key.
pub fn set_provider_key(
    keychain: &dyn KeychainStore,
    provider: &str,
    raw_key: &str,
    label: Option<String>,
    now: SystemTime,
) -> AppResult<ProviderKeyStatus> {
    validate_provider(provider)?;

    let last4 = compute_last4(raw_key);
    let updated_at = iso_8601(now);

    let metadata = ProviderKeyMetadata {
        label: label.clone(),
        last4: Some(last4.clone()),
        updated_at: updated_at.clone(),
    };
    let meta_json = serde_json::to_vec(&metadata)?;

    keychain.set_item(
        SERVICE_VAULT,
        &account_for_raw(provider),
        raw_key.as_bytes(),
    )?;
    keychain.set_item(SERVICE_VAULT, &account_for_meta(provider), &meta_json)?;

    Ok(ProviderKeyStatus {
        provider: provider.to_string(),
        configured: true,
        label,
        last4: Some(last4),
        updated_at: Some(updated_at),
    })
}

/// Returns the masked status for the given provider. When no key is
/// stored, `configured` is `false` and all metadata fields are `None`.
pub fn get_provider_key_status(
    keychain: &dyn KeychainStore,
    provider: &str,
) -> AppResult<ProviderKeyStatus> {
    validate_provider(provider)?;

    let raw_present = keychain
        .get_item(SERVICE_VAULT, &account_for_raw(provider))?
        .is_some();

    if !raw_present {
        return Ok(ProviderKeyStatus {
            provider: provider.to_string(),
            configured: false,
            label: None,
            last4: None,
            updated_at: None,
        });
    }

    let meta = match keychain.get_item(SERVICE_VAULT, &account_for_meta(provider))? {
        Some(bytes) => serde_json::from_slice::<ProviderKeyMetadata>(&bytes)?,
        None => ProviderKeyMetadata {
            label: None,
            last4: None,
            updated_at: String::new(),
        },
    };

    let updated_at = if meta.updated_at.is_empty() {
        None
    } else {
        Some(meta.updated_at)
    };

    Ok(ProviderKeyStatus {
        provider: provider.to_string(),
        configured: true,
        label: meta.label,
        last4: meta.last4,
        updated_at,
    })
}

/// Removes both the raw key and metadata entries for the given
/// provider. Missing entries are not an error.
pub fn delete_provider_key(keychain: &dyn KeychainStore, provider: &str) -> AppResult<()> {
    validate_provider(provider)?;
    keychain.delete_item(SERVICE_VAULT, &account_for_raw(provider))?;
    keychain.delete_item(SERVICE_VAULT, &account_for_meta(provider))?;
    Ok(())
}

fn validate_provider(provider: &str) -> AppResult<()> {
    if ALLOWED_PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "unknown provider: {provider}",
        )))
    }
}

fn account_for_raw(provider: &str) -> String {
    format!("provider-key:{provider}")
}

fn account_for_meta(provider: &str) -> String {
    format!("provider-key-meta:{provider}")
}

fn compute_last4(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = key.chars().collect();
    let take = chars.len().min(4);
    chars[chars.len() - take..].iter().collect()
}

fn iso_8601(ts: SystemTime) -> String {
    let secs = ts
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    crate::vault::frontmatter::unix_secs_to_iso(secs)
}
