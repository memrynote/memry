//! `Inbox`: every inbox read and write for one opened vault (spec 006).
//!
//! One object, like [`crate::api::tasks::Tasks`], because every write needs
//! the vault's database and this device's clock identity. Reads are here;
//! writes are in `inbox_write.rs` (600-line ceiling).
//!
//! **Every method blocks** (spec-defect 90): local SQLite only. A write is in
//! the outbox when it returns and reaches other devices on the next
//! [`crate::api::sync::VaultSync::sync_now`].

use std::sync::Arc;

use crate::api::errors::{AuthError, StorageError};
use crate::api::inbox_records::{
    InboxItemRecord, InboxPanelRecord, InboxPatternRecord, InboxStatsRecord, InboxTypeCount,
};
use crate::crypto::keys;
use crate::domain::inbox::{self, panel, stats};
use crate::seams::secure_store::{SecureStore, SecureStoreKey};
use crate::storage::Db;

/// The inbox surface over one opened vault.
#[derive(uniffi::Object)]
pub struct Inbox {
    pub(crate) db: Db,
    pub(crate) device_id: String,
}

impl Inbox {
    /// Built by [`crate::api::vault::Vault::inbox`]; the device id is derived
    /// from the keychain's signing key exactly as `Tasks` does, so every
    /// write surface ticks the same clock entry.
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let secret =
            store
                .get(SecureStoreKey::DeviceSigningKey)?
                .ok_or(AuthError::MalformedToken {
                    what: "this device has no signing key, so it has no identity to write under"
                        .to_string(),
                })?;
        let public = secret
            .get(32..64)
            .ok_or(AuthError::MalformedToken {
                what: "device signing key is not 64 bytes".to_string(),
            })?
            .to_vec();
        Ok(Self {
            db,
            device_id: keys::local_device_id_hex(&public)?,
        })
    }
}

fn records(items: Vec<inbox::InboxItem>) -> Vec<InboxItemRecord> {
    items.into_iter().map(InboxItemRecord::from).collect()
}

#[uniffi::export]
impl Inbox {
    /// The inbox list: unfiled, unarchived and (unless `include_snoozed`) not
    /// snoozed, newest first.
    pub fn list(&self, include_snoozed: bool) -> Result<Vec<InboxItemRecord>, StorageError> {
        self.db
            .call_blocking(move |conn| Ok(records(inbox::list_active(conn, include_snoozed)?)))
    }

    /// One capture, or `nil` when none by that id is live here.
    pub fn get(&self, id: String) -> Result<Option<InboxItemRecord>, StorageError> {
        self.db
            .call_blocking(move |conn| Ok(inbox::get(conn, &id)?.map(InboxItemRecord::from)))
    }

    /// Active captures per type, all nine types, zeros included.
    pub fn type_counts(&self) -> Result<Vec<InboxTypeCount>, StorageError> {
        self.db.call_blocking(|conn| {
            Ok(inbox::type_counts(conn)?
                .into_iter()
                .map(|(item_type, count)| InboxTypeCount { item_type, count })
                .collect())
        })
    }

    /// Archived captures, most recently archived first; `search` matches
    /// title or content.
    pub fn archived(
        &self,
        search: Option<String>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<InboxItemRecord>, StorageError> {
        self.db.call_blocking(move |conn| {
            Ok(records(inbox::archived(
                conn,
                search.as_deref(),
                limit,
                offset,
            )?))
        })
    }

    /// Snoozed, unfiled captures, soonest first.
    pub fn snoozed(&self) -> Result<Vec<InboxItemRecord>, StorageError> {
        self.db
            .call_blocking(|conn| Ok(records(inbox::snoozed(conn)?)))
    }

    /// The Snoozed & reminders view at `now_ms`.
    pub fn panel(&self, now_ms: i64) -> Result<InboxPanelRecord, StorageError> {
        self.db
            .call_blocking(move |conn| Ok(panel::panel(conn, now_ms)?.into()))
    }

    /// Every statistic the chrome, Insights and Inbox Zero read, at `now_ms`
    /// with `stale_days` (desktop's default is 7).
    pub fn stats(&self, now_ms: i64, stale_days: i64) -> Result<InboxStatsRecord, StorageError> {
        self.db.call_blocking(move |conn| {
            let computed = stats::stats(conn, now_ms, stale_days)?;
            Ok(InboxStatsRecord::new(
                computed,
                inbox::fetching_count(conn)?,
                inbox::reviewable_count(conn)?,
            ))
        })
    }

    /// The capture heatmap and type shares over the last 84 days.
    pub fn patterns(&self, now_ms: i64) -> Result<InboxPatternRecord, StorageError> {
        self.db
            .call_blocking(move |conn| Ok(stats::patterns(conn, now_ms)?.into()))
    }

    /// Filed captures, most recently filed first.
    pub fn filing_history(&self, limit: i64) -> Result<Vec<InboxItemRecord>, StorageError> {
        self.db
            .call_blocking(move |conn| Ok(records(inbox::filing_history(conn, limit)?)))
    }

    /// Folders captures were recently filed to, most recent first.
    pub fn recent_folders(&self, limit: u32) -> Result<Vec<String>, StorageError> {
        self.db
            .call_blocking(move |conn| inbox::recent_folders(conn, limit as usize))
    }

    /// Every device-local tag with its count, most used first.
    pub fn tags(&self) -> Result<Vec<InboxTypeCount>, StorageError> {
        self.db.call_blocking(|conn| {
            Ok(inbox::all_tags(conn)?
                .into_iter()
                .map(|(item_type, count)| InboxTypeCount { item_type, count })
                .collect())
        })
    }

    /// The live capture already holding `url`, if any.
    pub fn duplicate_by_url(&self, url: String) -> Result<Option<InboxItemRecord>, StorageError> {
        self.db.call_blocking(move |conn| {
            Ok(inbox::duplicate_by_url(conn, &url)?.map(InboxItemRecord::from))
        })
    }
}
