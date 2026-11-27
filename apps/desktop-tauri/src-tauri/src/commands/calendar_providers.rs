//! The calendar provider connect flow (#3546 29e): the commands of `ipc/calendar-handlers.ts:
//! 462-575` that connect, disconnect, test ("discover") and writer-check a provider, each one call
//! of `memry_desktop::calendar_providers::caldav_accounts::CaldavAccounts`. Only CalDAV runs
//! here; any other provider answers `Unsupported calendar provider: <id>`
//! (`registry.ts:114`, byte-identical). A connect failure answers `success: false` with its
//! `errorCode`; an input the schema refuses, or any other failure, throws.

use std::sync::Arc;

use memry_desktop::account::AccountService;
use memry_desktop::calendar_providers::caldav_accounts::{
    BasicConnection, CaldavAccounts, CaldavError, Connection, non_empty,
};
use memry_desktop::calendar_providers::caldav_discover::ConnectCode;
use memry_desktop::calendar_providers::caldav_sync::SyncError;
use memry_desktop::calendar_providers::caldav_transport::{self, CaldavHttp};
use memry_desktop::calendar_providers::credentials::ProviderCredentials;
use memry_desktop::calendar_providers::provider_status::ProviderStatus;
use memry_desktop::calendar_providers::writer_compat::{self, WriterCompat};
use memry_desktop::error::CoreError;
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::paths::DEVICE_VAR;
use memry_desktop::seams::secure_store::{DeviceIdentityStore, KeyringStore};
use memry_desktop::session::{OpenVault, Session};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};

use super::error::{CommandError, ErrorKind, log_failure};
use super::notes::open_vault;

const SCOPE: &str = "calendar_providers";
const CALDAV: &str = "caldav";

/// `kind: 'url'` of `CalendarProviderConnectionSchema`.
#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UrlConnectionInput {
    pub url: String,
    #[serde(default)]
    #[specta(optional)]
    pub title: Option<String>,
}

/// `kind: 'basic'`. No `Debug`: it carries the password.
#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BasicConnectionInput {
    pub server_url: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    #[specta(optional)]
    pub preset: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub selected_calendar_ids: Option<Vec<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub acknowledge_outdated_devices: Option<bool>,
}

/// `CalendarProviderConnectionSchema`.
#[derive(Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProviderConnectionInput {
    Url(UrlConnectionInput),
    Basic(BasicConnectionInput),
}

/// `CalendarProviderRequestSchema`.
#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequestInput {
    pub provider: String,
    #[serde(default)]
    #[specta(optional)]
    pub account_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub source_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub connection: Option<ProviderConnectionInput>,
    /// Read by `get-provider-status` only.
    #[serde(default)]
    #[specta(optional)]
    pub include_capabilities: Option<bool>,
}

/// `DiscoverProviderCalendarsSchema`.
#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverProviderInput {
    pub provider: String,
    pub connection: ProviderConnectionInput,
}

/// `CheckProviderWriterCompatSchema`.
#[derive(Debug, Deserialize, specta::Type)]
pub struct WriterCompatInput {
    pub provider: String,
}

/// `CalendarProviderMutationResponse`.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMutationView {
    pub success: bool,
    pub status: ProviderStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error_code: Option<ConnectCode>,
}

/// `DiscoveredProviderCalendar`.
#[derive(Debug, Serialize, specta::Type)]
pub struct DiscoveredCalendarView {
    /// The collection URL.
    pub id: String,
    pub title: String,
    pub color: Option<String>,
}

/// `DiscoverProviderCalendarsResponse`.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverView {
    pub success: bool,
    pub calendars: Vec<DiscoveredCalendarView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error_code: Option<ConnectCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

impl DiscoverView {
    fn refused(error_code: Option<ConnectCode>, error: Option<String>) -> Self {
        Self {
            success: false,
            calendars: Vec::new(),
            error_code,
            error,
        }
    }
}

fn unsupported(provider: &str) -> String {
    format!("Unsupported calendar provider: {provider}")
}

fn thrown(command: &str, error: &impl CoreError) -> CommandError {
    let error = CommandError::from_core(error);
    log_failure(command, &error);
    error
}

