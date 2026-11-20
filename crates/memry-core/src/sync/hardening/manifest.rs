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
//! **Not re-uploaded: the types the server re-creates over a purged
//! tombstone** (`RECREATABLE_AFTER_PURGE_ITEM_TYPES`, §5.12.3), notes,
//! journals and bookmarks among them. The server accepts their `create` over
//! a marker, and a marker the pull skipped (a run from cursor 0) or refused
//! (unattested, an unknown signer, a quarantine) leaves no trace here, so a
//! row still live here can be one another device deleted: its re-upload would
//! bring the item back on every device (#4785). Electron re-uploads them and
//! has that hole (`pull-coordinator.ts:312,816`, `:179-224`). [`REUPLOADED`]
//! is Electron's `REUPLOADABLE_TYPES` (`:293-313`) without them, without
//! `task_activity`, whose retention this core does not track, and without
//! `settings`, the one clock-exempt type (chapter 05 §5.4): the server's
//! delete-wins check needs a clock to refuse a `create` over a purged
//! tombstone, so a `settings` create is re-created over one just as the
//! re-creatable types are.

use std::collections::BTreeSet;
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde_json::Value as Json;

use crate::api::errors::StorageError;
use crate::storage::nested_tx;
use crate::sync::outbox::{self, Change};
use crate::sync::pull::{PullError, PullLoop};
use crate::sync::refused_items;

use super::quarantine;

/// `MIN_INTERVAL_MS` (`manifest-check.ts:47`).
pub const MIN_INTERVAL_MS: i64 = 30 * 60 * 1000;

/// `MANIFEST_PAGE_LIMIT` (`manifest-check.ts:54`), the server's page cap.
const PAGE_LIMIT: u32 = 1000;

/// The types a local-only row of is queued as `create`.
pub const REUPLOADED: [&str; 11] = [
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

/// What one check found.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ManifestOutcome {
    /// Pulled by id: live on the server, absent here.
    pub server_only: Vec<(String, String)>,
    /// Queued as `create`: live and clocked here, absent on the server.
    pub reuploaded: Vec<(String, String)>,
}

/// The check's 30-minute throttle, one per driver (Electron keeps
/// `lastCheckAt` in memory too, so the first pass after a start checks).
#[derive(Debug, Default)]
pub struct ManifestCheck {
    last_at: Mutex<Option<i64>>,
}

impl ManifestCheck {
    /// Runs the check through `pull` when 30 minutes passed since the last
    /// one; `None` when throttled. A failed check counts as a check
    /// (`skippedResult(now, 'error')`), so a server that keeps failing it is
    /// asked every 30 minutes, not every pass.
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
        let outcome = pull
            .db()
            .call(move |conn| diff(conn, &server, &declared, now_ms))
            .await?;
        if !outcome.server_only.is_empty() {
            let ids: Vec<String> = outcome
                .server_only
                .iter()
                .map(|(_, id)| id.clone())
                .collect();
            pull.fetch_ids(&ids).await?;
        }
        Ok(Some(outcome))
    }
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

/// The two directions, the re-uploads queued in one transaction.
pub(crate) fn diff(
    conn: &Connection,
    server: &BTreeSet<(String, String)>,
    declared: &[String],
    now_ms: i64,
) -> Result<ManifestOutcome, StorageError> {
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
        "SELECT item_type, item_id FROM sync_items
          WHERE clock IS NOT NULL AND deleted_at IS NULL AND payload IS NOT NULL
            AND corrupt_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM outbox
                             WHERE outbox.item_type = sync_items.item_type
                               AND outbox.item_id = sync_items.item_id)",
    )?;
    let reuploaded: Vec<(String, String)> = local
        .into_iter()
        .filter(|(item_type, _)| {
            REUPLOADED.contains(&item_type.as_str()) && declared.contains(item_type)
        })
        .filter(|key| !server_spellings.contains(key))
        .collect();
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
    Ok(ManifestOutcome {
        server_only,
        reuploaded,
    })
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
