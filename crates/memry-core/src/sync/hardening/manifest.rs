//! The manifest check, Electron's `checkManifestIntegrity`
//! (`apps/desktop/src/main/sync/manifest-check.ts`, chapter 05 §5.15), at most
//! once per 30 minutes per driver.
//!
//! `GET /sync/manifest` lists every live record the server holds, `(type,
//! id)` only. The diff runs both ways, always on `(type, id)` (§5.15), with a
//! note and a journal of one id counted as one item in either spelling
//! (`manifest-check.ts:164-171,281-285`):
//!
//! - **Server only.** A live server row this device holds no row of is pulled
//!   by id (`:226-243`, #3391). Not `task_activity` (pruned here by design,
//!   `:229-235`), not an undeclared type, not one the refused-items ledger or
//!   a permanent quarantine holds (`:241-242`). A local row of any state
//!   counts as held: a tombstone, a metadata-only row or a corrupt one each
//!   have their own path, and pulling them here would undo it.
//! - **Local only.** A live, clocked, fully stored row the server does not
//!   list is queued as `create` (`:180-224`), so a push lost before it reached
//!   the server goes out again. Only after a pull that delivered in the same
//!   pass (`reuploadLocalOnly`, `:63-70`), which is when the driver calls it.
//!   A row with anything already queued is left to that push.
//!
//! **Asked about first: notes, journals and bookmarks** ([`PROBED`], #4785).
//! The server re-creates them over a purged tombstone (§5.12.3), and a marker
//! the pull skipped (a run from cursor 0, a first sync's refs pass) or refused
//! (unattested, an unknown signer, a quarantine) leaves no trace here, so a
//! row still live here can be one another device deleted. Before one is
//! queued, `POST /sync/pull` names its id, which serves a marker whatever the
//! cursor: a tombstone or a marker means the item was deleted, so nothing is
//! queued. Its clock is recorded ([`store::record_tombstone_clock`]) only when
//! a device signed it: a marker [`purged::attest`] attests, or a tombstone
//! whose envelope signature verifies under its signer's key. The server is
//! untrusted, and a recorded clock is signed into a re-created journal day
//! (`domain/recreate.rs`). An unverified answer records nothing and is asked
//! about again at the next check. An answer that names nothing means the server lost the create, which is queued
//! with a body snapshot (the driver asks for it); a failed request queues none
//! of them until the next check. A row whose recorded delete clock its own
//! clock does not follow is not asked about (Electron's `isNoteKnownDeleted`,
//! `pending-deletes.ts:139-148`). Each is asked about once per check, so at
//! most once per 30 minutes, and a check asks about at most [`MAX_PROBED`]
//! rows: the next check starts after the last row asked and wraps around, so
//! rows that never resolve cannot hold the window. Electron re-uploads them without asking and has
//! that hole (`pull-coordinator.ts:312,816`, `:179-224`).
//!
//! **Not re-uploaded:** the other types the server re-creates over a purged
//! tombstone (`RECREATABLE_AFTER_PURGE_ITEM_TYPES`), `task_activity`, whose
//! retention this core does not track, and `settings`, the one clock-exempt
//! type (chapter 05 §5.4): the server's delete-wins check needs a clock to
//! refuse a `create` over a purged tombstone, so a `settings` create is
//! re-created over one just as the re-creatable types are. [`REUPLOADED`] is
//! Electron's `REUPLOADABLE_TYPES` (`:293-313`) without them.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value as Json, json};

use crate::api::errors::StorageError;
use crate::protocol::envelope::{self, RecordEnvelope, SyncOperation};
use crate::storage::nested_tx;
use crate::sync::clock::{self, ClockOrder, VectorClock};
use crate::sync::outbox::{self, Change};
use crate::sync::pull::{MAX_PULL_IDS, PullError, PullLoop};
use crate::sync::{refused_items, store};

use super::{purged, quarantine};

/// `MIN_INTERVAL_MS` (`manifest-check.ts:47`).
pub const MIN_INTERVAL_MS: i64 = 30 * 60 * 1000;

