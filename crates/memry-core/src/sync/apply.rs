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
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::domain::{
    agent_conversation, agent_message, calendar_items, canvas, canvas_folder, home_page, inbox,
    journal, projects, settings, sticky_draft, tasks,
};
// Desktop only, like the locks themselves: iOS never declares `vault_lock`.
#[cfg(feature = "markdown")]
use crate::domain::vault_locks;
use crate::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};

use super::clock::VectorClock;
use super::versioned_apply::{TAG_SCHEMA, VersionedKey};
use super::{journal_day_merge, refused_items, settings_merge, store};

use super::driver::observer::AppliedFeed;
use super::field_merge::FieldConflict;

mod feed;
mod tombstone;

use tombstone::{apply_tombstone, apply_untyped_tombstone, sqlite_failed};

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
    /// What the observers hear once the page commits.
    pub(crate) feed: AppliedFeed,
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
                let existed = feed::is_live(conn, &record.item_type, &record.item_id)?;
                let (outcome, merged) = apply_record(conn, &record, now_ms, clock_device, at_rest)?;
                refused_items::settle(conn, &record, &outcome, &mut totals.refused)?;
                feed::record(conn, &mut totals.feed, &record, &outcome, existed, merged)?;
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

/// [`apply_inbound_on`] with no device clock id.
pub fn apply_inbound(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<ApplyOutcome, StorageError> {
    apply_inbound_on(conn, record, now_ms, None)
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
///   it pushed anything. `inbox`, the calendar types, `canvas`,
///   `vault_lock`, `canvas_folder`, `home_page`, `sticky_draft` and the two
///   agent types are named
///   because each runs its desktop handler's rule instead.
///
/// `clock_device` is this device's clock id, which a diverged `canvas` needs
/// for its conflict copy. Without one, that canvas is recorded corrupt rather
/// than losing either drawing. No at-rest key is installed here, so an agent
/// record is stored pending; the pull passes its key.
pub fn apply_inbound_on(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
    clock_device: Option<&str>,
) -> Result<ApplyOutcome, StorageError> {
    apply_record(conn, record, now_ms, clock_device, &AtRestKey::default())
        .map(|(outcome, _)| outcome)
}

/// The outcome, and the conflict set when a concurrent merge decided it.
type Applied = (ApplyOutcome, Option<Vec<FieldConflict>>);

fn apply_record(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
    clock_device: Option<&str>,
    at_rest: &AtRestKey,
) -> Result<Applied, StorageError> {
    // One journal item per day (#2939): a foreign id is owed, never stored.
    if record.item_type == journal::ITEM_TYPE
        && let Some(outcome) = journal_day_merge::plan_inbound(conn, record)?
    {
        return Ok((outcome, None));
    }
    let merged = match record.item_type.as_str() {
        tasks::ITEM_TYPE => tasks::apply_remote(conn, record, now_ms, clock_device),
        projects::ITEM_TYPE => projects::apply_remote(conn, record, now_ms),
        settings::SETTINGS_ITEM_TYPE => settings_merge::apply_remote_merged(conn, record, now_ms),
        // "absent key keeps, explicit null clears" (desktop's inbox handler).
        inbox::ITEM_TYPE => inbox::merge::apply_remote(conn, record, now_ms),
        // Desktop's four calendar handlers (spec 007 CL010/CL011).
        t if calendar_items::is_calendar_type(t) => {
            calendar_items::merge::apply_remote(conn, record, now_ms)
        }
        // Whole-document LWW plus desktop's conflict copy (canvas-handler.ts).
        canvas::ITEM_TYPE => canvas::merge::apply_remote(conn, record, now_ms, clock_device),
        // Whole-row LWW, Electron's guards (vault-lock-handler.ts).
        #[cfg(feature = "markdown")]
        vault_locks::ITEM_TYPE => vault_locks::merge::apply_remote(conn, record, now_ms),
        // Whole-row LWW keeping local keys (canvas-folder-handler.ts,
        // home-page-handler.ts, sticky-draft-handler.ts).
        canvas_folder::ITEM_TYPE => canvas_folder::merge::apply_remote(conn, record, now_ms),
        home_page::ITEM_TYPE => home_page::merge::apply_remote(conn, record, now_ms),
        sticky_draft::ITEM_TYPE => sticky_draft::merge::apply_remote(conn, record, now_ms),
        // Field merge, the title sealed (agent-conversation-handler.ts).
        agent_conversation::ITEM_TYPE => {
            agent_conversation::merge::apply_remote(conn, record, at_rest, now_ms)
        }
        // Written once, terminal only, sealed (agent-message-handler.ts).
        agent_message::ITEM_TYPE => {
            agent_message::merge::apply_remote(conn, record, at_rest, now_ms)
        }
        // §6.3.1's document gate, then §6.11's join of the versioned `schema`.
        t if t == TAG_SCHEMA.item_type => {
            apply_versioned(conn, record, &TAG_SCHEMA, now_ms, clock_device)
        }
        _ => apply_document(conn, record, now_ms),
    };
    match merged {
        Ok(Inbound::Merged { conflicts, .. }) => Ok((ApplyOutcome::Applied, Some(conflicts))),
        Ok(inbound) => Ok((outcome(inbound), None)),
        Err(error) => Ok((refuse(conn, record, &error.to_string(), now_ms)?, None)),
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

/// [`apply_document`], then the join of `key` over whatever it kept, and the
/// heal §6.11.4 owes when the remote is behind.
fn apply_versioned(
    conn: &Connection,
    record: &InboundRecord,
    key: &VersionedKey,
    now_ms: i64,
    clock_device: Option<&str>,
) -> Result<Inbound, StorageError> {
    let local = key.local(conn, record)?;
    let inbound = apply_document(conn, record, now_ms)?;
    key.join_after_apply(conn, record, local, &inbound, clock_device, now_ms)?;
    Ok(inbound)
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
        Inbound::Refused => ApplyOutcome::Refused,
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
mod bench;
#[cfg(test)]
mod feed_tests;
#[cfg(test)]
mod tests;
