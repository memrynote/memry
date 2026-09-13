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
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::domain::{projects, settings, tasks};
use crate::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};

use super::store;

/// One decoded item, waiting for its turn in the apply order (§5.13).
pub(crate) enum Pending {
    Record(InboundRecord),
    Tombstone {
        item_type: String,
        item_id: String,
        deleted_at: i64,
        server_cursor: Option<i64>,
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
}

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
            } => {
                store::mark_deleted(
                    conn,
                    &item_type,
                    &item_id,
                    deleted_at,
                    server_cursor,
                    now_ms,
                )?;
                totals.deleted += 1;
            }
            Pending::Record(record) => {
                // §5.12.1: a bare tombstone outranks the item that arrives
                // after it, or the "does not resurrect it locally" guarantee
                // holds only until the next page.
                if store::has_bare_tombstone(conn, &record.item_id)? {
                    store::mark_deleted(
                        conn,
                        &record.item_type,
                        &record.item_id,
                        now_ms,
                        record.server_cursor,
                        now_ms,
                    )?;
                    totals.deleted += 1;
                    continue;
                }
                match apply_inbound(conn, &record, now_ms)? {
                    ApplyOutcome::Applied => totals.applied += 1,
                    ApplyOutcome::Skipped => totals.skipped += 1,
                    ApplyOutcome::Corrupt { .. } => totals.corrupt += 1,
                    ApplyOutcome::Expired => totals.expired += 1,
                }
            }
        }
    }
    for item_id in untyped {
        store::apply_untyped_tombstone(conn, &item_id, now_ms, now_ms)?;
        totals.deleted += 1;
    }
    Ok(totals)
}

/// Chapter 06 §6.8's table, as the one `match` this core makes on it.
///
/// Every one of the four rows is here, and the fourth is the one that cost a
/// user their edit before it was:
///
/// - `task` and `project` run §6.3.1's document gate followed by §6.3's
///   per-field rule;
/// - `settings` is **excluded on purpose** — §6.9's dotted-path clocks are a
///   third algorithm, not this one, and §6.8 forbids inferring an algorithm
///   from the absence of a field list. It stays on the wholesale path until
///   §6.9 is implemented inbound; see [`apply_settings`];
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
        settings::SETTINGS_ITEM_TYPE => return apply_settings(conn, record, now_ms),
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

/// `settings`, which §6.8 sends down a third path this core does not implement
/// inbound yet.
///
/// §6.9's clocks are keyed by dotted path at arbitrary depth, so neither the
/// per-field merge of §6.3 nor the document gate of §6.3.1 is the right
/// algorithm for it — and the payload carries no document `clock` at all
/// (§13.7.13, §13.9: `settings` is the one record type exempt from the clock
/// requirement), so a document gate would find no local clock and apply
/// wholesale on every pull regardless. Wholesale is therefore what it already
/// does; naming it here rather than letting it fall through `_` is the point,
/// so that implementing §6.9 is a change to this function and not a discovery.
fn apply_settings(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<ApplyOutcome, StorageError> {
    sync_items::apply_remote(conn, record, now_ms)
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