/// `MANIFEST_PAGE_LIMIT` (`manifest-check.ts:54`), the server's page cap.
const PAGE_LIMIT: u32 = 1000;

/// The types a local-only row of is queued as `create`, the [`PROBED`] ones
/// only after the server's answer names nothing.
pub const REUPLOADED: [&str; 14] = [
    "note",
    "journal",
    "bookmark",
    "task",
    "project",
    "inbox",
    "filter",
    "template",
    "home_page",
    "custom_icon",
    "vault_lock",
    "sticky_draft",
    "reminder",
    "canvas",
];

/// The [`REUPLOADED`] types the server re-creates over a purged tombstone:
/// asked about by id before one is queued (#4785).
pub const PROBED: [&str; 3] = ["note", "journal", "bookmark"];

/// The [`PROBED`] rows one check asks about: ten `POST /sync/pull` requests,
/// well under the server's 120 a minute.
pub const MAX_PROBED: usize = 10 * MAX_PULL_IDS;

/// A live, clocked, fully stored, readable row with nothing queued.
const UNSYNCED_LIVE: &str = "clock IS NOT NULL AND deleted_at IS NULL AND payload IS NOT NULL
            AND corrupt_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM outbox
                             WHERE outbox.item_type = sync_items.item_type
                               AND outbox.item_id = sync_items.item_id)";

/// What one check found.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ManifestOutcome {
    /// Pulled by id: live on the server, absent here.
    pub server_only: Vec<(String, String)>,
    /// Queued as `create`: live and clocked here, absent on the server.
    pub reuploaded: Vec<(String, String)>,
    /// Not queued: absent from the manifest, but the server answered a
    /// tombstone or a marker for the id.
    pub deleted_there: Vec<(String, String)>,
}

/// The check's 30-minute throttle, one per driver (Electron keeps
/// `lastCheckAt` in memory too, so the first pass after a start checks), and
/// the last [`PROBED`] row it asked about, where the next window starts.
#[derive(Debug, Default)]
pub struct ManifestCheck {
    last_at: Mutex<Option<i64>>,
    last_asked: Mutex<Option<(String, String)>>,
}

impl ManifestCheck {
    /// Runs the check through `pull` when 30 minutes passed since the last
    /// one; `None` when throttled. A failed check counts as a check
    /// (`skippedResult(now, 'error')`), so a server that keeps failing it is
    /// asked every 30 minutes, not every pass. A failed question about the
    /// [`PROBED`] rows queues none of them and does not fail the check.
    pub async fn run(
        &self,
        pull: &PullLoop,
        now_ms: i64,
    ) -> Result<Option<ManifestOutcome>, PullError> {
        {
            let mut last = self
                .last_at
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if last.is_some_and(|last| now_ms - last < MIN_INTERVAL_MS) {
                return Ok(None);
            }
            *last = Some(now_ms);
        }
        let server = fetch(pull).await?;
        let declared: Vec<String> = pull.declaration().types().to_vec();
        let after = self.last_asked().clone();
        let (mut outcome, asked) = pull
            .db()
            .call(move |conn| diff(conn, &server, &declared, after.as_ref(), now_ms))
            .await?;
        if let Some(last) = asked.last() {
            *self.last_asked() = Some(last.clone());
        }
        if !outcome.server_only.is_empty() {
            let ids: Vec<String> = outcome
                .server_only
                .iter()
                .map(|(_, id)| id.clone())
                .collect();
            pull.fetch_ids(&ids).await?;
        }
        if asked.is_empty() {
            return Ok(Some(outcome));
        }
        match ask(pull, &asked).await {
            Ok(answers) => {
                let (created, deleted) = pull
                    .db()
                    .call(move |conn| settle(conn, &asked, &answers, now_ms))
                    .await?;
                outcome.reuploaded.extend(created);
                outcome.deleted_there = deleted;
            }
            Err(error) => eprintln!(
                "memry-core: asking the server about {} record(s) its manifest lacks failed \
                 ({error}); none is re-uploaded until the next check",
                asked.len()
            ),
        }
        Ok(Some(outcome))
    }

