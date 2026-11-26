//! Where the manifest check starts listing (#5861).
//!
//! `GET /sync/manifest?limit=&cursor=C` lists the live rows whose
//! `server_cursor` is above `C`, and a server cursor only grows
//! (`apps/sync-server/src/services/sync.ts` `getManifest`). After a complete
//! check the core stores the highest cursor it listed. The next check lists
//! only the rows above it: every live row at or below it was listed then and
//! is held here or was pulled, and every write since carries a higher cursor.
//! That listing proves the server-only direction alone. The local-only
//! direction (a row here the server lost) needs every row, so a check from a
//! watermark skips it. That holds only while no row has left the outbox or
//! `sync_items` since, so data migration 0040's triggers delete the watermark
//! in the transaction of every such delete.
//!
//! The check lists every row instead when the watermark is missing or
//! unreadable, of another format version, vault or feed declaration, or
//! written [`FULL_INTERVAL_MS`] or more ago or in the future. The interval also
//! bounds how long a server that lost rows without its cursor showing it goes
//! unnoticed. A listing from the watermark that names a row at or below it, a
//! row without its cursor, or a cursor that does not advance is not trusted,
//! and the same check lists every row.
//!
//! Durable across a crash: a check first replaces the watermark with a token
//! of its own, and writes the next watermark only after every row it pulled
//! and every create it queued committed, and only while the token is still
//! there (a trigger deleted nothing in between). A crash or an error leaves
//! the token, which reads as no watermark.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::api::errors::StorageError;
use crate::sync::first_sync_store::{read_meta, write_meta};
use crate::sync::pull::{PullError, PullLoop};

/// `MANIFEST_PAGE_LIMIT` (`manifest-check.ts:54`), the server's page cap.
const PAGE_LIMIT: u32 = 1000;

/// The `meta` key. Data migration 0040's triggers name it.
pub const META_MANIFEST_WATERMARK: &str = "sync.manifest_watermark";

/// The format this build writes and the only one it reads.
pub const FORMAT_VERSION: u32 = 1;

/// A check lists every row at least this often.
pub const FULL_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

/// The stored watermark.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watermark {
    /// [`FORMAT_VERSION`].
    pub v: u32,
    /// The vault the listing was of.
    pub vault: Option<String>,
    /// The feed declaration it was listed under: the server lists the
    /// declared types only.
    pub types: String,
    /// The highest `serverCursor` listed.
    pub cursor: i64,
    /// When the last check that listed every row ran.
    pub full_at: i64,
}

/// A check's hold on the watermark.
pub(super) struct Claim {
    pub token: String,
    /// The stored watermark when it is trusted; `None` lists every row.
    pub from: Option<Watermark>,
}

static NEXT_TOKEN: AtomicU64 = AtomicU64::new(0);

/// Reads the stored watermark and replaces it with this check's token.
pub(super) fn claim(
    conn: &Connection,
    vault: Option<&str>,
    types: &str,
    now_ms: i64,
) -> Result<Claim, StorageError> {
    let from = read_meta(conn, META_MANIFEST_WATERMARK)?
        .and_then(|raw| serde_json::from_str::<Watermark>(&raw).ok())
        .filter(|stored| {
            stored.v == FORMAT_VERSION
                && stored.vault.as_deref() == vault
                && stored.types == types
                && stored.cursor >= 0
                && stored.full_at <= now_ms
                && now_ms - stored.full_at < FULL_INTERVAL_MS
        });
    let token = format!(
        "pending:{now_ms}:{}",
        NEXT_TOKEN.fetch_add(1, Ordering::Relaxed)
    );
    write_meta(conn, META_MANIFEST_WATERMARK, &token)?;
    Ok(Claim { token, from })
}

/// Writes `next` if the key still holds `token`; `false` when a trigger
/// deleted it since.
pub(super) fn settle(
    conn: &Connection,
    token: &str,
    next: &Watermark,
) -> Result<bool, StorageError> {
    let value = serde_json::to_string(next).map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })?;
    let written = conn
        .execute(
            "UPDATE meta SET value = ?1 WHERE key = ?2 AND value = ?3",
            params![value, META_MANIFEST_WATERMARK, token],
        )
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?;
    Ok(written == 1)
}

/// What `GET /sync/manifest` listed above a cursor.
pub(super) struct Listing {
    pub keys: BTreeSet<(String, String)>,
    /// The highest `serverCursor` listed, the start cursor when none was.
    /// `None` when a row came without one or at or below the start, or a
    /// cursor stalled: such a listing founds no watermark.
    pub top: Option<i64>,
}

/// Every page of `GET /sync/manifest` above `after`, deduplicated on `(type,
/// id)`. A `nextCursor` that does not advance ends the listing (`manifest-check.ts:127-134`).
pub(super) async fn list(pull: &PullLoop, after: i64) -> Result<Listing, PullError> {
    let mut server = BTreeSet::new();
    let mut top = Some(after);
    let mut cursor = after;
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
            top = match item.get("serverCursor").and_then(Json::as_i64) {
                Some(listed) if listed > after => top.map(|top| top.max(listed)),
                _ => None,
            };
        }
        match body.get("nextCursor").and_then(Json::as_i64) {
            Some(next) if next > cursor => cursor = next,
            Some(next) => {
                eprintln!(
                    "memry-core: the manifest cursor did not advance ({cursor} to {next}); \
                     diffing the pages read so far"
                );
                top = None;
                break;
            }
            None => break,
        }
    }
    Ok(Listing { keys: server, top })
}
