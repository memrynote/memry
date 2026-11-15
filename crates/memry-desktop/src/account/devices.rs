//! The account's devices: the list, a rename and a removal (`ipc/auth-device-handlers.ts:515-641`).
//! Tauri has no local device table, so the server's list is the only one; a list the server does
//! not answer reads as empty, as Electron's fallback to an empty cache does.

use memry_core::api::errors::{ApiError, AuthError};
use memry_core::protocol::account_admin::AccountDevice;

use super::{AccountError, AccountService};

/// `GET_DEVICES`' answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceList {
    pub devices: Vec<AccountDevice>,
    pub email: Option<String>,
    pub needs_recovery_confirmation: bool,
}

impl AccountService {
    /// `GET_DEVICES`. No device registered on this install (`sync.deviceId`) is an empty list.
    pub async fn devices(&self) -> DeviceList {
        let (email, device_id, confirmed) = self.sync_fields();
        let devices = if device_id.is_none() {
            Vec::new()
        } else {
            self.session.devices().await.unwrap_or_else(|error| {
                tracing::warn!(
                    scope = "Devices",
                    "the device list was not refreshed: {error}"
                );
                Vec::new()
            })
        };
        DeviceList {
            devices,
            email,
            needs_recovery_confirmation: confirmed == Some(false),
        }
    }

    /// `RENAME_DEVICE`.
    pub async fn rename_device(&self, device_id: String, name: String) -> Result<(), AccountError> {
        self.session.rename_device(device_id, name).await?;
        Ok(())
    }

    /// `REMOVE_DEVICE`: never this device; a device the server no longer has counts as removed.
    pub async fn remove_device(&self, device_id: String) -> Result<(), AccountError> {
        if self.session.registered_device_id().ok().as_deref() == Some(device_id.as_str()) {
            return Err(AccountError::CannotRemoveCurrentDevice);
        }
        match self.session.revoke_device(device_id).await {
            Ok(()) => {}
            Err(AuthError::Api {
                source: ApiError::Status { status: 404, .. },
            }) => tracing::warn!(scope = "Devices", "device already gone on the server (404)"),
            Err(error) => return Err(error.into()),
        }
        tracing::info!(scope = "Devices", "device removed");
        Ok(())
    }
}
