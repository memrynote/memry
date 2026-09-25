//! Account management routes a Settings screen calls (spec 006 ST13):
//! devices, storage, billing (read-only) and vault deletion.
//!
//! | Route                     | Server                          |
//! | ------------------------- | ------------------------------- |
//! | `GET /devices`            | `routes/devices.ts:30`          |
//! | `PATCH /devices/:id`      | `routes/devices.ts:81`          |
//! | `DELETE /devices/:id`     | `routes/devices.ts:49`          |
//! | `GET /sync/storage`       | `routes/sync.ts:287`            |
//! | `GET /auth/billing`       | `routes/auth.ts:857`            |
//! | `DELETE /sync/vaults/:id` | `routes/sync.ts:128`            |
//!
//! Every reader is strict about the fields a screen needs and lenient about
//! the rest: a missing id is `MalformedResponse`, a missing `lastSyncAt` is
//! `None`.

use serde_json::Value as Json;

use crate::api::errors::ApiError;
use crate::protocol::http::{ApiRequest, Auth, HttpClient};

/// `deviceName`'s server bound (`RenameDeviceSchema`, 1..=100).
pub const DEVICE_NAME_MAX_CHARS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AccountDevice {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub app_version: Option<String>,
    /// Epoch seconds, as the server stores it.
    pub last_sync_at: Option<i64>,
    pub created_at: Option<i64>,
    /// The device this session is signed in as.
    pub is_current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StorageUsage {
    pub used: i64,
    pub limit: i64,
    pub notes: i64,
    pub attachments: i64,
    pub crdt: i64,
    pub other: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BillingStatus {
    /// The account's email, as `GET /auth/billing` reports it.
    pub email: Option<String>,
    pub plan: String,
    pub status: String,
    pub cadence: Option<String>,
    pub storage_limit: i64,
    pub storage_used: i64,
    pub max_file_size: i64,
    pub max_vaults: i64,
    pub version_history_days: i64,
    pub expires_at: Option<i64>,
}

fn malformed(path: &str, what: &str) -> ApiError {
    ApiError::MalformedResponse {
        path: path.to_string(),
        what: what.to_string(),
    }
}

fn int(row: &Json, key: &str) -> Option<i64> {
    row.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

fn text(row: &Json, key: &str) -> Option<String> {
    row.get(key).and_then(Json::as_str).map(str::to_owned)
}

/// A path segment is an id the server issued: refuse anything that would
/// change the route.
fn segment(id: &str) -> Result<&str, ApiError> {
    if !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Ok(id)
    } else {
        Err(ApiError::InvalidClientIdentity {
            what: format!("`{id}` is not an id"),
        })
    }
}

pub(crate) fn read_devices(body: &Json, current: &str) -> Option<Vec<AccountDevice>> {
    let rows = body.get("devices")?.as_array()?;
    rows.iter()
        .map(|row| {
            let id = text(row, "id")?;
            Some(AccountDevice {
                is_current: id == current,
                name: text(row, "name").unwrap_or_default(),
                platform: text(row, "platform").unwrap_or_default(),
                app_version: text(row, "appVersion"),
                last_sync_at: int(row, "lastSyncAt"),
                created_at: int(row, "createdAt"),
                id,
            })
        })
        .collect()
}

pub(crate) fn read_storage(body: &Json) -> Option<StorageUsage> {
    let breakdown = body.get("breakdown")?;
    Some(StorageUsage {
        used: int(body, "used")?,
        limit: int(body, "limit")?,
        notes: int(breakdown, "notes").unwrap_or(0),
        attachments: int(breakdown, "attachments").unwrap_or(0),
        crdt: int(breakdown, "crdt").unwrap_or(0),
        other: int(breakdown, "other").unwrap_or(0),
    })
}

pub(crate) fn read_billing(body: &Json) -> Option<BillingStatus> {
    let limits = body.get("limits")?;
    Some(BillingStatus {
        email: text(body, "email"),
        plan: text(body, "plan")?,
        status: text(body, "status")?,
        cadence: text(body, "cadence"),
        storage_limit: int(limits, "storageLimit").unwrap_or(0),
        storage_used: body
            .get("usage")
            .and_then(|u| int(u, "storageUsed"))
            .unwrap_or(0),
        max_file_size: int(limits, "maxFileSize").unwrap_or(0),
        max_vaults: int(limits, "maxVaults").unwrap_or(0),
        version_history_days: int(limits, "versionHistoryDays").unwrap_or(0),
        expires_at: int(body, "expiresAt"),
    })
}

pub async fn devices(http: &HttpClient, current: &str) -> Result<Vec<AccountDevice>, ApiError> {
    let body: Json = http
        .send_json(ApiRequest::get("/devices").auth(Auth::Session))
        .await?;
    read_devices(&body, current)
        .ok_or_else(|| malformed("/devices", "expected { devices: [{id}] }"))
}

pub async fn rename_device(http: &HttpClient, id: &str, name: &str) -> Result<(), ApiError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(ApiError::InvalidClientIdentity {
            what: "a device name cannot be empty".into(),
        });
    }
    let name: String = trimmed.chars().take(DEVICE_NAME_MAX_CHARS).collect();
    let path = format!("/devices/{}", segment(id)?);
    let _: Json = http
        .send_json(
            ApiRequest::new("PATCH", &path)
                .auth(Auth::Session)
                .json(&serde_json::json!({ "name": name })),
        )
        .await?;
    Ok(())
}

