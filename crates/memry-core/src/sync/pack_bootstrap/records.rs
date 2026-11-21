//! Records from `record` packs (chapter 08 §8.4.2, §8.10, #5232).
//!
//! Each entry is rebuilt into the `POST /sync/pull` item it was cut from
//! (`{...meta, id, type, blob}`) with its `sortKey` as `serverCursor`, and
//! goes through [`PullLoop::apply_pack_items`], the decode and apply the pull
//! uses: signature, `cryptoVersion`, delete-wins and clocks decide exactly as
//! for a pulled item. The row keeps the entry's cursor, which the manifest
//! reconcile compares (`first_sync/reconcile.rs`).
//!
//! An unusable entry (no meta, a payload that is not a blob, a failed
//! verify) costs that entry: its `sortKey − 1` bounds where the feed tail
//! starts, so the tail names the item again. A pack that fails to download
//! or parse costs its range, which [`super::tail_start`] then sees as a gap.
//!
//! Downloads run [`RECORD_DOWNLOAD_WIDTH`] at a time; each finished pack is
//! applied in chunks of at most [`RECORD_CHUNK_ENTRIES`] entries or
//! [`RECORD_CHUNK_BYTES`] of payload, whichever comes first. A finished pack
//! is remembered in [`META_RECORD_PACKS_DONE`] with its range, so a killed
//! run downloads it no more and still counts its range.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};
use tokio::task::JoinSet;

use crate::protocol::pack::{PackEntry, PackKind, extract_entry, parse_pack};

use super::super::first_sync_store::{read_meta, write_meta};
use super::super::pull::{PullError, PullLoop};
use super::listing::{PackSummary, list, tail_start};
use super::{PackBootstrap, now};

/// Finished record packs, a JSON array of [`DonePack`].
pub const META_RECORD_PACKS_DONE: &str = "pack_bootstrap.record_packs_done";

/// The lowest `sortKey − 1` of any unusable record entry seen (§8.4.2,
/// **Record tail**). Absent when every entry was usable.
pub const META_RECORD_UNUSABLE_BELOW: &str = "pack_bootstrap.record_unusable_below";

/// Packs in flight at once. Each is held whole (at most 24 MiB, §8.14), so
/// this bounds the downloads' memory at three packs.
pub const RECORD_DOWNLOAD_WIDTH: usize = 3;

/// Entries per apply transaction.
pub const RECORD_CHUNK_ENTRIES: usize = 250;

/// Payload bytes per apply transaction. A chunk of large records is cut here
/// before [`RECORD_CHUNK_ENTRIES`], so the decoded copies held under the
/// database mutex stay near this size whatever the entries weigh.
pub const RECORD_CHUNK_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct DonePack {
    id: String,
    /// `(coverFrom, coverThrough]`, absent for a cache-only pack.
    cover: Option<(i64, i64)>,
}

/// What the record pack phase did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecordPackReport {
    pub packs_applied: usize,
    pub entries_applied: usize,
    /// Rebuilt and handed to the apply, which kept the local row (§6.3.1).
    pub entries_skipped: usize,
    /// Unusable entries, each left item-granular (§8.4.2).
    pub entries_unusable: usize,
    /// Where the record feed tail starts (§8.10, `T_record`).
    pub tail_start: i64,
    /// Whether any record pack is held, applied in this run or an earlier
    /// one: the manifest reconcile is then due (§8.10, **Closing checks**).
    pub used: bool,
    /// Requests this phase sent.
    pub requests: usize,
    pub fallback_reasons: Vec<String>,
}

type Downloaded = (PackSummary, Result<Vec<u8>, String>);

