//! The CalDAV connect flow (`caldav/caldav-connect.ts:83-254`, `caldav-provider.ts:55-89,140-155,
//! 210-228`): discovery that saves nothing (the form's "Test connection"), connect after the
//! writer check, disconnect, and the provider's status. Discovery is [`super::caldav_discover`]
//! over [`super::caldav_transport`]; the rows are the core's (`VaultCalendar::caldav_connect`,
//! `caldav_disconnect`); the password lives in this device's keychain only
//! ([`super::credentials`]). Every core and keychain call runs on a blocking thread.
//!
//! The first sync after connect and the device-local auth-failure marker belong to the sync pass
//! (29e2), its only writer.

use std::sync::Arc;

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::calendar::VaultCalendar;
use memry_core::api::calendar_provider_sync::{CalendarCaldavCalendar, CalendarCaldavConnect};
use memry_core::api::errors::{AuthError, StorageError};
use memry_core::domain::calendar_items::providers::CALDAV;
use memry_core::domain::calendar_items::providers::caldav::{account_id, normalize_server_url};
use memry_core::seams::secure_store::SecureStore;
use url::Url;
use zeroize::Zeroizing;

use super::caldav_discover::{self, AccountInfo, ConnectCode, classify};
use super::caldav_transport::CaldavHttp;
use super::credentials::{CredentialError, ProviderCredentials, SecretKind};
use super::provider_status::{self, ProviderStatus};
use super::writer_compat::{self, AccountDevices};
use crate::error::{CoreError, FailureKind};
use crate::session::{OpenVault, Session};

const SCOPE: &str = "calendar_caldav";

/// `CalendarProviderConnectionSchema`'s bounds, in UTF-16 units after the trims it applies.
const MAX_URL: usize = 4096;
const MAX_TITLE: usize = 200;
const MAX_USERNAME: usize = 320;
const MAX_PASSWORD: usize = 1024;
const MAX_PRESET: usize = 64;
const MAX_SELECTED: usize = 500;

#[derive(Debug, thiserror::Error)]
pub enum CaldavError {
    /// The provider's `success: false` with an `errorCode`.
    #[error("{}", .0.as_str())]
    Connect(ConnectCode),
    /// The schema refused the input, which Electron's validated handler throws.
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error(transparent)]
    Credential(#[from] CredentialError),
    #[error("a calendar task failed: {0}")]
    Task(String),
    /// The vault the connect started on closed during its discovery.
    #[error("the vault closed")]
    Closed,
}

impl CoreError for CaldavError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Connect(code) => (FailureKind::Invalid, code.as_str()),
            Self::Invalid(_) => (FailureKind::Invalid, "invalid"),
            Self::Storage(error) => error.kind_and_code(),
            Self::Auth(error) => error.kind_and_code(),
            Self::Credential(CredentialError::Store(error)) => error.kind_and_code(),
            Self::Credential(_) => (FailureKind::Invalid, "invalid"),
            Self::Task(_) => (FailureKind::Internal, "task_failed"),
            Self::Closed => (FailureKind::Invalid, "no_vault_open"),
        }
    }
}

fn bounded(field: &str, value: &str, min: usize, max: usize) -> Result<(), CaldavError> {
    let len = value.encode_utf16().count();
    if (min..=max).contains(&len) {
        Ok(())
    } else {
        Err(CaldavError::Invalid(format!(
            "{field} must be {min} to {max} characters"
        )))
    }
}

/// `z.string().min(1)` for the request's ids.
pub fn non_empty(field: &str, value: &str) -> Result<(), CaldavError> {
    bounded(field, value, 1, usize::MAX)
}

/// `CalendarProviderConnectionSchema`, checked.
pub enum Connection {
    /// `kind: 'url'`, a subscribed-calendar link: CalDAV answers it `invalid_url`.
    Url,
    Basic(BasicConnection),
}

impl Connection {
    pub fn url(url: &str, title: Option<&str>) -> Result<Self, CaldavError> {
        bounded("url", url.trim(), 1, MAX_URL)?;
        if let Some(title) = title {
            bounded("title", title.trim(), 0, MAX_TITLE)?;
        }
        Ok(Self::Url)
    }
}

