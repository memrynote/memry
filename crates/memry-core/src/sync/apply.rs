//! The apply step of an inbound page, and **the one place an item's type
//! chooses its merge algorithm** (chapter 06 §6.8, chapter 05 §5.12, §5.14).
//!
//! Every route that brings a record into this device ends here: the
//! steady-state page ([`super::pull::PullLoop::pull_page`]) and the first
//! sync's metadata pass ([`super::pull::PullLoop::fetch_ids`], driven by
//! [`super::first_sync`]) both hand their decoded items to [`apply_page`].
//! That is deliberate. Chapter 06 §6.8 is a table over item types, and a table
//! consulted at each call site is a table the next call site forgets:
//! `task` and `project` are field-merged, `settings` has its own dotted-path
//! shape, and **everything else runs §6.3.1's document-level gate** before it
//! is stored. The choice is made **once**, in [`apply_inbound`], and a third
//! inbound path gets it by construction rather than by review.
//!
//! Four rules shape the branches below.
//!
//! - **A tombstone never reaches a parser** (§5.12, §13.7.2, §6.9.2). The
//!   delete is recorded and the body is never decoded, so a delete cannot
//!   reach the field merge — or the document gate — at all.
//! - **A bare tombstone outranks the item that follows it** (§5.12.1), which
//!   is checked before the type is dispatched on: a deleted row has no fields
//!   to merge.
//! - **A failure is [`ApplyOutcome::Corrupt`], never a skip.** The merge path
//!   can fail in ways the wholesale path cannot — an unparseable stored clock,
//!   a `fieldClocks` map that is not one (chapter 06 §6.10 forbids reading
//!   either as empty) — and letting one of those propagate would abort the
//!   page with the cursor unmoved, wedging the device on a single poisoned
//!   row forever. The row is kept, the reason is recorded against it, and the
//!   page carries on (§13.2 rule 5).
//! - **One vocabulary.** The pull loop counts applied, deleted, skipped,
//!   corrupt and expired; the field-merged path reports through the same
//!   [`ApplyOutcome`] so the counters and the cursor cannot drift apart from
//!   what actually happened (FR-032).
//!
//! **Nothing here enqueues.** §6.5.2's P3 — the merging device stores the
//! union clock and does not re-push — is upheld by
//! [`crate::domain::task_merge`], and a [`crate::sync::outbox::enqueue`]
//! appearing anywhere on this path is that regression, not a convenience.

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::update_log;
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::domain::{inbox, projects, settings, tasks};
use crate::storage::repositories::projectors;
use crate::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};

use super::clock::{ClockOrder, VectorClock, compare};
use super::{body_debt, settings_merge, store};

/// One decoded item, waiting for its turn in the apply order (§5.13).
pub(crate) enum Pending {
    Record(InboundRecord),
    Tombstone {
        item_type: String,
        item_id: String,
        deleted_at: i64,
        server_cursor: Option<i64>,
        /// The delete's clock; `None` for a legacy tombstone stored without one.
        clock: Option<VectorClock>,
    },
}

impl Pending {
    pub(crate) fn item_type(&self) -> &str {
        match self {
            Pending::Record(record) => &record.item_type,
            Pending::Tombstone { item_type, .. } => item_type,
        }
    }

    pub(crate) fn item_id(&self) -> &str {
        match self {
            Pending::Record(record) => &record.item_id,
            Pending::Tombstone { item_id, .. } => item_id,
        }
    }
}

/// What one page's apply step did, in the five outcomes the pull reports.
#[derive(Default)]
pub(crate) struct ApplyTotals {
    pub(crate) applied: usize,
    pub(crate) deleted: usize,
    /// §6.3.1: the local clock dominates. Work, not a failure.
    pub(crate) skipped: usize,
    pub(crate) corrupt: usize,
    pub(crate) expired: usize,
    /// The documents whose body log this page actually emptied (§7.15).
    ///
    /// The durable half of §7.15's first consequence is done by the time this
    /// is read; the **in-memory** half is not, because the apply path holds no
    /// [`crate::crdt::DocumentRegistry`] and cannot drop a resident
    /// [`crate::crdt::Document`]. Naming the ids is the difference between a
    /// core that says "the body is gone" and one that says "the body is gone
    /// from disk — release these". A caller holding a registry releases each;
    /// a caller holding none has nothing resident to release.
    pub(crate) purged_documents: Vec<String>,
    /// The `note` and `journal` records this page wrote, so the pull can tell
    /// which of its body debts a skip made unnecessary.
    pub(crate) applied_documents: Vec<String>,
}

