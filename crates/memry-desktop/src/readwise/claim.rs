//! The claim (`apps/desktop/src/main/readwise/claim.ts`, #1408 D8): `syncDeviceId` in the synced
//! `readwise` group names the one device that pulls from Readwise, and `syncDeviceName` is its
//! label for the other devices' panels. Both are plain leaves of the group, each under its own
//! field clock. Neither is ever removed: a claim is cleared with an explicit `null` (§13.4),
//! because an absent key means "this build does not know the value" and a merge keeps the old
//! one.
//!
//! The claim has no lease and no expiry, as in Electron. It outlives a run, a crash and a
//! restart, and moves only when the user connects on another device ("Sync here instead") or
//! the holder disconnects. An expiry would let a device that is offline for a while lose the
//! claim and pull beside its successor once back, rewriting the same notes.

use memry_core::api::errors::StorageError;
use memry_core::api::readwise::ReadwiseStore;
use memry_core::api::settings::Settings;
use serde_json::Value;

const DEVICE_ID: &str = "readwise.syncDeviceId";
const DEVICE_NAME: &str = "readwise.syncDeviceName";

/// `ReadwiseClaim`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Claim {
    pub device_id: Option<String>,
    pub device_name: Option<String>,
}

impl Claim {
    /// `readClaim` over the stored group: a leaf that is not a non-empty string reads as none.
    pub fn from_group(group: &Value) -> Self {
        let text = |name: &str| {
            group
                .get(name)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        Self {
            device_id: text("syncDeviceId"),
            device_name: text("syncDeviceName"),
        }
    }

    pub fn read(store: &ReadwiseStore) -> Result<Self, StorageError> {
        Ok(Self::from_group(&store.settings_group()?))
    }

    /// `claimLostToAnotherDevice`: another device holds the claim. `this_device` is the
    /// registered sync device id with sync on, `None` otherwise: with no peer to race, a stale
    /// claim stops nothing.
    pub fn held_elsewhere(&self, this_device: Option<&str>) -> bool {
        match (this_device, self.device_id.as_deref()) {
            (Some(this), Some(holder)) => this != holder,
            _ => false,
        }
    }
}

/// `writeClaim`: makes `device_id` the pulling device. The caller waits for the push.
pub fn write_claim(
    settings: &Settings,
    device_id: &str,
    device_name: Option<&str>,
) -> Result<(), StorageError> {
    write(settings, Some(device_id), device_name)
}

/// `clearClaim`: clears both leaves with `null`, and writes nothing when there is no claim.
pub fn clear_claim(store: &ReadwiseStore, settings: &Settings) -> Result<(), StorageError> {
    if Claim::read(store)? == Claim::default() {
        return Ok(());
    }
    write(settings, None, None)
}

fn write(
    settings: &Settings,
    device_id: Option<&str>,
    device_name: Option<&str>,
) -> Result<(), StorageError> {
    let json = |value: Option<&str>| value.map_or(Value::Null, Value::from).to_string();
    settings.set(DEVICE_ID.to_owned(), json(device_id))?;
    settings.set(DEVICE_NAME.to_owned(), json(device_name))
}