/// The `kind: 'basic'` form.
pub struct BasicConnection {
    pub server_url: String,
    pub username: String,
    pub password: Zeroizing<String>,
    /// The server preset the user picked, kept for the reconnect form.
    pub preset: Option<String>,
    /// Collection URLs to show; `None` keeps each calendar's choice (every one when new).
    pub selected_calendar_ids: Option<Vec<String>>,
    pub acknowledge_outdated_devices: bool,
}

impl BasicConnection {
    /// The schema's trims and bounds (the password is neither trimmed nor read here).
    pub fn checked(mut self) -> Result<Self, CaldavError> {
        self.server_url = self.server_url.trim().to_owned();
        self.username = self.username.trim().to_owned();
        self.preset = self.preset.map(|preset| preset.trim().to_owned());
        bounded("serverUrl", &self.server_url, 1, MAX_URL)?;
        bounded("username", &self.username, 1, MAX_USERNAME)?;
        bounded("password", &self.password, 1, MAX_PASSWORD)?;
        if let Some(preset) = &self.preset {
            bounded("preset", preset, 0, MAX_PRESET)?;
        }
        if let Some(ids) = &self.selected_calendar_ids {
            if ids.len() > MAX_SELECTED {
                return Err(CaldavError::Invalid(format!(
                    "at most {MAX_SELECTED} calendars can be selected"
                )));
            }
            for id in ids {
                bounded("selectedCalendarIds", id, 1, MAX_URL)?;
            }
        }
        Ok(self)
    }
}

/// What discovery found, under the normalized server URL the account id is derived from.
pub struct Discovered {
    pub server_url: String,
    pub info: AccountInfo,
}

pub struct CaldavAccounts {
    http: CaldavHttp,
    credentials: Arc<ProviderCredentials>,
    /// The device identity: the rows' clock entries are this device's.
    store: Arc<dyn SecureStore>,
    /// Serialises connect's writes (password, then rows) with disconnect, so neither lands
    /// between the other's steps.
    writes: tokio::sync::Mutex<()>,
}

impl CaldavAccounts {
    pub fn new(
        http: CaldavHttp,
        credentials: ProviderCredentials,
        store: Arc<dyn SecureStore>,
    ) -> Self {
        Self {
            http,
            credentials: Arc::new(credentials),
            store,
            writes: tokio::sync::Mutex::new(()),
        }
    }

    /// `discoverCaldavCalendars`: saves nothing. A server with no event calendar is
    /// `no_calendars`.
    pub async fn discover(&self, connection: &BasicConnection) -> Result<Discovered, CaldavError> {
        let server_url = normalize_server_url(&connection.server_url)
            .ok_or(CaldavError::Connect(ConnectCode::InvalidUrl))?;
        let server =
            Url::parse(&server_url).map_err(|_| CaldavError::Connect(ConnectCode::InvalidUrl))?;
        let host = server.host_str().unwrap_or_default().to_owned();
        let transport = self.http.transport(
            &server,
            connection.username.trim(),
            connection.password.as_str(),
        );
        let info = match caldav_discover::discover(&transport, &server).await {
            Ok(info) => info,
            Err(error) => {
                let code = classify(&error, transport.last_failure().as_ref());
                tracing::info!(
                    scope = SCOPE,
                    host,
                    code = code.as_str(),
                    "CalDAV discovery failed: {error}"
                );
                return Err(CaldavError::Connect(code));
            }
        };
        if info.calendars.is_empty() {
            return Err(CaldavError::Connect(ConnectCode::NoCalendars));
        }
        Ok(Discovered { server_url, info })
    }

