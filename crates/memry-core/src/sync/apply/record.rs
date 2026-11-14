//! The record half of [`super::apply_page`]: chapter 06 §6.8's table, the
//! one `match` this core makes on an item's type.

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
use crate::sync::versioned_apply::{TAG_SCHEMA, VersionedKey};
use crate::sync::{journal_day_merge, settings_merge};

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
}

pub(super) fn apply_record(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
    clock_device: Option<&str>,
    at_rest: &AtRestKey,
) -> Result<ApplyOutcome, StorageError> {
    // One journal item per day (#2939): a foreign id is owed, never stored.
    if record.item_type == journal::ITEM_TYPE
        && let Some(outcome) = journal_day_merge::plan_inbound(conn, record)?
    {
        return Ok(outcome);
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
pub(super) fn outcome(inbound: Inbound) -> ApplyOutcome {
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
