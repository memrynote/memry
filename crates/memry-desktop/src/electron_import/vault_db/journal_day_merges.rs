//! Electron's owed journal day merges (`journalDayMerge:<id>`, `sync/journal-day-merge.ts`):
//! the core's owed merge of the same foreign id, plus, for a foreign local row that gave its
//! day up to `j<D>` (a displaced holder), what the core keeps of such a holder.
//!
//! The core keeps a displaced holder `F` as its `sync_items` row without a projection
//! (`journal_day_merge::plan_inbound` removes only the projection) and its local Yjs doc. A
//! tombstone of `F` that arrives before the drain then holds both (`hold_for_merge`) and weighs
//! the holder's tags against the row's clock; without the row it purges the doc, the only copy
//! of this device's day text. Electron keeps that text in the owed row instead
//! (`fallbackMarkdown`) and folds it even when `F` was deleted elsewhere
//! (`journal-day-merge.ts:170-188`, `:519-536`).

use std::collections::HashSet;
use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::crdt::errors::CrdtError;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{DocumentRegistry, markdown_seed};
use memry_core::storage::import::{ImportDocument, ImportRecord, ImportWriter};
use memry_core::sync::clock::VectorClock;
use memry_core::sync::journal_day_merge::OwedMerge;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};

use super::sync_state::{Carried, SyncStatePlan, plan};
use super::{FoldedDoc, ImportError};

const JOURNAL: &str = "journal";

/// A foreign local row that gave its day up, as its owed merge keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplacedHolder {
    pub foreign_id: String,
    pub date: String,
    /// The day file's body (`fallbackMarkdown`), when it was not blank.
    pub text: Option<String>,
    /// The day file's tags (`tags`), when the row had a readable file.
    pub tags: Option<Vec<String>>,
    /// The row's clock (`holderClock`); `None` when it was edited since its sync.
    pub clock: Option<VectorClock>,
}

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
    holder_clock: Value,
    #[serde(default)]
    unpushed_tags: Value,
    #[serde(default)]
    record_tags: Value,
}

/// `listOwedJournalDayMerges`: one owed merge per row; a value that does not parse is dropped.
/// A clock the core cannot read is no clock (`parse_owed`), so no tombstone is owed. Electron's
/// holder `tags` are the core's holder tags; absent `unpushedTags` count every holder tag, as on
/// Electron. A row with a holder's `fallbackMarkdown`, `tags` or `holderClock` is also a
/// [`DisplacedHolder`].
pub(super) fn journal_day_merge(plan: &mut SyncStatePlan, value: &str) -> Carried {
    let Ok(owed) = serde_json::from_str::<OwedJournalDayMerge>(value) else {
        return Carried::Dropped("unreadableJournalDayMerges");
    };
    let text = |value: Value| value.as_str().map(str::to_owned);
    let tags = |value: Value| serde_json::from_value::<Vec<String>>(value).ok();
    let holder_tags = tags(owed.tags);
    let merge = OwedMerge {
        clock: serde_json::from_value(owed.clock).unwrap_or_default(),
        deleted: owed.deleted == Value::Bool(true),
        record_markdown: text(owed.record_markdown),
        record_tags: tags(owed.record_tags).unwrap_or_default(),
        unpushed_holder_tags: tags(owed.unpushed_tags)
            .or_else(|| holder_tags.clone())
            .unwrap_or_default(),
        holder_tags: holder_tags.clone().unwrap_or_default(),
        foreign_id: owed.foreign_id,
        date: owed.date,
    };
    let holder = DisplacedHolder {
        foreign_id: merge.foreign_id.clone(),
        date: merge.date.clone(),
        // A blank snapshot keeps nothing (`fallbackMarkdown?.trim()`).
        text: text(owed.fallback_markdown).filter(|m| !m.trim().is_empty()),
        tags: holder_tags,
        clock: serde_json::from_value(owed.holder_clock)
            .ok()
            .filter(|clock: &VectorClock| !clock.is_empty()),
    };
    // The core keys a merge by its foreign id, so a second row of the same id replaces it.
    plan.holders
        .retain(|held| held.foreign_id != merge.foreign_id);
    if holder.text.is_some() || holder.tags.is_some() || holder.clock.is_some() {
        plan.holders.push(holder);
    }
    let merges = &mut plan.state.journal_merges;
    merges.retain(|held| held.foreign_id != merge.foreign_id);
    merges.push(merge);
    Carried::Written
}