impl PackBootstrap {
    /// Lists, downloads and applies every `record` pack, then answers where
    /// the record tail starts. Errors only on local storage failure; a
    /// network or pack failure is a gap in the report. `on_progress` gets the
    /// note and journal entries of the packs applied so far in this run.
    pub async fn run_records(
        &self,
        pull: &PullLoop,
        now_s: i64,
        on_progress: &(dyn Fn(u64) + Send + Sync),
    ) -> Result<RecordPackReport, PullError> {
        let mut report = RecordPackReport::default();
        let mut done: Vec<DonePack> = self
            .db
            .call(|conn| read_meta(conn, META_RECORD_PACKS_DONE))
            .await?
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let mut unusable_below: Option<i64> = self
            .db
            .call(|conn| read_meta(conn, META_RECORD_UNUSABLE_BELOW))
            .await?
            .and_then(|text| text.parse().ok());

        let listing = match list(&self.http, self.vault_id.as_deref(), now_s).await {
            Ok(listing) => listing,
            Err(reason) => {
                report.requests += 1;
                report.fallback_reasons.push(reason);
                report.used = !done.is_empty();
                return Ok(report);
            }
        };
        report.requests += listing.pages;
        let todo: Vec<PackSummary> = listing
            .packs
            .iter()
            .filter(|pack| pack.kind == PackKind::Record)
            .filter(|pack| !done.iter().any(|held| held.id == pack.id))
            .cloned()
            .collect();
        let mut documents = 0u64;
        on_progress(documents);

        let mut queue = todo.into_iter();
        let mut relisted: Option<Vec<PackSummary>> = None;
        let mut running: JoinSet<Downloaded> = JoinSet::new();
        loop {
            while running.len() < RECORD_DOWNLOAD_WIDTH {
                let Some(mut pack) = queue.next() else { break };
                if !pack.live(now()) {
                    // URLs are signed once at listing time; one re-list mints
                    // fresh ones for a run that outlived them (§8.12).
                    if relisted.is_none() {
                        report.requests += 1;
                        relisted = Some(
                            list(&self.http, self.vault_id.as_deref(), now())
                                .await
                                .map(|listing| listing.packs)
                                .unwrap_or_default(),
                        );
                    }
                    match relisted.iter().flatten().find(|fresh| fresh.id == pack.id) {
                        Some(fresh) if fresh.live(now()) => pack.url = fresh.url.clone(),
                        _ => {
                            report
                                .fallback_reasons
                                .push(format!("pack {} expired and was not re-signed", pack.id));
                            continue;
                        }
                    }
                }
                report.requests += 1;
                let http = Arc::clone(&self.http);
                running.spawn(async move {
                    let bytes = download(&http, &pack).await;
                    (pack, bytes)
                });
            }
            let Some(joined) = running.join_next().await else {
                break;
            };
            let (pack, bytes) =
                joined.map_err(|error| crate::api::errors::StorageError::Failed {
                    what: format!("a record pack download did not finish: {error}"),
                })?;
            let parsed = bytes.and_then(|bytes| {
                parse_pack(&bytes)
                    .map(|parsed| (bytes, parsed.entries))
                    .map_err(|error| error.to_string())
            });
            let (bytes, entries) = match parsed {
                Ok(parsed) => parsed,
                // §8.12: a 404, an expired URL or a bad digest makes the pack
                // absent and its range a gap. Never retried past the transport.
                Err(reason) => {
                    report
                        .fallback_reasons
                        .push(format!("pack {}: {reason}", pack.id));
                    continue;
                }
            };
            let lowest = self
                .apply_record_entries(pull, &bytes, &entries, &mut report)
                .await?;
            if let Some(lowest) = lowest {
                unusable_below = Some(unusable_below.map_or(lowest, |held| held.min(lowest)));
            }
            done.push(DonePack {
                id: pack.id.clone(),
                cover: pack.cover,
            });
            self.write_record_progress(&done, unusable_below).await?;
            report.packs_applied += 1;
            documents += entries.iter().filter(|entry| is_document(entry)).count() as u64;
            on_progress(documents);
        }

        report.used = !done.is_empty();
        let ranges: Vec<(i64, i64)> = done.iter().filter_map(|pack| pack.cover).collect();
        let covered = tail_start(&ranges, listing.coverage.get("record").copied());
        report.tail_start = unusable_below
            .map_or(covered, |below| covered.min(below))
            .max(0);
        Ok(report)
    }

