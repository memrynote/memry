//! Fresh-device pack bootstrap, chapter 08, ported from desktop's
//! `apps/desktop/src/main/sync/packs/pack-bootstrap.ts`.
//!
//! A cold vault spends a `GET /sync/crdt/snapshot/:noteId` per note to take
//! each body's baseline. One `crdt_snapshot` pack carries hundreds of those
//! baselines, so walking `GET /sync/packs` first lets the bodies pass find
//! the packed notes already seeded. It also reaches notes outside the recent
//! window, which the windowed first sync leaves for on-demand loading.
//!
//! **Record packs are never applied.** A record pack entry is the bare R2
//! blob; the signature, signer and vector clock live in D1 rows and travel
//! only on `POST /sync/pull`. Only `crdt_snapshot` entries carry their own
//! Ed25519 signature inside the envelope, so only they are trusted here.
//!
//! **Every failure is a fallback** (§8.0: a pack is a derived cache). An old
//! server's 404, no presigned URL, an expired URL, a bad digest or an
//! unverifiable entry leaves the affected notes to the item-granular bodies
//! pass. Nothing here fails the first sync.
//!
//! Packs transfer one at a time, newest first, held in memory: a pack is
//! capped near 24 MiB by the writer, and one at a time keeps a phone's peak
//! memory to one pack.

use std::collections::HashSet;
use std::sync::Arc;

use rusqlite::params;
use serde_json::Value as Json;

use crate::api::errors::StorageError;
use crate::protocol::http::{ApiRequest, Auth, HttpClient, RetryPolicy, VAULT_ID_HEADER};
use crate::protocol::pack::{PackKind, extract_entry, parse_pack};
use crate::storage::Db;

use super::body_pull::{BodyPull, BodyPullError, PackSeed};
use super::first_sync_store::{read_meta, write_meta};

/// The resume watermark: the highest pack `maxCursor` covered by an unbroken
/// run of fully applied packs. Packs at or below it are not re-read.
pub const META_PACKS_APPLIED_THROUGH: &str = "pack_bootstrap.applied_through_cursor";

/// Packs per `GET /sync/packs` page (the server caps at 50).
pub const PACK_LIST_PAGE_LIMIT: u32 = 50;

/// Ceiling on pages walked, so a pathological listing cannot loop forever.
const MAX_PACK_LIST_PAGES: usize = 20;

/// Clock-skew margin subtracted from a presigned URL's expiry.
const PRESIGN_EXPIRY_SAFETY_SECONDS: i64 = 30;

/// One usable `crdt_snapshot` pack from the listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackSummary {
    pub id: String,
    pub max_cursor: i64,
    pub url: String,
    pub expires_at: i64,
}

impl PackSummary {
    fn live(&self, now_s: i64) -> bool {
        self.expires_at - PRESIGN_EXPIRY_SAFETY_SECONDS > now_s
    }
}

/// What the pack bootstrap did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PackBootstrapReport {
    pub packs_applied: usize,
    pub entries_applied: usize,
    pub entries_skipped: usize,
    pub entries_failed: usize,
    /// The watermark this run recorded, when it advanced.
    pub applied_through_cursor: Option<i64>,
    /// Why some or all packs fell back to the item-granular path.
    pub fallback_reasons: Vec<String>,
}

struct Listing {
    packs: Vec<PackSummary>,
    /// The walk hit [`MAX_PACK_LIST_PAGES`] with older packs still unlisted,
    /// so contiguity from the oldest listed pack would claim a range nothing
    /// walked.
    truncated: bool,
}

pub struct PackBootstrap {
    http: Arc<HttpClient>,
    db: Db,
    bodies: Arc<BodyPull>,
    vault_id: Option<String>,
}

impl PackBootstrap {
    pub fn new(http: Arc<HttpClient>, db: Db, bodies: Arc<BodyPull>) -> Self {
        Self {
            http,
            db,
            bodies,
            vault_id: None,
        }
    }

    pub fn with_vault(mut self, vault_id: &str) -> Self {
        self.vault_id = Some(vault_id.to_owned());
        self
    }