pub async fn revoke_device(http: &HttpClient, id: &str) -> Result<(), ApiError> {
    let path = format!("/devices/{}", segment(id)?);
    let _: Json = http
        .send_json(ApiRequest::new("DELETE", &path).auth(Auth::Session))
        .await?;
    Ok(())
}

pub async fn storage(http: &HttpClient) -> Result<StorageUsage, ApiError> {
    let body: Json = http
        .send_json(ApiRequest::get("/sync/storage").auth(Auth::Session))
        .await?;
    read_storage(&body)
        .ok_or_else(|| malformed("/sync/storage", "expected { used, limit, breakdown }"))
}

pub async fn billing(http: &HttpClient) -> Result<BillingStatus, ApiError> {
    let body: Json = http
        .send_json(ApiRequest::get("/auth/billing").auth(Auth::Session))
        .await?;
    read_billing(&body)
        .ok_or_else(|| malformed("/auth/billing", "expected { plan, status, limits }"))
}

pub async fn delete_vault(http: &HttpClient, vault_id: &str) -> Result<(), ApiError> {
    let path = format!("/sync/vaults/{}", segment(vault_id)?);
    let _: Json = http
        .send_json(ApiRequest::new("DELETE", &path).auth(Auth::Session))
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn devices_mark_the_current_one_and_refuse_a_row_without_an_id() {
        let body = json!({"devices":[
            {"id":"a","name":"Mac","platform":"macos","appVersion":"1.4","lastSyncAt":10,"createdAt":1},
            {"id":"b","name":"Phone","platform":"ios","lastSyncAt":null}
        ]});
        let rows = read_devices(&body, "b").expect("rows");
        assert!(!rows[0].is_current && rows[1].is_current);
        assert_eq!(rows[0].last_sync_at, Some(10));
        assert_eq!(rows[1].last_sync_at, None);
        assert!(read_devices(&json!({"devices":[{"name":"x"}]}), "b").is_none());
        assert!(read_devices(&json!({}), "b").is_none());
    }

    #[test]
    fn storage_and_billing_read_the_server_shapes() {
        let storage = read_storage(&json!({"used":5,"limit":10,
            "breakdown":{"notes":1,"attachments":2,"crdt":1,"other":1}}))
        .expect("storage");
        assert_eq!((storage.used, storage.attachments), (5, 2));
        let billing = read_billing(&json!({"plan":"plus","cadence":null,"status":"active",
            "limits":{"storageLimit":10,"maxFileSize":3,"maxVaults":3,"versionHistoryDays":90},
            "usage":{"storageUsed":4},"expiresAt":null}))
        .expect("billing");
        assert_eq!(billing.plan, "plus");
        assert_eq!(billing.max_vaults, 3);
        assert_eq!(billing.cadence, None);
        assert!(read_billing(&json!({"plan":"plus"})).is_none());
    }

    #[test]
    fn an_id_that_would_change_the_route_is_refused() {
        assert!(segment("abc-123_X").is_ok());
        for bad in ["", "../x", "a/b", "a?b"] {
            assert!(segment(bad).is_err(), "{bad}");
        }
    }
}
