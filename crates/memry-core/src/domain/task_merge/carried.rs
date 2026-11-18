//! The keys a field-merged type carries beside its field list, and what each of
//! §6.3.1's two branches does with them (chapter 06 §6.7.1, §6.7.2).
//!
//! They have no field clock, so §6.3's per-field rule cannot decide them.
//! Electron decides them inline in each type's handler, and the two handlers
//! agree on the wholesale branch and differ on the concurrent one:
//!
//! - **Wholesale.** Both write a carried key only when the remote has it
//!   (`task-handler.ts:319-321`, `project-handler.ts:259-265`), so a remote
//!   that omits one keeps the local value. Storing the remote verbatim would
//!   drop it, and the next local edit would push the shorter row.
//! - **Concurrent.** A task unions its three lists ([`Carry::Union`],
//!   `task-handler.ts:221-242`). A project replaces its `statuses` and `links`
//!   with the remote's ([`Carry::Remote`], `project-handler.ts:259-265` runs
//!   after the merge at `:204-238` exactly as after the apply branch).

use std::collections::HashSet;

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::notes::names::js_trim;
use crate::domain::tags;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::InboundRecord;
use crate::storage::repositories::{Change, StoredPayload};

use super::live_payload;

/// How the concurrent branch joins a carried key, and which remote values
/// leave it to the local row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Carry {
    /// §6.7.1, a task's lists: the local list, then the remote's new entries.
    /// A remote `null` leaves the local list (`if (data.tags)`).
    Union,
    /// §6.7.2, a project's nested arrays: the remote's array replaces the
    /// local one. A remote `null` is §13.4's clear (the projector's rule,
    /// `projectors/projects.rs` `nested`), so only an absent key keeps the
    /// local array.
    Remote,
}

impl Carry {
    /// Whether a remote whose `key` reads `value` leaves the local value.
    fn keeps_local(self, value: Option<&Value>) -> bool {
        match self {
            Carry::Union => value.is_none_or(Value::is_null),
            Carry::Remote => value.is_none(),
        }
    }
}

/// The concurrent branch's change to each of `keys`. A key with no change
/// keeps the local value.
pub(super) fn concurrent_changes<'k>(
    record: &InboundRecord,
    keys: &[&'k str],
    carry: Carry,
    local: &Object,
    remote: &Object,
) -> Result<Vec<(&'k str, Change)>, StorageError> {
    let mut changes = Vec::new();
    for key in keys {
        if carry.keeps_local(remote.get(*key)) {
            continue;
        }
        let value = match carry {
            Carry::Union => union_list(record, key, local, remote)?.map(Change::set),
            Carry::Remote => Some(Change::Set(remote_array(record, key, remote)?)),
        };
        if let Some(change) = value {
            changes.push((*key, change));
        }
    }
    Ok(changes)
}

/// §6.7.2: the remote's `statuses` or `links`, an array or `null`. Any other
/// shape is an `Err`, so the record is flagged corrupt as the wholesale path's
/// projector flags it (`Kind::Array`); `ProjectSyncPayloadSchema` refuses it
/// on Electron.
fn remote_array(record: &InboundRecord, key: &str, remote: &Object) -> Result<Value, StorageError> {
    match remote.get(key) {
        Some(value @ (Value::Null | Value::Array(_))) => Ok(value.clone()),
        _ => Err(StorageError::Failed {
            what: format!(
                "{} {}: remote `{key}` is not an array (chapter 06 §6.7.2)",
                record.item_type, record.item_id
            ),
        }),
    }
}

/// §6.7.1: Electron's union of one junction list on a concurrent task merge
/// (`apps/desktop/src/main/sync/item-handlers/task-handler.ts:221-242`): the
/// local entries in their order, then the remote's new ones. `tags` then go
/// through `writeTags` (`:100-115`): trimmed as JS trims, empty ones dropped,
/// deduped by [`tags::fold`] keeping the first spelling. Link ids dedupe
/// exactly. There is no removal set, so an entry one side removed comes back
/// while the other side still holds it.
///
/// `None` leaves the local list as it is: the local one is not an array of
/// strings. A remote list of any other shape is an `Err`, so the record is
/// flagged corrupt as the wholesale path flags it; `TaskSyncPayloadSchema`
/// refuses it on Electron.
fn union_list(
    record: &InboundRecord,
    list: &str,
    local: &Object,
    remote: &Object,
) -> Result<Option<Vec<String>>, StorageError> {
    let remote = remote
        .get(list)
        .and_then(strings)
        .ok_or_else(|| StorageError::Failed {
            what: format!(
                "{} {}: remote `{list}` is not an array of strings (chapter 06 §6.7.1)",
                record.item_type, record.item_id
            ),
        })?;
    let local = match local.get(list) {
        None | Some(Value::Null) => Vec::new(),
        Some(value) => match strings(value) {
            Some(local) => local,
            None => return Ok(None),
        },
    };
    let joined = local.into_iter().chain(remote);
    if list == "tags" {
        return Ok(Some(tags::dedupe(
            joined
                .map(|tag| js_trim(&tag).to_owned())
                .filter(|tag| !tag.is_empty()),
        )));
    }
    let mut seen = HashSet::new();
    Ok(Some(joined.filter(|id| seen.insert(id.clone())).collect()))
}

/// The wholesale rule of §6.7.1 and §6.7.2: the remote with each of `keys` it
/// leaves to the local row ([`Carry::keeps_local`]) copied from the live local
/// row. Electron builds from before #1879 push no `linkedCanvasIds` (before
/// 2026-03-19 no `tags` or `linkedNoteIds` either), and any build may push a
/// project without `statuses` or `links`.
///
/// `None` stores the remote as received: a tombstone, a remote the wholesale
/// store flags, no key left to the local row, or no live, uncorrupted local
/// row.
pub(super) fn keep_local(
    conn: &Connection,
    record: &InboundRecord,
    keys: &[&str],
    carry: Carry,
) -> Result<Option<InboundRecord>, StorageError> {
    if keys.is_empty() || record.deleted_at.is_some() {
        return Ok(None);
    }
    let Ok(remote) = StoredPayload::parse(&record.payload_json) else {
        return Ok(None);
    };
    let missing: Vec<&str> = keys
        .iter()
        .copied()
        .filter(|key| carry.keeps_local(remote.object().get(*key)))
        .collect();
    if missing.is_empty() {
        return Ok(None);
    }
    let Some((local, true)) = live_payload(conn, record)? else {
        return Ok(None);
    };
    let kept: Vec<(&str, Change)> = missing
        .into_iter()
        .filter_map(|key| {
            let value = local.object().get(key).filter(|value| !value.is_null())?;
            Some((key, Change::Set(value.clone())))
        })
        .collect();
    if kept.is_empty() {
        return Ok(None);
    }
    Ok(Some(InboundRecord {
        payload_json: remote.merge(&kept),
        ..record.clone()
    }))
}

fn strings(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|entry| entry.as_str().map(str::to_owned))
        .collect()
}
