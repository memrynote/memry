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
//! **Nothing here re-pushes what it applied.** §6.5.2's P3 — the merging
//! device stores the union clock and does not re-push — is upheld by
//! [`crate::domain::task_merge`], and a [`crate::sync::outbox::enqueue`] of an
//! applied item anywhere on this path is that regression, not a convenience.
//! The outbox rows an apply writes are new items that exist nowhere else: a
//! canvas conflict copy ([`crate::domain::canvas::merge`]) and a kept copy of
//! text a delete never saw ([`super::delete_keep`]). The one re-push is
//! §6.11.4's heal of a versioned key the remote is behind on
//! ([`super::versioned_apply`]), which §6.11.4 bounds so two clients never
//! ping-pong.
use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::crypto::agent_envelope::AtRestKey;
use crate::storage::repositories::sync_items::{ApplyOutcome, InboundRecord};

use super::clock::VectorClock;
use super::{refused_items, store};

mod record;
mod tombstone;

use record::apply_record;
pub use record::{apply_inbound, apply_inbound_on};
use tombstone::{apply_tombstone, apply_untyped_tombstone};

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
        /// The deleter's `bodyStateVector` (§5.8, #3037); `None` when absent.
        body_state_vector: Option<String>,
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

/// §5.13's `PULL_APPLY_ORDER`. **Everything unlisted is rank 1.**
pub fn apply_rank(item_type: &str) -> u8 {
    match item_type {
        "project" | "folder_config" | "tag_definition" | "filter" | "settings"
        | "calendar_source" | "agent_conversation" => 0,
        "task" | "agent_message" | "calendar_event" | "calendar_external_event" => 2,
        "calendar_binding" => 3,
        _ => 1,
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
    /// `(type, id)` of the records the type's schema refused, counted in
    /// `skipped` too. The pull records them in [`super::refused_items`] under
    /// its app version, which this step does not know.
    pub(crate) refused: Vec<(String, String)>,
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
///
/// `clock_device` is this device's clock id (chapter 01 §1.5), which a canvas
/// conflict copy is clocked under. `at_rest` seals the agent records
/// ([`crate::crypto::agent_payload`]).
pub(crate) fn apply_page(
    conn: &Connection,
    pending: Vec<Pending>,
    untyped: Vec<String>,
    now_ms: i64,
    clock_device: Option<&str>,
    at_rest: &AtRestKey,
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
                body_state_vector,
            } => {
                apply_tombstone(
                    conn,
                    &item_type,
                    &item_id,
                    deleted_at,
                    server_cursor,
                    clock.as_ref(),
                    body_state_vector.as_deref(),
                    now_ms,
                    clock_device,
                    &mut totals,
                )?;
                refused_items::resolve(conn, &item_type, &item_id)?;
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
                        None,
                        now_ms,
                        clock_device,
                        &mut totals,
                    )?;
                    refused_items::resolve(conn, &record.item_type, &record.item_id)?;
                    continue;
                }
                let outcome = apply_record(conn, &record, now_ms, clock_device, at_rest)?;
                refused_items::settle(conn, &record, &outcome, &mut totals.refused)?;
                match outcome {
                    ApplyOutcome::Applied => {
                        totals.applied += 1;
                        if DOCUMENT_TYPES.contains(&record.item_type.as_str()) {
                            totals.applied_documents.push(record.item_id.clone());
                        }
                    }
                    ApplyOutcome::Skipped | ApplyOutcome::Refused => totals.skipped += 1,
                    ApplyOutcome::Corrupt { .. } => totals.corrupt += 1,
                    ApplyOutcome::Expired => totals.expired += 1,
                }
            }
        }
    }
    for item_id in untyped {
        apply_untyped_tombstone(conn, &item_id, now_ms, &mut totals)?;
        refused_items::resolve_id(conn, &item_id)?;
    }
    Ok(totals)
}

fn sqlite_failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
mod bench;
#[cfg(test)]
mod tests;