    /// Rebuilds and applies one pack's entries, chunk by chunk. Answers the
    /// lowest `sortKey − 1` among the entries found unusable.
    async fn apply_record_entries(
        &self,
        pull: &PullLoop,
        bytes: &[u8],
        entries: &[PackEntry],
        report: &mut RecordPackReport,
    ) -> Result<Option<i64>, PullError> {
        let mut lowest: Option<i64> = None;
        let mut unusable = |sort_key: i64, report: &mut RecordPackReport| {
            report.entries_unusable += 1;
            let below = sort_key - 1;
            lowest = Some(lowest.map_or(below, |held: i64| held.min(below)));
        };
        let mut chunk: Vec<Json> = Vec::new();
        let mut chunk_bytes = 0usize;
        for (at, entry) in entries.iter().enumerate() {
            // Every pack holds one kind, and a reader still checks each entry.
            // A skipped entry still reaches the flush below, so a pack that
            // ends on one applies the chunk before it.
            if entry.kind == PackKind::Record {
                match rebuild_item(bytes, entry) {
                    // An undeclared type is exempt from the tail bound: the
                    // tail would not serve it either (§8.4.2, **Undeclared
                    // types**).
                    Rebuilt::Item(item) if !pull.declares(item_type_of(&item)) => {}
                    Rebuilt::Item(item) => {
                        chunk_bytes += entry.length as usize;
                        chunk.push(item);
                    }
                    Rebuilt::Unusable => unusable(entry.sort_key, report),
                }
            }
            let last = at + 1 == entries.len();
            let full = chunk.len() >= RECORD_CHUNK_ENTRIES || chunk_bytes >= RECORD_CHUNK_BYTES;
            if !chunk.is_empty() && (full || last) {
                let (applied, failed) = pull.apply_pack_items(std::mem::take(&mut chunk)).await?;
                chunk_bytes = 0;
                report.entries_applied += applied.applied + applied.deleted;
                report.entries_skipped += applied.skipped + applied.expired + applied.corrupt;
                for item in failed {
                    let cursor = item.get("serverCursor").and_then(Json::as_i64).unwrap_or(0);
                    unusable(cursor, report);
                }
            }
        }
        Ok(lowest)
    }

    async fn write_record_progress(
        &self,
        done: &[DonePack],
        unusable_below: Option<i64>,
    ) -> Result<(), PullError> {
        let text = serde_json::to_string(done).map_err(|error| {
            crate::api::errors::StorageError::Failed {
                what: error.to_string(),
            }
        })?;
        self.db
            .call(move |conn| {
                if let Some(below) = unusable_below {
                    write_meta(conn, META_RECORD_UNUSABLE_BELOW, &below.to_string())?;
                }
                write_meta(conn, META_RECORD_PACKS_DONE, &text)
            })
            .await?;
        Ok(())
    }
}

enum Rebuilt {
    Item(Json),
    Unusable,
}

/// A `note` or `journal` record entry (`type:id`, §8.4).
fn is_document(entry: &PackEntry) -> bool {
    entry.kind == PackKind::Record
        && matches!(entry.id.split_once(':'), Some(("note" | "journal", _)))
}

fn item_type_of(item: &Json) -> &str {
    item.get("type").and_then(Json::as_str).unwrap_or_default()
}

/// §8.4.2's **Rebuild**: `{...meta, id, type, blob}`, plus the entry's
/// `sortKey` as `serverCursor` so the applied row holds the cursor of the
/// write it is. Meta absent, not an object, or a payload that is not a JSON
/// object makes the entry unusable; the decode then validates the rest.
fn rebuild_item(bytes: &[u8], entry: &PackEntry) -> Rebuilt {
    let Some((item_type, item_id)) = entry.id.split_once(':') else {
        return Rebuilt::Unusable;
    };
    if item_type.is_empty() || item_id.is_empty() {
        return Rebuilt::Unusable;
    }
    let Some(Json::Object(meta)) = entry.meta.as_ref() else {
        return Rebuilt::Unusable;
    };
    let Ok(payload) = extract_entry(bytes, entry) else {
        return Rebuilt::Unusable;
    };
    let Ok(Json::Object(blob)) = serde_json::from_slice::<Json>(payload) else {
        return Rebuilt::Unusable;
    };
    let mut item: Map<String, Json> = meta.clone();
    item.insert("id".to_owned(), Json::String(item_id.to_owned()));
    item.insert("type".to_owned(), Json::String(item_type.to_owned()));
    item.insert("blob".to_owned(), Json::Object(blob));
    item.insert("serverCursor".to_owned(), Json::from(entry.sort_key));
    Rebuilt::Item(Json::Object(item))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, meta: Option<Json>) -> PackEntry {
        PackEntry {
            kind: PackKind::Record,
            id: id.to_owned(),
            source_key: String::new(),
            sort_key: 42,
            meta,
            offset: 0,
            length: 0,
            sha256: [0; 32],
        }
    }

    #[test]
    fn an_entry_without_meta_or_with_a_bad_identity_is_unusable() {
        assert!(matches!(
            rebuild_item(&[], &entry("note:a", None)),
            Rebuilt::Unusable
        ));
        let meta = Some(serde_json::json!({"operation": "update"}));
        assert!(matches!(
            rebuild_item(&[], &entry("no-colon", meta.clone())),
            Rebuilt::Unusable
        ));
        assert!(matches!(
            rebuild_item(&[], &entry(":a", meta)),
            Rebuilt::Unusable
        ));
    }
}