/// This device's text of each displaced holder, as that foreign doc's local Yjs state, stored
/// at `now_ms` as this device's newest own text. Electron's drain builds the foreign doc from it
/// when the doc holds no state (`absorbForeignDoc`), deleted id or not; the core's drain folds a
/// foreign doc's local state into `j<D>` the same way. A foreign id whose doc the store already
/// holds keeps that doc, as Electron does. The client id is fixed per foreign id and device, as
/// the core's own build (`journal_day_merge::built_state`).
pub fn fallback_documents(
    source: &Connection,
    folded: &[FoldedDoc],
    device_id: Option<&str>,
    now_ms: i64,
) -> Result<Vec<ImportDocument>, ImportError> {
    let device = device_id.unwrap_or("memry-electron-import");
    let failed = |e: CrdtError| StorageError::Failed {
        what: format!("journal day text: {e}"),
    };
    let mut docs = Vec::new();
    for holder in plan(source)?.holders {
        let (foreign_id, Some(markdown)) = (holder.foreign_id, holder.text) else {
            continue;
        };
        if folded.iter().any(|doc| doc.doc_id == foreign_id) {
            continue;
        }
        let sink: UpdateSink = Arc::new(|_, _| {});
        let document = DocumentRegistry::new(&format!("{foreign_id}\0{device}"), sink)
            .get_or_open(&foreign_id)
            .map_err(failed)?;
        markdown_seed::seed_document(&document, &markdown).map_err(failed)?;
        docs.push(ImportDocument {
            state: document.encode_state().map_err(failed)?,
            doc_id: foreign_id,
            watermark: None,
            created_at: now_ms,
        });
    }
    Ok(docs)
}

/// Stages each displaced holder's `sync_items` row, unprojected and with no outbox row:
/// payload `{date, content, tags, clock}` from its owed row. `clock` is `holderClock`, absent
/// when Electron recorded none (the row was edited since its sync): Electron then counts every
/// holder tag unpushed (`unpushedHolderTags`), and so does the core with no row clock. A foreign
/// id the import already staged as a live record keeps that one. Runs after every table.
pub fn put_holders(
    source: &Connection,
    writer: &mut ImportWriter,
    now_ms: i64,
) -> Result<(), ImportError> {
    let mut records = Vec::new();
    for holder in plan(source)?.holders {
        if writer
            .record_payload(JOURNAL, &holder.foreign_id)?
            .is_some()
        {
            continue;
        }
        let mut payload = json!({ "date": holder.date });
        if let Some(text) = holder.text {
            payload["content"] = json!(text);
        }
        if let Some(tags) = holder.tags {
            payload["tags"] = json!(tags);
        }
        if let Some(clock) = holder.clock {
            payload["clock"] = json!(clock);
        }
        records.push(ImportRecord {
            item_type: JOURNAL,
            item_id: holder.foreign_id,
            payload: payload.to_string(),
            synced_at: None,
        });
    }
    writer.put_held_records(&records, now_ms)?;
    Ok(())
}

/// The ids [`put_holders`] may stage: stage check 2 reads no source row for them.
pub fn holder_ids(source: &Connection) -> Result<HashSet<String>, ImportError> {
    Ok(plan(source)?
        .holders
        .into_iter()
        .map(|holder| holder.foreign_id)
        .collect())
}