/// The service, built on first use from the app's keychain and device identity.
fn accounts(app: &AppHandle<Wry>) -> Result<Arc<CaldavAccounts>, CommandError> {
    if let Some(accounts) = app.try_state::<Arc<CaldavAccounts>>() {
        return Ok(accounts.inner().clone());
    }
    let unavailable = |what: &str| {
        CommandError::new(
            ErrorKind::Internal,
            "calendar_providers_unavailable",
            format!("calendar providers cannot run: {what}"),
        )
    };
    let keychain = app
        .try_state::<Arc<KeyringStore>>()
        .ok_or_else(|| unavailable("no keychain"))?
        .inner()
        .clone();
    let identity = app
        .try_state::<Arc<DeviceIdentityStore>>()
        .ok_or_else(|| unavailable("no device identity"))?
        .inner()
        .clone();
    let device = app.state::<LaunchEnv>().get(DEVICE_VAR).map(str::to_owned);
    let http = CaldavHttp::new(memry_desktop::http::builder(), caldav_transport::TIMEOUT)
        .map_err(|error| unavailable(&error.to_string()))?;
    app.manage(Arc::new(CaldavAccounts::new(
        http,
        ProviderCredentials::new(keychain, device),
        identity,
    )));
    // A concurrent first call may have managed its own first; both use the one that won.
    Ok(app.state::<Arc<CaldavAccounts>>().inner().clone())
}

fn connection(input: ProviderConnectionInput) -> Result<Connection, CaldavError> {
    match input {
        ProviderConnectionInput::Url(url) => Connection::url(&url.url, url.title.as_deref()),
        ProviderConnectionInput::Basic(basic) => BasicConnection {
            server_url: basic.server_url,
            username: basic.username,
            password: basic.password.into(),
            preset: basic.preset,
            selected_calendar_ids: basic.selected_calendar_ids,
            acknowledge_outdated_devices: basic.acknowledge_outdated_devices.unwrap_or(false),
        }
        .checked()
        .map(Connection::Basic),
    }
}

/// The schema's checks of a provider request; the connection, when sent.
fn request(
    input: ProviderRequestInput,
) -> Result<(String, Option<String>, Option<Connection>), CaldavError> {
    non_empty("provider", &input.provider)?;
    for (field, value) in [
        ("accountId", &input.account_id),
        ("sourceId", &input.source_id),
    ] {
        if let Some(value) = value {
            non_empty(field, value)?;
        }
    }
    let connection = input.connection.map(connection).transpose()?;
    Ok((input.provider, input.account_id, connection))
}

async fn answer(
    accounts: &CaldavAccounts,
    open: &OpenVault,
    provider: &str,
    failure: Option<(Option<ConnectCode>, String)>,
) -> Result<ProviderMutationView, CaldavError> {
    let status = accounts.status(open, provider).await?;
    Ok(match failure {
        None => ProviderMutationView {
            success: true,
            status,
            error: None,
            error_code: None,
        },
        Some((error_code, error)) => ProviderMutationView {
            success: false,
            status,
            error: Some(error),
            error_code,
        },
    })
}

/// `calendar:connect-provider`.
#[tauri::command]
#[specta::specta]
pub async fn calendar_connect_provider(
    app: AppHandle<Wry>,
    input: ProviderRequestInput,
) -> Result<ProviderMutationView, CommandError> {
    const COMMAND: &str = "calendar_connect_provider";
    let (provider, _, connection) = request(input).map_err(|e| thrown(COMMAND, &e))?;
    let open = open_vault(&app)?;
    let accounts = accounts(&app)?;
    if provider != CALDAV {
        return answer(
            &accounts,
            &open,
            &provider,
            Some((None, unsupported(&provider))),
        )
        .await
        .map_err(|e| thrown(COMMAND, &e));
    }
    let outcome = match &connection {
        Some(Connection::Basic(basic)) => accounts
            .connect(
                &app.state::<Session>(),
                &open,
                basic,
                &account_service(&app)?,
            )
            .await
            .map(|_| ()),
        _ => Err(CaldavError::Connect(ConnectCode::InvalidUrl)),
    };
    let failure = match outcome {
        Ok(()) => {
            // `connectCaldav`'s `void syncCaldavNow(db)`: the answer does not wait for it.
            let (sync, open) = (accounts.sync(), open.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(error) = sync.sync_and_drain(&open, None).await {
                    tracing::warn!(
                        scope = SCOPE,
                        "first CalDAV sync after connect failed: {error}"
                    );
                }
            });
            None
        }
        Err(CaldavError::Connect(code)) => {
            tracing::warn!(
                scope = SCOPE,
                code = code.as_str(),
                "calendar provider connect failed"
            );
            Some((Some(code), code.as_str().to_owned()))
        }
        Err(error) => return Err(thrown(COMMAND, &error)),
    };
    answer(&accounts, &open, &provider, failure)
        .await
        .map_err(|e| thrown(COMMAND, &e))
}