/// The two item types whose bodies are CRDT documents (chapter 07, §12.3).
///
/// The list is closed and it is checked against the item's **type**, never
/// against the shape of its id. A tag may legally be named the twelve
/// characters a note id is made of (§5.12.1), and purging on a name collision
/// would delete a live note's body for a deleted tag — unrecoverable, because
/// §7.15 leaves the server rows in place but this device would no longer be
/// asking for them.
pub(crate) const DOCUMENT_TYPES: [&str; 2] = ["note", "journal"];

/// Applies one page's decoded items, in the order they were handed over, plus
/// the ids §5.12.1 leaves with no type on the wire.
pub(crate) fn apply_page(
    conn: &Connection,
    pending: Vec<Pending>,
    untyped: Vec<String>,
    now_ms: i64,
) -> Result<ApplyTotals, StorageError> {
    let mut totals = ApplyTotals::default();
    for item in pending {
        match item {
            Pending::Tombstone {
                item_type,
                item_id,
                deleted_at,
                server_cursor,
                clock,
            } => {
                apply_tombstone(
                    conn,
                    &item_type,
                    &item_id,
                    deleted_at,
                    server_cursor,
                    clock.as_ref(),
                    now_ms,
                    &mut totals,
                )?;
            }
            Pending::Record(record) => {
                // §5.12.1: a bare tombstone outranks the item that arrives
                // after it, or the "does not resurrect it locally" guarantee
                // holds only until the next page.
                if store::has_bare_tombstone(conn, &record.item_id)? {
                    apply_tombstone(
                        conn,
                        &record.item_type,
                        &record.item_id,
                        now_ms,
                        record.server_cursor,
                        None,
                        now_ms,
                        &mut totals,
                    )?;
                    continue;
                }
                match apply_inbound(conn, &record, now_ms)? {
                    ApplyOutcome::Applied => {
                        totals.applied += 1;
                        if DOCUMENT_TYPES.contains(&record.item_type.as_str()) {
                            totals.applied_documents.push(record.item_id.clone());
                        }
                    }
                    ApplyOutcome::Skipped => totals.skipped += 1,
                    ApplyOutcome::Corrupt { .. } => totals.corrupt += 1,
                    ApplyOutcome::Expired => totals.expired += 1,
                }
            }
        }
    }
    for item_id in untyped {
        apply_untyped_tombstone(conn, &item_id, now_ms, &mut totals)?;
    }
    Ok(totals)
}