    /// Lists, downloads, verifies and seeds. Errors only on local storage
    /// failure; every network or pack failure is a fallback in the report.
    pub async fn run(&self, now_s: i64) -> Result<PackBootstrapReport, StorageError> {
        let mut report = PackBootstrapReport::default();
        let listing = match self.list(now_s).await {
            Ok(listing) => listing,
            Err(reason) => {
                report.fallback_reasons.push(reason);
                return Ok(report);
            }
        };
        let covered = self
            .db
            .call(|conn| read_meta(conn, META_PACKS_APPLIED_THROUGH))
            .await?
            .and_then(|text| text.parse::<i64>().ok())
            .unwrap_or(0);
        let mut packs: Vec<PackSummary> = listing
            .packs
            .into_iter()
            .filter(|pack| pack.max_cursor > covered)
            .collect();
        packs.sort_by_key(|pack| std::cmp::Reverse(pack.max_cursor));

        let mut completed = HashSet::new();
        let mut relisted: Option<Vec<PackSummary>> = None;
        for pack in &packs {
            let url = if pack.live(now()) {
                pack.url.clone()
            } else {
                // The listing's URLs are signed once with a TTL in minutes; a
                // large vault outlives it. One re-list mints fresh ones.
                if relisted.is_none() {
                    relisted = Some(self.list(now()).await.map(|l| l.packs).unwrap_or_default());
                }
                match relisted
                    .iter()
                    .flatten()
                    .find(|fresh| fresh.id == pack.id && fresh.live(now()))
                {
                    Some(fresh) => fresh.url.clone(),
                    None => {
                        report
                            .fallback_reasons
                            .push(format!("pack {} expired and was not re-signed", pack.id));
                        continue;
                    }
                }
            };
            match self.apply_pack(&url, &mut report).await? {
                Ok(()) => {
                    completed.insert(pack.id.clone());
                    report.packs_applied += 1;
                }
                Err(reason) => report
                    .fallback_reasons
                    .push(format!("pack {}: {reason}", pack.id)),
            }
        }

        let watermark = if listing.truncated {
            None
        } else {
            contiguous_applied_cursor(&packs, &completed)
        };
        if let Some(watermark) = watermark.filter(|w| *w > covered) {
            self.db
                .call(move |conn| {
                    write_meta(conn, META_PACKS_APPLIED_THROUGH, &watermark.to_string())
                })
                .await?;
            report.applied_through_cursor = Some(watermark);
        }
        Ok(report)
    }

    /// Downloads one pack and seeds every fresh, verifiable snapshot in it.
    /// The outer `Err` is local storage; the inner one is a pack-level
    /// fallback (transfer or digest failure).
    async fn apply_pack(
        &self,
        url: &str,
        report: &mut PackBootstrapReport,
    ) -> Result<Result<(), String>, StorageError> {
        let request = ApiRequest::new("GET", url)
            .auth(Auth::None)
            .retry(RetryPolicy::polled());
        let bytes = match self.http.send(request).await {
            Ok(response) => response.body,
            Err(error) => return Ok(Err(error.to_string())),
        };
        let pack = match parse_pack(&bytes) {
            Ok(pack) => pack,
            Err(error) => return Ok(Err(error.to_string())),
        };

        for entry in &pack.entries {
            let meta = (entry.kind == PackKind::CrdtSnapshot)
                .then(|| snapshot_meta(entry.meta.as_ref()))
                .flatten();
            let Some((sequence_num, revision)) = meta else {
                report.entries_skipped += 1;
                continue;
            };
            if self.tombstoned(&entry.id).await? {
                // §7.15: a deleted document's body is never resurrected.
                report.entries_skipped += 1;
                continue;
            }
            let Ok(packed) = extract_entry(&bytes, entry) else {
                report.entries_failed += 1;
                continue;
            };
            let seeded = match self
                .bodies
                .seed_from_pack(&entry.id, packed, sequence_num, &revision)
                .await
            {
                Ok(seed) => seed,
                Err(BodyPullError::Storage { source }) => return Err(source),
                // `seed_from_pack` sends no request; nothing else reaches here.
                Err(error) => return Ok(Err(error.to_string())),
            };
            match seeded {
                PackSeed::Applied => report.entries_applied += 1,
                PackSeed::Stale => report.entries_skipped += 1,
                PackSeed::Unverified => report.entries_failed += 1,
            }
        }
        Ok(Ok(()))
    }

    async fn tombstoned(&self, doc_id: &str) -> Result<bool, StorageError> {
        let id = doc_id.to_owned();
        self.db
            .call(move |conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sync_items
                     WHERE item_id = ?1 AND deleted_at IS NOT NULL)",
                    params![id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
            })
            .await
    }

    /// Walks `GET /sync/packs` newest first. `Err` means "no packs here":
    /// an old server's 404, any non-2xx, or a body that does not parse.
    async fn list(&self, now_s: i64) -> Result<Listing, String> {
        let mut packs = Vec::new();
        let mut cursor: Option<String> = None;
        let mut truncated = false;
        for page in 0..MAX_PACK_LIST_PAGES {
            let mut path = format!("/sync/packs?limit={PACK_LIST_PAGE_LIMIT}");
            if let Some(cursor) = &cursor {
                path.push_str("&cursor=");
                path.push_str(&query_encode(cursor));
            }
            let mut request = ApiRequest::new("GET", &path)
                .auth(Auth::Session)
                .retry(RetryPolicy::polled());
            if let Some(vault_id) = &self.vault_id {
                request = request.header(VAULT_ID_HEADER, vault_id);
            }
            let body: Json = self
                .http
                .send_json(request)
                .await
                .map_err(|error| error.to_string())?;
            let listed = body
                .get("packs")
                .and_then(Json::as_array)
                .ok_or("the pack list carried no `packs` array")?;
            packs.extend(listed.iter().filter_map(|pack| usable_pack(pack, now_s)));
            cursor = body
                .get("nextCursor")
                .and_then(Json::as_str)
                .filter(|next| !next.is_empty())
                .map(str::to_owned);
            if cursor.is_none() {
                break;
            }
            truncated = page == MAX_PACK_LIST_PAGES - 1;
        }
        Ok(Listing { packs, truncated })
    }
}