/// `calendar:refresh-provider` (`caldav-provider.ts:91-115`): the push drain, then with `sourceId`
/// that calendar's pull (its Retry), otherwise every account's (or `accountId`'s). A failure
/// answers `sync_failed`. The answer carries no `source` until the source view lands (#4894).
#[tauri::command]
#[specta::specta]
pub async fn calendar_refresh_provider(
    app: AppHandle<Wry>,
    input: ProviderRequestInput,
) -> Result<ProviderMutationView, CommandError> {
    const COMMAND: &str = "calendar_refresh_provider";
    let source_id = input.source_id.clone();
    let (provider, account_id, _) = request(input).map_err(|e| thrown(COMMAND, &e))?;
    let open = open_vault(&app)?;
    let accounts = accounts(&app)?;
    if provider != CALDAV {
        return answer(
            &accounts,
            &open,
            &provider,
            Some((None, unsupported(&provider))),
        )
        .await
        .map_err(|e| thrown(COMMAND, &e));
    }
    let sync = accounts.sync();
    let outcome = match source_id {
        Some(source) => sync.sync_source_and_drain(&open, &source).await,
        None => sync.sync_and_drain(&open, account_id.as_deref()).await,
    };
    let failure = match outcome {
        Ok(()) => None,
        Err(error @ (SyncError::Storage(_) | SyncError::Auth(_) | SyncError::Task(_))) => {
            return Err(thrown(COMMAND, &error));
        }
        Err(error) => {
            tracing::warn!(scope = SCOPE, "calendar provider refresh failed: {error}");
            Some((Some(ConnectCode::SyncFailed), error.to_string()))
        }
    };
    answer(&accounts, &open, &provider, failure)
        .await
        .map_err(|e| thrown(COMMAND, &e))
}

/// `calendar:disconnect-provider`.
#[tauri::command]
#[specta::specta]
pub async fn calendar_disconnect_provider(
    app: AppHandle<Wry>,
    input: ProviderRequestInput,
) -> Result<ProviderMutationView, CommandError> {
    const COMMAND: &str = "calendar_disconnect_provider";
    let (provider, account_id, _) = request(input).map_err(|e| thrown(COMMAND, &e))?;
    let open = open_vault(&app)?;
    let accounts = accounts(&app)?;
    let failure = if provider == CALDAV {
        accounts
            .disconnect(&open, account_id.as_deref())
            .await
            .map_err(|e| thrown(COMMAND, &e))?;
        None
    } else {
        Some((None, unsupported(&provider)))
    };
    answer(&accounts, &open, &provider, failure)
        .await
        .map_err(|e| thrown(COMMAND, &e))
}

/// `calendar:discover-provider-calendars`: the form's "Test connection"; saves nothing.
#[tauri::command]
#[specta::specta]
pub async fn calendar_discover_provider_calendars(
    app: AppHandle<Wry>,
    input: DiscoverProviderInput,
) -> Result<DiscoverView, CommandError> {
    const COMMAND: &str = "calendar_discover_provider_calendars";
    let checked =
        non_empty("provider", &input.provider).and_then(|()| connection(input.connection));
    let connection = checked.map_err(|e| thrown(COMMAND, &e))?;
    if input.provider != CALDAV {
        return Ok(DiscoverView::refused(
            None,
            Some(unsupported(&input.provider)),
        ));
    }
    let Connection::Basic(basic) = connection else {
        return Ok(DiscoverView::refused(Some(ConnectCode::InvalidUrl), None));
    };
    match accounts(&app)?.discover(&basic).await {
        Ok(found) => Ok(DiscoverView {
            success: true,
            calendars: found
                .info
                .calendars
                .into_iter()
                .map(|c| DiscoveredCalendarView {
                    id: c.url,
                    title: c.display_name,
                    color: c.color,
                })
                .collect(),
            error_code: None,
            error: None,
        }),
        Err(CaldavError::Connect(code)) => Ok(DiscoverView::refused(
            Some(code),
            Some(code.as_str().to_owned()),
        )),
        Err(error) => Err(thrown(COMMAND, &error)),
    }
}

/// `calendar:check-provider-writer-compat`.
#[tauri::command]
#[specta::specta]
pub async fn calendar_check_provider_writer_compat(
    app: AppHandle<Wry>,
    input: WriterCompatInput,
) -> Result<WriterCompat, CommandError> {
    const COMMAND: &str = "calendar_check_provider_writer_compat";
    non_empty("provider", &input.provider).map_err(|e| thrown(COMMAND, &e))?;
    open_vault(&app)?;
    Ok(writer_compat::check(&input.provider, &account_service(&app)?).await)
}

fn account_service(app: &AppHandle<Wry>) -> Result<Arc<AccountService>, CommandError> {
    app.try_state::<Arc<AccountService>>()
        .map(|account| account.inner().clone())
        .ok_or_else(|| {
            CommandError::new(
                ErrorKind::Internal,
                "account_unavailable",
                "no account service",
            )
        })
}