/// One typed delete, as §7.15's first two consequences require it: the record
/// row, **its projection**, and the document's body log, in one transaction.
///
/// Three statements and one rule each.
///
/// - [`store::mark_deleted`] is the record tier, and it keeps the stored
///   payload byte for byte (§5.12: the body is never decoded).
/// - [`projectors::delete`] is the half that was missing, and the one with
///   teeth. Nothing else writes `notes.deleted_at`, and until it did, a note
///   deleted on another device stayed live in every projection-driven read on
///   this one — and, worse, stayed inside
///   [`super::first_sync_store::recent_document_ids`]'s `deleted_at IS NULL`
///   window, so the next first sync handed a tombstoned id to
///   [`super::body_pull::pull_document`] and re-applied the surviving server
///   log over a deleted note's body.
/// - [`update_log::purge_in`] is §7.15's first consequence, for a document
///   type only.
///
/// **One transaction, not three.** A crash between the record delete and the
/// purge would leave a deleted note with a live body, which is precisely the
/// state §7.15 forbids; a failure in any statement rolls the delete back whole
/// and propagates, so the page aborts with the cursor unmoved and the delete
/// arrives again. A purge that quietly did nothing would be worse than one
/// that errors: the caller would believe the body was gone.
///
/// **A clocked delete is recorded, then weighed** (#2409). Its clock is kept
/// for a later re-create of the id ([`store::record_tombstone_clock`]), and a
/// live local row whose clock happens strictly after it keeps the item: the
/// §5.8 client rule, and what stops this device's own late tombstone from
/// deleting the re-create that followed it. A tombstone with no clock applies
/// unconditionally, as it always has.
#[allow(clippy::too_many_arguments)]
fn apply_tombstone(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    deleted_at: i64,
    server_cursor: Option<i64>,
    clock: Option<&VectorClock>,
    now_ms: i64,
    totals: &mut ApplyTotals,
) -> Result<(), StorageError> {
    let txn = conn.unchecked_transaction().map_err(sqlite_failed)?;
    if let Some(clock) = clock.filter(|clock| !clock.is_empty()) {
        store::record_tombstone_clock(&txn, item_type, item_id, clock, now_ms)?;
        if live_clock_is_after(&txn, item_type, item_id, clock)? {
            txn.commit().map_err(sqlite_failed)?;
            totals.skipped += 1;
            return Ok(());
        }
    }
    store::mark_deleted(&txn, item_type, item_id, deleted_at, server_cursor, now_ms)?;
    projectors::delete(&txn, item_type, item_id, deleted_at)?;
    let purged = if DOCUMENT_TYPES.contains(&item_type) {
        // The body debt goes with the body: a pull owed before the delete
        // would bring the server's surviving log back (#2297).
        body_debt::settle(&txn, item_id)?;
        update_log::purge_in(&txn, item_id).map_err(crdt_failed)?
    } else {
        0
    };
    txn.commit().map_err(sqlite_failed)?;
    totals.deleted += 1;
    if purged > 0 {
        totals.purged_documents.push(item_id.to_owned());
    }
    Ok(())
}

/// Whether the live local row's clock happens strictly after `tombstone`.
///
/// A row that is already deleted, has no clock, or whose clock will not parse
/// is not after anything, so the delete applies exactly as before #2409.
fn live_clock_is_after(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    tombstone: &VectorClock,
) -> Result<bool, StorageError> {
    let Some(row) = sync_items::load(conn, item_type, item_id)? else {
        return Ok(false);
    };
    let local = row
        .clock
        .filter(|_| row.deleted_at.is_none())
        .and_then(|text| serde_json::from_str::<VectorClock>(&text).ok());
    Ok(local.is_some_and(|local| compare(&local, tombstone) == ClockOrder::After))
}

/// An id from `deleted` that arrived with **no type on the wire** (§5.12.1).
///
/// The untyped delete covers *every* row under that id, whatever its type, so
/// the projection half reads the types this device actually stored
/// ([`store::item_types_for`]) and marks the tables each one names. The wire
/// carried no type and a client MUST NOT invent one from the id's shape, so
/// the local rows are the only honest source for that list.
///
/// The purge runs **unconditionally** here, and that is not the id-shape
/// inference §5.12.1 forbids. The typed arm above has to be careful because a
/// tag named like a note id would otherwise take the note's body with it; here
/// there is no such case to be careful about, because every row under the id —
/// the note's included — is being deleted. Body rows under a purely local
/// document this device never got a record for go with it, which is the same
/// rule read from the other side (§5.12: a delete for an unseen item is still
/// recorded).
fn apply_untyped_tombstone(
    conn: &Connection,
    item_id: &str,
    now_ms: i64,
    totals: &mut ApplyTotals,
) -> Result<(), StorageError> {
    let txn = conn.unchecked_transaction().map_err(sqlite_failed)?;
    let item_types = store::item_types_for(&txn, item_id)?;
    store::apply_untyped_tombstone(&txn, item_id, now_ms, now_ms)?;
    for item_type in &item_types {
        projectors::delete(&txn, item_type, item_id, now_ms)?;
    }
    body_debt::settle(&txn, item_id)?;
    let purged = update_log::purge_in(&txn, item_id).map_err(crdt_failed)?;
    txn.commit().map_err(sqlite_failed)?;
    totals.deleted += 1;
    if purged > 0 {
        totals.purged_documents.push(item_id.to_owned());
    }
    Ok(())
}

