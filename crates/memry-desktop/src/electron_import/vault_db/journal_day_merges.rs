//! Electron's owed journal day merges (`journalDayMerge:<id>`, `sync/journal-day-merge.ts`),
//! carried as the core's owed merge of the same foreign id, and the refusal of a vault whose
//! merge still needs this device's state of the foreign day.
//!
//! When a foreign row `F` gives its day up to `j<D>`, Electron removes `F`'s row and keeps what
//! this device holds of it in the owed row (`ensureJournalDay`, `journal-day-merge.ts:658-678`):
//! the day file's text, tags and attachment references; `F`'s local Yjs doc stays until the
//! settle purges it. The core keeps a displaced holder as its `sync_items` row instead
//! (`journal_day_merge::plan_inbound`), and a tombstone of `F` before the drain holds the doc only
//! through that row (`owed.rs` `hold_for_merge`). No row the import can stage keeps `F` out of
//! the core's push (VERIFY-5166B/C/D), so such a vault is refused until Electron drains it.

use std::collections::HashSet;

use memry_core::sync::journal_day_merge::OwedMerge;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;

use super::sync_state::{Carried, SyncStatePlan, plan};
use super::{FoldedDoc, ImportError};

/// Electron's `EMPTY_DOC_UPDATE_BYTES` (`crdt-provider.ts:89`): a doc whose encoded state is
/// longer holds state (`hasDocState`).
const EMPTY_DOC_UPDATE_BYTES: usize = 4;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwedJournalDayMerge {
    foreign_id: String,
    date: String,
    #[serde(default)]
    clock: Value,
    #[serde(default)]
    deleted: Value,
    #[serde(default)]
    record_markdown: Value,
    #[serde(default)]
    fallback_markdown: Value,
    #[serde(default)]
    tags: Value,
    #[serde(default)]
    unpushed_tags: Value,
    #[serde(default)]
    record_tags: Value,
    #[serde(default)]
    attachment_references: Value,
}

/// `listOwedJournalDayMerges`: one owed merge per row; a value that does not parse is dropped.
/// A clock the core cannot read is no clock (`parse_owed`), so no tombstone is owed. Electron's
/// holder `tags` are the core's holder tags; absent `unpushedTags` count every holder tag, as on
/// Electron. A merge whose fold needs this device's holder state is also listed in
/// [`SyncStatePlan::local_folds`].
pub(super) fn journal_day_merge(plan: &mut SyncStatePlan, value: &str) -> Carried {
    let Ok(owed) = serde_json::from_str::<OwedJournalDayMerge>(value) else {
        return Carried::Dropped("unreadableJournalDayMerges");
    };
    let text = |value: Value| value.as_str().map(str::to_owned);
    let tags = |value: Value| serde_json::from_value::<Vec<String>>(value).ok();
    let holder_tags = tags(owed.tags);
    let unpushed_tags = tags(owed.unpushed_tags);
    let deleted = owed.deleted == Value::Bool(true);
    // `mergeOne` (`journal-day-merge.ts:507-610`) folds the holder's text when it is not blank,
    // even for a deleted id, adds the holder's tags (`addedTags`, `:495-500`: a deleted id's
    // unpushed ones) and carries its attachment references (`carryAttachments`).
    let needs_local = text(owed.fallback_markdown).is_some_and(|m| !m.trim().is_empty())
        || if deleted {
            unpushed_tags.as_ref().or(holder_tags.as_ref())
        } else {
            holder_tags.as_ref()
        }
        .is_some_and(|tags| !tags.is_empty())
        || tags(owed.attachment_references).is_some_and(|refs| !refs.is_empty());
    let merge = OwedMerge {
        clock: serde_json::from_value(owed.clock).unwrap_or_default(),
        deleted,
        record_markdown: text(owed.record_markdown),
        record_tags: tags(owed.record_tags).unwrap_or_default(),
        unpushed_holder_tags: unpushed_tags
            .or_else(|| holder_tags.clone())
            .unwrap_or_default(),
        holder_tags: holder_tags.unwrap_or_default(),
        foreign_id: owed.foreign_id,
        date: owed.date,
    };
    // The core keys a merge by its foreign id, so a second row of the same id replaces it.
    plan.local_folds.retain(|id| *id != merge.foreign_id);
    if needs_local {
        plan.local_folds.push(merge.foreign_id.clone());
    }
    let merges = &mut plan.state.journal_merges;
    merges.retain(|held| held.foreign_id != merge.foreign_id);
    merges.push(merge);
    Carried::Written
}

/// [`ImportError::UndrainedJournalDay`] when an owed merge still needs this device's state of
/// its foreign day: the holder text, tags or attachment references its owed row keeps
/// ([`journal_day_merge`]), or the foreign doc's local Yjs state, which Electron's drain folds
/// even when another device deleted the id (`absorbBody`, `journal-day-merge.ts:554`).
/// An owed merge that needs none of them is carried as the core's. Runs before any write.
pub(super) fn refuse_local_folds(
    source: &Connection,
    docs: &[FoldedDoc],
) -> Result<(), ImportError> {
    let plan = plan(source)?;
    let local: HashSet<&str> = plan.local_folds.iter().map(String::as_str).collect();
    let with_state: HashSet<&str> = docs
        .iter()
        .filter(|doc| doc.state.len() > EMPTY_DOC_UPDATE_BYTES)
        .map(|doc| doc.doc_id.as_str())
        .collect();
    let foreign_ids: Vec<String> = plan
        .state
        .journal_merges
        .iter()
        .map(|merge| merge.foreign_id.as_str())
        .filter(|id| local.contains(id) || with_state.contains(id))
        .map(str::to_owned)
        .collect();
    if foreign_ids.is_empty() {
        return Ok(());
    }
    Err(ImportError::UndrainedJournalDay { foreign_ids })
}
