//! The writer check before a second writable calendar provider connects
//! (`calendar/provider/writer-compat.ts:62-120`, `writer-compat-runtime.ts`, #1396). Sync
//! payloads are end-to-end encrypted and `provider` sits inside them, so the server cannot keep a
//! CalDAV binding away from an older build, which would double-push its items to Google. Only the
//! connect flow can prevent that: it lists the account's devices that are too old, and the user
//! updates them or accepts the risk. The floor and the predicates are the core's
//! (`domain::calendar_items::writer_compat`).

use std::future::Future;
use std::sync::Arc;

use memry_core::api::auth::AuthState;
use memry_core::api::errors::AuthError;
use memry_core::domain::calendar_items::writer_compat::{
    CALENDAR_MULTI_WRITER_MIN_APP_VERSION, is_outdated_writer, provider_needs_writer_compat_check,
};
use memry_core::protocol::account_admin::AccountDevice;
use serde::Serialize;

use crate::account::AccountService;

/// Whether this install holds a Memry session, as the check needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignIn {
    SignedOut,
    SignedIn,
    /// The session exists but cannot be read (a locked keychain): other devices may exist.
    Unreadable,
}

/// The account's devices, as the check reads them.
pub trait AccountDevices: Send + Sync {
    fn sign_in(&self) -> impl Future<Output = SignIn> + Send;
    /// `GET /devices`, each row marked `is_current` for this device.
    fn devices(&self) -> impl Future<Output = Result<Vec<AccountDevice>, AuthError>> + Send;
}

/// `isMemryUserSignedIn` reads the refresh token; here a registered session and the access
/// token's device id. A session whose token cannot be read is not a signed-out one.
fn sign_in_blocking(account: &AccountService) -> SignIn {
    // `info` restores the session from the keychain first.
    let _ = account.info();
    if !matches!(
        account.session().state(),
        AuthState::Registered | AuthState::Refreshing | AuthState::SessionExpired
    ) {
        return SignIn::SignedOut;
    }
    match account.session().registered_device_id() {
        Ok(_) => SignIn::SignedIn,
        Err(error) => {
            tracing::warn!(
                scope = "calendar_writer_compat",
                "could not read the Memry session for the writer check: {error}"
            );
            SignIn::Unreadable
        }
    }
}

impl AccountDevices for Arc<AccountService> {
    /// The keychain reads run on a blocking thread.
    async fn sign_in(&self) -> SignIn {
        let account = self.clone();
        tokio::task::spawn_blocking(move || sign_in_blocking(&account))
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(
                    scope = "calendar_writer_compat",
                    "the writer check's session read failed: {error}"
                );
                SignIn::Unreadable
            })
    }

    async fn devices(&self) -> Result<Vec<AccountDevice>, AuthError> {
        self.session().devices().await
    }
}

/// `CalendarWriterCompatDevice`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WriterCompatDevice {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub app_version: Option<String>,
}

/// `CalendarWriterCompatResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WriterCompat {
    /// `false` when connecting this provider adds no second writer.
    pub required: bool,
    /// `false` when the device list could not be read; the user must acknowledge blind.
    pub verified: bool,
    pub min_version: String,
    pub outdated_devices: Vec<WriterCompatDevice>,
}

impl WriterCompat {
    fn of(required: bool, verified: bool, outdated_devices: Vec<WriterCompatDevice>) -> Self {
        Self {
            required,
            verified,
            min_version: CALENDAR_MULTI_WRITER_MIN_APP_VERSION.to_owned(),
            outdated_devices,
        }
    }

    /// `writerCompatAllowsConnect`: nothing at risk, or the user acknowledged the risk.
    pub fn allows_connect(&self, acknowledged: bool) -> bool {
        !self.required || (self.verified && self.outdated_devices.is_empty()) || acknowledged
    }
}

/// `checkProviderWriterCompat`.
pub async fn check(provider: &str, account: &impl AccountDevices) -> WriterCompat {
    if !provider_needs_writer_compat_check(provider) {
        return WriterCompat::of(false, true, Vec::new());
    }
    match account.sign_in().await {
        // Without a Memry account nothing syncs, so no other device receives the bindings.
        SignIn::SignedOut => return WriterCompat::of(true, true, Vec::new()),
        SignIn::Unreadable => return WriterCompat::of(true, false, Vec::new()),
        SignIn::SignedIn => {}
    }
    let devices = match account.devices().await {
        Ok(devices) => devices,
        Err(error) => {
            tracing::warn!(
                scope = "calendar_writer_compat",
                "could not read the device list for the writer check: {error}"
            );
            return WriterCompat::of(true, false, Vec::new());
        }
    };
    let outdated = devices
        .into_iter()
        .filter(|device| !device.is_current)
        .filter(|device| is_outdated_writer(&device.platform, device.app_version.as_deref()))
        .map(|device| WriterCompatDevice {
            id: device.id,
            name: device.name,
            platform: device.platform,
            app_version: device.app_version,
        })
        .collect();
    WriterCompat::of(true, true, outdated)
}