fn sqlite_failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// The CRDT tier's failure, back in the storage vocabulary this path speaks.
///
/// [`CrdtError::Storage`] is unwrapped rather than stringified: a purge cannot
/// fail for any CRDT reason — it decodes nothing — so the only variant reachable
/// here is a disk or lock failure, and flattening it would turn "out of space"
/// into "bad document".
fn crdt_failed(error: CrdtError) -> StorageError {
    match error {
        CrdtError::Storage { source } => source,
        other => StorageError::Failed {
            what: other.to_string(),
        },
    }
}

/// Chapter 06 §6.8's table, as the one `match` this core makes on it.
///
/// Every one of the four rows is here, and the fourth is the one that cost a
/// user their edit before it was:
///
/// - `task` and `project` run §6.3.1's document gate followed by §6.3's
///   per-field rule;
/// - `settings` runs §6.9's dotted-path field clocks
///   ([`crate::sync::settings_merge`]): the payload carries no document
///   `clock` at all (§13.7.13, §13.9), so §6.3.1's first row would fire on
///   every pull and the per-path clocks are the whole mechanism. §6.8 forbids
///   inferring an algorithm from the absence of a field list, so it is named
///   here rather than falling through `_`;
/// - **every other subscribed type takes §6.3.1's document-level resolver**
///   ([`apply_document`]). It is *not* an unconditional wholesale store: a
///   stale remote `note` record used to overwrite a newer local one, and a
///   rename made on this device vanished the moment a peer that had not seen
///   it pushed anything.
pub fn apply_inbound(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<ApplyOutcome, StorageError> {
    let merged = match record.item_type.as_str() {
        tasks::ITEM_TYPE => tasks::apply_remote(conn, record, now_ms),
        projects::ITEM_TYPE => projects::apply_remote(conn, record, now_ms),
        settings::SETTINGS_ITEM_TYPE => settings_merge::apply_remote_merged(conn, record, now_ms),
        // "absent key keeps, explicit null clears" (desktop's inbox handler).
        inbox::ITEM_TYPE => inbox::merge::apply_remote(conn, record, now_ms),
        _ => apply_document(conn, record, now_ms),
    };
    match merged {
        Ok(inbound) => Ok(outcome(inbound)),
        Err(error) => refuse(conn, record, &error.to_string(), now_ms),
    }
}

/// §6.8's fourth row: §6.3.1's document-level resolver, with no per-field step
/// under it.
///
/// The three actions are the chapter's, verbatim. `concurrent` is the one the
/// table does not spell out for a type with no `fieldClocks`, and the answer
/// falls out of what a merge *is* here: there are no fields to arbitrate, so
/// the remote payload applies and the **merged** clock is what gets stored
/// (§6.3.1, `mergedClock = merge(local, remote)`). Storing the remote's clock
/// instead would drop the local's ticks, lower `clockTotal` and hand the next
/// concurrent peer the win (§6.10).
///
/// **Nothing here enqueues** (§6.5.2 P3), including on the merge branch.
fn apply_document(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    match task_merge::document_gate(conn, record)? {
        Gate::Wholesale => task_merge::wholesale(conn, record, now_ms),
        Gate::Skip => Ok(Inbound::Skipped),
        Gate::Merge {
            remote,
            merged_clock,
            ..
        } => {
            let payload_json = task_merge::with_clock(&remote, &merged_clock)?;
            let merged = InboundRecord {
                payload_json,
                ..record.clone()
            };
            task_merge::wholesale(conn, &merged, now_ms)
        }
    }
}

/// The merge's own vocabulary, in the pull's.
///
/// `Merged`'s conflict set is deliberately dropped here. §6.5.3 and §6.5.4
/// make the conflicts something a *caller* may show a user; §6.3.1's core
/// obligation is that the core writes them nowhere, because desktop's
/// `superseded` rows sync to every device as `task_activity`.
fn outcome(inbound: Inbound) -> ApplyOutcome {
    match inbound {
        Inbound::Applied | Inbound::Merged { .. } => ApplyOutcome::Applied,
        Inbound::Skipped => ApplyOutcome::Skipped,
        Inbound::Corrupt { reason } => ApplyOutcome::Corrupt { reason },
    }
}

/// A merge that could not proceed: the row stays, flagged, and the page goes
/// on (§13.2 rule 5).
///
/// The merge branch rolled its transaction back before returning, so nothing
/// half-written survives. Writing the flag through the same connection is also
/// the honest test of *why* the merge failed: a payload this build cannot read
/// leaves the flag; a disk or lock failure fails here too and propagates,
/// rather than being recorded as a corrupt payload it never was.
fn refuse(
    conn: &Connection,
    record: &InboundRecord,
    reason: &str,
    now_ms: i64,
) -> Result<ApplyOutcome, StorageError> {
    sync_items::upsert_metadata_only(
        conn,
        &record.item_type,
        &record.item_id,
        now_ms,
        record.server_cursor,
    )?;
    sync_items::mark_corrupt(conn, &record.item_type, &record.item_id, reason, now_ms)?;
    Ok(ApplyOutcome::Corrupt {
        reason: reason.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_field_merged_types_are_the_two_chapter_06_names() {
        // §6.8 is an enumeration, not a heuristic. If either constant ever
        // drifts, the dispatch silently stops merging and the last writer
        // wins the whole payload again.
        assert_eq!(tasks::ITEM_TYPE, "task");
        assert_eq!(projects::ITEM_TYPE, "project");
        // And the third row is named rather than falling through `_`: §6.9's
        // dotted paths are a different algorithm from §6.3.1's document gate,
        // and folding one into the other is what §6.8 forbids.
        assert_eq!(settings::SETTINGS_ITEM_TYPE, "settings");
    }

    // #2409: a late tombstone the revived row already dominates keeps it; a
    // tombstone with no clock has nothing to weigh and applies as before.
    #[test]
    fn a_tombstone_older_than_a_revived_row_is_skipped_and_a_clockless_one_still_applies() {
        use crate::domain::journal;
        use crate::storage::{open_data, test_support::temp_dir};
        use crate::sync::clock::clock_of;

        let dir = temp_dir("apply-late-tombstone");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        let delete = |clock| Pending::Tombstone {
            item_type: "journal".to_owned(),
            item_id: "j2026-04-16".to_owned(),
            deleted_at: 5,
            server_cursor: None,
            clock,
        };
        let live = |conn: &Connection| -> bool {
            sync_items::load(conn, "journal", "j2026-04-16")
                .expect("read")
                .is_some_and(|row| row.deleted_at.is_none())
        };
        db.call_blocking(|conn| {
            journal::open_day(conn, "2026-04-16", "device-a", 1)?;
            let first = clock_of([("device-a", 1), ("device-b", 1)]);
            assert_eq!(
                apply_page(conn, vec![delete(Some(first.clone()))], vec![], 2)?.deleted,
                1
            );
            journal::open_day(conn, "2026-04-16", "device-a", 3)?;

            let late = apply_page(conn, vec![delete(Some(first))], vec![], 4)?;
            assert_eq!((late.deleted, late.skipped), (0, 1));
            assert!(live(conn));

            let clockless = apply_page(conn, vec![delete(None)], vec![], 5)?;
            assert_eq!(clockless.deleted, 1);
            assert!(!live(conn));
            Ok(())
        })
        .expect("late tombstone");
    }

    #[test]
    fn a_merge_outcome_maps_onto_the_pull_vocabulary_without_a_silent_skip() {
        assert_eq!(outcome(Inbound::Applied), ApplyOutcome::Applied);
        assert_eq!(
            outcome(Inbound::Merged {
                conflicted_fields: vec!["title".to_owned()],
            }),
            ApplyOutcome::Applied
        );
        assert_eq!(outcome(Inbound::Skipped), ApplyOutcome::Skipped);
        assert_eq!(
            outcome(Inbound::Corrupt {
                reason: "bad".to_owned(),
            }),
            ApplyOutcome::Corrupt {
                reason: "bad".to_owned(),
            }
        );
    }
}