    /// `connectCaldav`: the writer check, discovery, then the password and the rows. A
    /// reconnect of the same server and user revives the same rows and keeps each calendar's
    /// choice unless `selected_calendar_ids` says otherwise. Returns the account id.
    pub async fn connect(
        &self,
        session: &Session,
        open: &OpenVault,
        connection: &BasicConnection,
        account: &impl AccountDevices,
    ) -> Result<String, CaldavError> {
        let compat = writer_compat::check(CALDAV, account).await;
        if !compat.allows_connect(connection.acknowledge_outdated_devices) {
            return Err(CaldavError::Connect(ConnectCode::OutdatedDevices));
        }
        let Discovered { server_url, info } = self.discover(connection).await?;
        if !still_open(session, open) {
            return Err(CaldavError::Closed);
        }
        let _writes = self.writes.lock().await;
        let calendar = self.calendar(open).await?;
        let username = connection.username.trim().to_owned();
        let id = account_id(&server_url, &username);
        let (credentials, key, password) = (
            self.credentials.clone(),
            id.clone(),
            connection.password.clone(),
        );
        blocking(move || credentials.set(CALDAV, &key, SecretKind::Password, Some(&password)))
            .await??;
        let count = info.calendars.len();
        let input = CalendarCaldavConnect {
            server_url,
            username,
            principal_url: info.principal_url,
            home_url: info.home_url,
            preset: connection.preset.clone(),
            calendars: info
                .calendars
                .into_iter()
                .map(|c| CalendarCaldavCalendar {
                    url: c.url,
                    display_name: c.display_name,
                    color: c.color,
                    timezone: c.timezone,
                    supports_sync_collection: c.supports_sync_collection,
                })
                .collect(),
            selected: connection.selected_calendar_ids.clone(),
        };
        let connected = blocking(move || calendar.caldav_connect(input)).await??;
        tracing::info!(
            scope = SCOPE,
            calendars = count,
            "connected a CalDAV account"
        );
        Ok(connected)
    }

    /// `disconnectCaldavAccount`: one account, or every live one. This device forgets each
    /// password (a failure is logged), then the mirrors go and the rows are tombstoned (synced).
    /// Returns how many accounts it touched.
    pub async fn disconnect(
        &self,
        open: &OpenVault,
        account_id: Option<&str>,
    ) -> Result<usize, CaldavError> {
        let _writes = self.writes.lock().await;
        let calendar = self.calendar(open).await?;
        let reader = calendar.clone();
        let sources = blocking(move || reader.sources()).await??;
        let mut ids: Vec<String> = Vec::new();
        let live = sources
            .iter()
            .filter(|s| s.provider == CALDAV && s.kind == "account")
            .filter_map(|s| s.account_id.as_deref());
        for id in live.chain(account_id) {
            if account_id.is_none_or(|wanted| wanted == id) && !ids.iter().any(|known| known == id)
            {
                ids.push(id.to_owned());
            }
        }
        for id in &ids {
            let (credentials, key) = (self.credentials.clone(), id.clone());
            if let Err(error) =
                blocking(move || credentials.delete(CALDAV, &key, SecretKind::Password)).await?
            {
                tracing::warn!(scope = SCOPE, "could not forget a CalDAV password: {error}");
            }
            let (writer, key) = (calendar.clone(), id.clone());
            blocking(move || writer.caldav_disconnect(key)).await??;
        }
        Ok(ids.len())
    }

    /// `buildProviderStatus(db, provider)`. Only CalDAV runs here; another provider's accounts
    /// read `reconnect_required`.
    pub async fn status(
        &self,
        open: &OpenVault,
        provider: &str,
    ) -> Result<ProviderStatus, CaldavError> {
        let calendar = self.calendar(open).await?;
        let sources = blocking(move || calendar.sources()).await??;
        let (credentials, provider) = (self.credentials.clone(), provider.to_owned());
        blocking(move || {
            let has_password = |account: &str| has_password(&credentials, account);
            let local_auth: Option<&dyn Fn(&str) -> bool> =
                (provider == CALDAV).then_some(&has_password);
            provider_status::build(&provider, &sources, local_auth)
        })
        .await
    }

    /// The calendar under this device's identity, minted on a device that never signed in, as
    /// its first settings write does.
    async fn calendar(&self, open: &OpenVault) -> Result<Arc<VaultCalendar>, CaldavError> {
        let store = self.store.clone();
        blocking(move || ensure_device_identity(store)).await??;
        Ok(open.vault.calendar(self.store.clone())?)
    }
}

/// `hasCaldavLocalAuth` without the auth-failure marker: this device holds the password.
fn has_password(credentials: &ProviderCredentials, account: &str) -> bool {
    match credentials.get(CALDAV, account, SecretKind::Password) {
        Ok(password) => password.is_some(),
        Err(error) => {
            tracing::warn!(scope = SCOPE, "could not read a CalDAV password: {error}");
            false
        }
    }
}

/// `ownsDatabase()`: the vault the connect started on is still the open one.
fn still_open(session: &Session, open: &OpenVault) -> bool {
    session
        .current()
        .is_some_and(|current| Arc::ptr_eq(&current.vault, &open.vault))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, CaldavError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| CaldavError::Task(error.to_string()))
}
