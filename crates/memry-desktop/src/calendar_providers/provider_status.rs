//! A provider's connection state as the settings UI reads it (`calendar/provider/status.ts`),
//! over the live source rows (`VaultCalendar::sources`, archived rows already dropped). Every
//! provider mutation answers with it.

use memry_core::api::calendar_records::CalendarSourceRecord;
use serde::Serialize;
use serde_json::Value;

/// `CalendarProviderAccountConnectionStatus` (`disconnected` is never built, as in Electron).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AccountConnection {
    Connected,
    ReconnectRequired,
    Error,
}

/// Why a `reconnect_required` account needs attention on this device. `rejected` comes with the
/// sync pass's auth-failure marker (29e2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ReconnectReason {
    Missing,
}

/// `CalendarProviderAccountStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub account_id: String,
    pub email: String,
    pub status: AccountConnection,
    pub last_synced_at: Option<String>,
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub reconnect_reason: Option<ReconnectReason>,
    /// Basic-auth accounts only: what a reconnect form prefills. Never a password.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub preset: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct StatusAccount {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCounts {
    pub total: u32,
    pub selected: u32,
    pub memry_managed: u32,
}

/// `CalendarProviderStatus`, without `capabilities` (only `get-provider-status` attaches them).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: String,
    pub connected: bool,
    pub has_local_auth: bool,
    pub account: Option<StatusAccount>,
    pub accounts: Vec<AccountStatus>,
    pub calendars: CalendarCounts,
    pub last_synced_at: Option<String>,
}

fn text(metadata: &Value, key: &str) -> Option<String> {
    metadata.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// `buildProviderStatus`. `local_auth` is the provider's `hasAccountLocalAuth`; `None` is a
/// provider this build does not run, whose accounts all read `reconnect_required`.
pub fn build(
    provider: &str,
    sources: &[CalendarSourceRecord],
    local_auth: Option<&dyn Fn(&str) -> bool>,
) -> ProviderStatus {
    let own = || sources.iter().filter(|s| s.provider == provider);
    let accounts = own().filter(|s| s.kind == "account").collect::<Vec<_>>();
    let calendars = own().filter(|s| s.kind == "calendar").collect::<Vec<_>>();
    let mut has_local_auth = false;
    let mut statuses = Vec::new();
    for source in &accounts {
        let Some(account_id) = source.account_id.clone() else {
            continue;
        };
        let local = local_auth.is_some_and(|auth| auth(&account_id));
        has_local_auth |= local;
        let metadata = source
            .metadata_json
            .as_deref()
            .and_then(|json| serde_json::from_str::<Value>(json).ok())
            .unwrap_or(Value::Null);
        let basic = text(&metadata, "serverUrl")
            .filter(|s| !s.is_empty())
            .zip(text(&metadata, "username").filter(|s| !s.is_empty()));
        statuses.push(AccountStatus {
            email: text(&metadata, "email").unwrap_or_else(|| source.title.clone()),
            status: if !local {
                AccountConnection::ReconnectRequired
            } else if source.sync_status == "error" {
                AccountConnection::Error
            } else {
                AccountConnection::Connected
            },
            last_synced_at: source.last_synced_at.clone(),
            last_error: source
                .last_error
                .clone()
                .or_else(|| text(&metadata, "lastError")),
            // `accountReconnectReason` without the auth-failure marker: no password here.
            reconnect_reason: (!local && local_auth.is_some()).then_some(ReconnectReason::Missing),
            preset: basic.as_ref().map(|_| text(&metadata, "preset")),
            server_url: basic.as_ref().map(|(url, _)| url.clone()),
            username: basic.map(|(_, user)| user),
            account_id,
        });
    }
    let last_synced_at = accounts
        .iter()
        .chain(&calendars)
        .filter_map(|s| s.last_synced_at.as_deref())
        .filter(|at| !at.is_empty())
        .max()
        .map(str::to_owned);
    ProviderStatus {
        provider: provider.to_owned(),
        connected: !accounts.is_empty(),
        has_local_auth,
        account: accounts.first().map(|s| StatusAccount {
            id: s.id.clone(),
            title: s.title.clone(),
        }),
        accounts: statuses,
        calendars: CalendarCounts {
            total: count(calendars.len()),
            selected: count(calendars.iter().filter(|s| s.is_selected).count()),
            memry_managed: count(calendars.iter().filter(|s| s.is_memry_managed).count()),
        },
        last_synced_at,
    }
}
