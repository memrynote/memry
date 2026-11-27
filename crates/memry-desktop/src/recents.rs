//! The "recently opened" trail as the renderer sees it (`recents-api.ts`, Electron
//! `ipc/recents-handlers.ts`). Device-local, never synced. The rules are the core's
//! ([`memry_core::domain::recently_opened`]): one row per item, at most 50, an item that is gone
//! left out of the list.

use memry_core::api::errors::StorageError;
use memry_core::domain::recently_opened::{LIMIT, Opened};
use memry_core::storage::repositories::instants::to_iso8601;
use serde::{Deserialize, Serialize};

use crate::session::OpenVault;

/// `RecentlyOpenedItemType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum RecentItemType {
    Note,
    Canvas,
}

impl RecentItemType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Canvas => "canvas",
        }
    }
}

/// `RecordRecentlyOpenedSchema`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordRecentInput {
    pub item_id: String,
    pub item_type: RecentItemType,
}

/// `RecentlyOpenedItem`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentlyOpenedView {
    pub item_id: String,
    pub item_type: RecentItemType,
    pub opened_at: String,
    pub title: String,
    pub path: String,
    /// A bare emoji, or an `icon:` or `custom:` reference.
    pub emoji: Option<String>,
    /// The note's file type (`markdown`, `pdf`, ...), or `canvas`.
    pub file_type: String,
}

impl RecentlyOpenedView {
    /// `None` for a row of a type this build does not list.
    fn new(item: Opened) -> Option<Self> {
        let item_type = match item.item_type.as_str() {
            "note" => RecentItemType::Note,
            "canvas" => RecentItemType::Canvas,
            _ => return None,
        };
        Some(Self {
            item_id: item.item_id,
            item_type,
            opened_at: to_iso8601(item.opened_at)?,
            title: item.title,
            path: item.path,
            emoji: item.emoji,
            file_type: item.file_type,
        })
    }
}

/// `recents:record`: whether the open was written. The trail is a convenience, never a
/// blocker: a failed write answers `false` and is logged, as Electron does. An empty id is still
/// refused, as `RecordRecentlyOpenedSchema` refuses it.
pub fn record(open: &OpenVault, input: RecordRecentInput) -> Result<bool, StorageError> {
    match open
        .vault
        .recently_opened()
        .record(input.item_type.as_str().to_owned(), input.item_id)
    {
        Ok(()) => Ok(true),
        Err(error @ StorageError::Invalid { .. }) => Err(error),
        Err(error) => {
            tracing::error!(scope = "Recents", "recents record failed: {error}");
            Ok(false)
        }
    }
}

/// `recents:list`: the newest first, 50 when `limit` is absent. A failed read answers no items
/// and is logged, as Electron does. A limit outside 1 to 50 is refused, as
/// `ListRecentlyOpenedSchema` refuses it.
pub fn list(open: &OpenVault, limit: Option<u32>) -> Result<Vec<RecentlyOpenedView>, StorageError> {
    let limit = limit.unwrap_or(LIMIT);
    if !(1..=LIMIT).contains(&limit) {
        return Err(StorageError::Invalid {
            what: format!("the recently opened list holds 1 to {LIMIT} items, not {limit}"),
        });
    }
    let items = open
        .vault
        .recently_opened()
        .list(limit)
        .inspect_err(|error| tracing::error!(scope = "Recents", "recents list failed: {error}"))
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .filter_map(RecentlyOpenedView::new)
        .collect())
}
