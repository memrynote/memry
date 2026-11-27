//! Calendar provider settings: each provider's `calendar.<providerId>` group, as desktop's
//! `provider-settings.ts` reads and writes it. Core owns the groups, their defaults and which
//! leaves sync; a provider is known when its group exists there.

use serde_json::{Map, Value};

use memry_core::domain::app_settings::{AppSettings, SettingsChange, group_defaults, value_ok};

use super::{Read, SettingsError, SettingsService};
use crate::session::OpenVault;

/// The base group and every provider group: the ones [`promote_stranded`] runs over.
const GROUPS: &[&str] = &[
    "calendar",
    "calendar.google",
    "calendar.caldav",
    "calendar.ics",
    "calendar.apple-eventkit",
];

/// Electron's `unsupportedProviderError`, byte for byte (`provider/registry.ts`).
pub fn unsupported_provider(provider: &str) -> SettingsError {
    SettingsError::Invalid(format!("Unsupported calendar provider: {provider}"))
}

/// The English text of `errors:calendar.invalidProviderSettings`.
const INVALID_PROVIDER_SETTINGS: &str = "Invalid calendar provider settings";

/// `calendar.<provider>` when core has that group.
fn provider_group(provider: &str) -> Option<String> {
    let group = format!("calendar.{provider}");
    (!provider.is_empty() && !provider.contains('.') && group_defaults(&group).is_some())
        .then_some(group)
}

/// `sanitizeCalendarProviderSettingsUpdates`: only the fields the group declares survive, and
/// one of the wrong type refuses the whole update.
fn sanitize(group: &str, updates: Map<String, Value>) -> Result<Map<String, Value>, SettingsError> {
    let Some(Value::Object(defaults)) = group_defaults(group) else {
        return Err(SettingsError::Invalid(INVALID_PROVIDER_SETTINGS.to_owned()));
    };
    let mut clean = Map::new();
    for (field, value) in updates {
        if !defaults.contains_key(&field) {
            continue;
        }
        if !value_ok(group, &field, &value) {
            return Err(SettingsError::Invalid(INVALID_PROVIDER_SETTINGS.to_owned()));
        }
        clean.insert(field, value);
    }
    Ok(clean)
}

impl SettingsService {
    /// A provider's group with its defaults, `None` for a provider this build does not know
    /// (`settings:getCalendarProviderSettings` answers `null`).
    pub fn read_calendar_provider(
        &self,
        vault: Option<&OpenVault>,
        provider: &str,
    ) -> Result<Option<Read>, SettingsError> {
        let Some(group) = provider_group(provider) else {
            return Ok(None);
        };
        self.read_group(vault, &group).map(Some)
    }

    /// Writes the declared fields of `updates` to a provider's group.
    pub fn write_calendar_provider(
        &self,
        vault: Option<&OpenVault>,
        provider: &str,
        updates: Map<String, Value>,
    ) -> Result<SettingsChange, SettingsError> {
        let group = provider_group(provider).ok_or_else(|| unsupported_provider(provider))?;
        let clean = sanitize(&group, updates)?;
        self.write_group(vault, &group, clean)
    }
}

/// On vault open: the calendar leaves an earlier build kept in the local groups move into the
/// synced item (see `AppSettings::promote_stranded`). A failure leaves them where they were and
/// never blocks the open.
pub(super) fn promote_stranded(settings: &AppSettings) {
    for group in GROUPS {
        match settings.promote_stranded(group) {
            Ok(0) => {}
            Ok(promoted) => tracing::info!(
                scope = "Settings",
                "promoted {promoted} calendar settings of `{group}` into settings sync"
            ),
            Err(error) => tracing::warn!(
                scope = "Settings",
                "could not promote the calendar settings of `{group}`: {error}"
            ),
        }
    }
}