/// A listed pack this client can use: a `crdt_snapshot` with a presigned URL
/// that is still live.
fn usable_pack(pack: &Json, now_s: i64) -> Option<PackSummary> {
    if pack.get("itemKind").and_then(Json::as_str) != Some(PackKind::CrdtSnapshot.as_str()) {
        return None;
    }
    let summary = PackSummary {
        id: pack.get("id").and_then(Json::as_str)?.to_owned(),
        max_cursor: pack.get("maxCursor").and_then(Json::as_i64)?,
        url: pack.get("url").and_then(Json::as_str)?.to_owned(),
        expires_at: pack.get("expiresAt").and_then(Json::as_i64)?,
    };
    summary.live(now_s).then_some(summary)
}

/// `{sequenceNum, revision}`, both present, or the entry is not trusted.
fn snapshot_meta(meta: Option<&Json>) -> Option<(i64, String)> {
    let meta = meta?;
    let sequence_num = meta.get("sequenceNum").and_then(Json::as_i64)?;
    let revision = meta.get("revision").and_then(Json::as_str)?;
    (!revision.is_empty()).then(|| (sequence_num, revision.to_owned()))
}

/// The highest `maxCursor` covered by an unbroken run of completed packs,
/// counted from the **oldest** pack up.
///
/// Packs transfer newest first, so an interrupted run completes a suffix, and
/// recording the highest completed pack would claim ranges never applied.
/// Ties advance as a group: two packs can share a `maxCursor` (a same-second
/// group split across packs), and the resume filter is `maxCursor >
/// watermark`, so recording a tie while one of its packs is unfinished would
/// exclude that pack from every later run.
pub fn contiguous_applied_cursor(
    packs: &[PackSummary],
    completed: &HashSet<String>,
) -> Option<i64> {
    let mut ascending: Vec<&PackSummary> = packs.iter().collect();
    ascending.sort_by_key(|pack| pack.max_cursor);
    let mut watermark = None;
    for group in ascending.chunk_by(|a, b| a.max_cursor == b.max_cursor) {
        if !group.iter().all(|pack| completed.contains(&pack.id)) {
            break;
        }
        watermark = Some(group[0].max_cursor);
    }
    watermark
}

/// The keyset cursor is opaque (`maxCursor` + separator + id), so every byte
/// outside RFC 3986's unreserved set is escaped.
fn query_encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(id: &str, max_cursor: i64) -> PackSummary {
        PackSummary {
            id: id.to_owned(),
            max_cursor,
            url: String::new(),
            expires_at: 0,
        }
    }

    fn done(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn the_watermark_advances_only_across_an_unbroken_run_from_the_oldest() {
        let packs = [pack("a", 10), pack("b", 20), pack("c", 30)];
        // Newest first: an interrupted run completes the newest pack only.
        assert_eq!(contiguous_applied_cursor(&packs, &done(&["c"])), None);
        assert_eq!(
            contiguous_applied_cursor(&packs, &done(&["a", "c"])),
            Some(10)
        );
        assert_eq!(
            contiguous_applied_cursor(&packs, &done(&["a", "b", "c"])),
            Some(30)
        );
    }

    #[test]
    fn a_tie_group_advances_only_when_every_pack_in_it_completed() {
        let packs = [pack("a", 10), pack("b1", 20), pack("b2", 20)];
        assert_eq!(
            contiguous_applied_cursor(&packs, &done(&["a", "b1"])),
            Some(10)
        );
        assert_eq!(
            contiguous_applied_cursor(&packs, &done(&["a", "b1", "b2"])),
            Some(20)
        );
    }

    #[test]
    fn only_a_live_presigned_crdt_snapshot_pack_is_usable() {
        let listed = |kind: &str, expires: i64| {
            serde_json::json!({"id": "p", "itemKind": kind, "maxCursor": 5,
                "url": "https://r2.example/p", "expiresAt": expires})
        };
        assert!(usable_pack(&listed("crdt_snapshot", 1_000), 900).is_some());
        assert!(usable_pack(&listed("record", 1_000), 900).is_none());
        assert!(usable_pack(&listed("crdt_snapshot", 1_000), 980).is_none());
        assert!(
            usable_pack(
                &serde_json::json!({"id": "p", "itemKind": "crdt_snapshot",
            "maxCursor": 5, "expiresAt": 1_000}),
                900
            )
            .is_none()
        );
    }

    #[test]
    fn a_snapshot_without_both_freshness_fields_is_not_trusted() {
        let meta = serde_json::json!({"sequenceNum": 4, "revision": "r"});
        assert_eq!(snapshot_meta(Some(&meta)), Some((4, "r".to_owned())));
        assert_eq!(
            snapshot_meta(Some(&serde_json::json!({"sequenceNum": 4}))),
            None
        );
        assert_eq!(
            snapshot_meta(Some(&serde_json::json!({"sequenceNum": 4, "revision": ""}))),
            None
        );
        assert_eq!(snapshot_meta(None), None);
    }
}