    fn last_asked(&self) -> std::sync::MutexGuard<'_, Option<(String, String)>> {
        self.last_asked
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// `(type, id)` pairs.
type Keys = Vec<(String, String)>;

/// What `POST /sync/pull` said about one asked id.
#[derive(Debug)]
enum Answer {
    /// A tombstone or a marker of `item_type`, with its clock only when a
    /// device signed it (an attested marker, a verified tombstone).
    Deleted {
        item_type: String,
        clock: Option<VectorClock>,
    },
    /// A live row, a lost blob, or an entry this check cannot read.
    Held,
}

/// `POST /sync/pull` for `asked`, by id (§5.11.1). Nothing is applied: a
/// marker read here is never a delete of the local row (`fetch_ids` would
/// apply it). A body without `items` names every id it was asked about. A
/// marker keeps its clock only when [`purged::Entries::read`] admits it and
/// [`purged::attest`] attests it, the pull's own checks; a tombstone only when
/// its envelope verifies under its signer's key. A signer lookup that cannot
/// complete fails the question.
async fn ask(
    pull: &PullLoop,
    asked: &[(String, String)],
) -> Result<BTreeMap<String, Vec<Answer>>, PullError> {
    let ids: Vec<String> = asked.iter().map(|(_, id)| id.clone()).collect();
    let mut answers: BTreeMap<String, Vec<Answer>> = BTreeMap::new();
    for chunk in ids.chunks(MAX_PULL_IDS) {
        let request = pull
            .request("POST", "/sync/pull")
            .json(&json!({ "itemIds": chunk }));
        let body: Json = pull.http().send_json(request).await?;
        let Some(items) = body.get("items").and_then(Json::as_array) else {
            for id in chunk {
                answers.entry(id.clone()).or_default().push(Answer::Held);
            }
            continue;
        };
        let entries = |key: &str| body.get(key).and_then(Json::as_array).into_iter().flatten();
        let id_of = |entry: &Json| entry.get("id").and_then(Json::as_str).map(str::to_owned);
        let mut tombstones: Vec<RecordEnvelope> = Vec::new();
        for item in items {
            match envelope::from_json(item) {
                Ok(read)
                    if read.deleted_at.is_some() || read.operation == SyncOperation::Delete =>
                {
                    tombstones.push(read);
                }
                _ => {
                    if let Some(id) = id_of(item) {
                        answers.entry(id).or_default().push(Answer::Held);
                    }
                }
            }
        }
        let signers = tombstones
            .iter()
            .map(|read| read.signer_device_id.clone())
            .collect();
        let signed = purged::resolve_signers(signers, pull.signer_keys(), pull.http()).await?;
        for read in tombstones {
            let verified = signed
                .get(&read.signer_device_id)
                .and_then(Option::as_deref)
                .is_some_and(|key| envelope::verify(&read, key).is_ok());
            answers.entry(read.id).or_default().push(Answer::Deleted {
                item_type: read.item_type,
                clock: read.clock.filter(|_| verified),
            });
        }
        for marker in entries("purgedTombstones") {
            if let Some(id) = id_of(marker) {
                let item_type = marker
                    .get("type")
                    .and_then(Json::as_str)
                    .unwrap_or_default();
                answers.entry(id).or_default().push(Answer::Deleted {
                    item_type: item_type.to_owned(),
                    clock: None,
                });
            }
        }
        let mut markers = purged::Entries::default();
        markers.read(&body, chunk);
        let attested = purged::attest(
            markers.markers,
            pull.vault_id(),
            pull.signer_keys(),
            pull.http(),
            &mut markers.refused,
        )
        .await?;
        for marker in attested {
            answers
                .entry(marker.item_id)
                .or_default()
                .push(Answer::Deleted {
                    item_type: marker.item_type,
                    clock: Some(marker.clock),
                });
        }
        for lost in entries("blobMissing") {
            if let Some(id) = id_of(lost) {
                answers.entry(id).or_default().push(Answer::Held);
            }
        }
    }
    Ok(answers)
}

/// Queues the asked rows the answer named nothing of, if they are still
/// [`UNSYNCED_LIVE`], and records the clock of every delete it named in the
/// row's own spelling, for the [`PROBED`] types only: a recorded clock reads as
/// a deleted folder (`domain/folders.rs`), so a `folder_config` one never is.
/// Returns `(queued, deleted there)`.
fn settle(
    conn: &Connection,
    asked: &[(String, String)],
    answers: &BTreeMap<String, Vec<Answer>>,
    now_ms: i64,
) -> Result<(Keys, Keys), StorageError> {
    let (mut created, mut deleted) = (Vec::new(), Vec::new());
    let tx = nested_tx::begin(conn).map_err(failed)?;
    for (item_type, id) in asked {
        let Some(named) = answers.get(id) else {
            let unsynced: Option<i64> = tx
                .query_row(
                    &format!(
                        "SELECT 1 FROM sync_items
                          WHERE item_type = ?1 AND item_id = ?2 AND {UNSYNCED_LIVE}"
                    ),
                    params![item_type, id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(failed)?;
            if unsynced.is_some() {
                eprintln!(
                    "memry-core: a {item_type} the server holds nothing of is queued as create"
                );
                outbox::enqueue(&tx, &Change::create(item_type, id), now_ms)?;
                created.push((item_type.clone(), id.clone()));
            }
            continue;
        };
        let mut was_deleted = false;
        for answer in named {
            let Answer::Deleted {
                item_type: there,
                clock,
            } = answer
            else {
                continue;
            };
            if !spellings(there, id).contains(&(item_type.clone(), id.clone())) {
                continue;
            }
            was_deleted = true;
            if let Some(clock) = clock
                .as_ref()
                .filter(|_| PROBED.contains(&item_type.as_str()))
            {
                store::record_tombstone_clock(&tx, item_type, id, clock, now_ms)?;
            }
        }
        if was_deleted {
            eprintln!("memry-core: a {item_type} the server holds deleted is not re-uploaded");
            deleted.push((item_type.clone(), id.clone()));
        }
    }
    tx.commit().map_err(failed)?;
    Ok((created, deleted))
}

/// This device recorded a delete of the row that its clock does not follow
/// (`isNoteKnownDeleted`): the row is a leftover, not a re-create.
fn known_deleted(conn: &Connection, item_type: &str, id: &str) -> Result<bool, StorageError> {
    let mut recorded: Option<VectorClock> = None;
    for (spelled, id) in spellings(item_type, id) {
        if let Some(clock) = store::tombstone_clock(conn, &spelled, &id)? {
            recorded = Some(match recorded {
                Some(seen) => clock::merge(&seen, &clock),
                None => clock,
            });
        }
    }
    let Some(recorded) = recorded else {
        return Ok(false);
    };
    let own: Option<String> = conn
        .query_row(
            "SELECT clock FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
            params![item_type, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?
        .flatten();
    let own: Option<VectorClock> = own.and_then(|text| serde_json::from_str(&text).ok());
    Ok(own.is_none_or(|own| clock::compare(&own, &recorded) != ClockOrder::After))
}

/// Every page of `GET /sync/manifest`, deduplicated on `(type, id)`. A
/// `nextCursor` that does not advance ends the listing (`:127-134`).
async fn fetch(pull: &PullLoop) -> Result<BTreeSet<(String, String)>, PullError> {
    let mut server = BTreeSet::new();
    let mut cursor: i64 = 0;
    loop {
        let path = format!("/sync/manifest?limit={PAGE_LIMIT}&cursor={cursor}");
        let body: Json = pull.http().send_json(pull.request("GET", &path)).await?;
        for item in body
            .get("items")
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
        {
            if let (Some(item_type), Some(id)) = (
                item.get("type").and_then(Json::as_str),
                item.get("id").and_then(Json::as_str),
            ) {
                server.insert((item_type.to_owned(), id.to_owned()));
            }
        }
        match body.get("nextCursor").and_then(Json::as_i64) {
            Some(next) if next > cursor => cursor = next,
            Some(next) => {
                eprintln!(
                    "memry-core: the manifest cursor did not advance ({cursor} to {next}); \
                     diffing the pages read so far"
                );
                break;
            }
            None => break,
        }
    }
    Ok(server)
}

/// A note and a journal of one id are one item (`tombstoneRefKeys`).
fn spellings(item_type: &str, id: &str) -> Vec<(String, String)> {
    match item_type {
        "note" | "journal" => vec![
            ("note".to_owned(), id.to_owned()),
            ("journal".to_owned(), id.to_owned()),
        ],
        _ => vec![(item_type.to_owned(), id.to_owned())],
    }
}

/// The two directions, the re-uploads queued in one transaction, and the
/// [`PROBED`] rows to ask the server about: at most [`MAX_PROBED`], in
/// `(type, id)` order from the first one after `after`, wrapping around.
fn diff(
    conn: &Connection,
    server: &BTreeSet<(String, String)>,
    declared: &[String],
    after: Option<&(String, String)>,
    now_ms: i64,
) -> Result<(ManifestOutcome, Keys), StorageError> {
    let held: BTreeSet<(String, String)> = keys(conn, "SELECT item_type, item_id FROM sync_items")?
        .iter()
        .flat_map(|(item_type, id)| spellings(item_type, id))
        .collect();
    let mut blocked: Vec<(String, String)> = refused_items::entries(conn)?
        .into_iter()
        .map(|item| (item.item_type, item.item_id))
        .collect();
    blocked.extend(quarantine::blocked(conn, now_ms)?);
    let excluded: BTreeSet<(String, String)> = blocked
        .iter()
        .flat_map(|(item_type, id)| spellings(item_type, id))
        .collect();
    let server_only: Vec<(String, String)> = server
        .iter()
        .filter(|(item_type, _)| item_type != "task_activity" && declared.contains(item_type))
        .filter(|key| !held.contains(*key) && !excluded.contains(*key))
        .cloned()
        .collect();

    let server_spellings: BTreeSet<(String, String)> = server
        .iter()
        .flat_map(|(item_type, id)| spellings(item_type, id))
        .collect();
    let local = keys(
        conn,
        &format!(
            "SELECT item_type, item_id FROM sync_items WHERE {UNSYNCED_LIVE}
              ORDER BY item_type, item_id"
        ),
    )?;
    let (asked, reuploaded): (Keys, Keys) = local
        .into_iter()
        .filter(|(item_type, _)| {
            REUPLOADED.contains(&item_type.as_str()) && declared.contains(item_type)
        })
        .filter(|key| !server_spellings.contains(key))
        .partition(|(item_type, _)| PROBED.contains(&item_type.as_str()));
    let mut unknown = Vec::with_capacity(asked.len().min(MAX_PROBED));
    for (item_type, id) in asked {
        if !known_deleted(conn, &item_type, &id)? {
            unknown.push((item_type, id));
        }
    }
    if unknown.len() > MAX_PROBED {
        let start = after
            .and_then(|after| unknown.iter().position(|key| key > after))
            .unwrap_or(0);
        unknown.rotate_left(start);
        eprintln!(
            "memry-core: {} record(s) the manifest lacks wait for the next check",
            unknown.len() - MAX_PROBED
        );
        unknown.truncate(MAX_PROBED);
    }
    if !reuploaded.is_empty() {
        let tx = nested_tx::begin(conn).map_err(failed)?;
        for (item_type, id) in &reuploaded {
            eprintln!(
                "memry-core: a {item_type} missing from the server manifest is queued as create"
            );
            outbox::enqueue(&tx, &Change::create(item_type, id), now_ms)?;
        }
        tx.commit().map_err(failed)?;
    }
    if !server_only.is_empty() {
        eprintln!(
            "memry-core: the server holds {} record(s) not found here; pulling them by id",
            server_only.len()
        );
    }
    Ok((
        ManifestOutcome {
            server_only,
            reuploaded,
            deleted_there: Vec::new(),
        },
        unknown,
    ))
}

fn keys(conn: &Connection, sql: &str) -> Result<Vec<(String, String)>, StorageError> {
    let mut statement = conn.prepare(sql).map_err(failed)?;
    statement
        .query_map(params![], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
