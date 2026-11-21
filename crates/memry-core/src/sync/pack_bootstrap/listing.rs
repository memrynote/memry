//! `GET /sync/packs` (chapter 08 §8.9): the listed packs of every kind and the
//! first page's `coverage` statement (§8.10).

use std::collections::HashMap;

use serde_json::Value as Json;

use crate::protocol::http::{ApiRequest, Auth, HttpClient, RetryPolicy, VAULT_ID_HEADER};
use crate::protocol::pack::PackKind;

/// Packs per `GET /sync/packs` page (the server caps at 50).
pub const PACK_LIST_PAGE_LIMIT: u32 = 50;

/// Ceiling on pages walked, so a pathological listing cannot loop forever.
/// §8.14 keeps a vault under 1,000 listed packs, which is 20 pages.
const MAX_PACK_LIST_PAGES: usize = 20;

/// Clock-skew margin subtracted from a presigned URL's expiry.
const PRESIGN_EXPIRY_SAFETY_SECONDS: i64 = 30;

/// One listed pack with a live presigned URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackSummary {
    pub id: String,
    pub kind: PackKind,
    pub max_cursor: i64,
    pub item_count: u64,
    pub url: String,
    pub expires_at: i64,
    /// `(coverFrom, coverThrough]` on the `server_cursor` axis (§8.10).
    /// `None` on a pack written before §8.10, which is a cache only.
    pub cover: Option<(i64, i64)>,
}

impl PackSummary {
    pub fn live(&self, now_s: i64) -> bool {
        self.expires_at - PRESIGN_EXPIRY_SAFETY_SECONDS > now_s
    }
}

/// One kind's `coverage` entry (§8.10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Coverage {
    pub packed_through: i64,
    pub covered_through: i64,
}

#[derive(Debug, Default)]
pub struct Listing {
    pub packs: Vec<PackSummary>,
    pub coverage: HashMap<&'static str, Coverage>,
    /// The walk hit [`MAX_PACK_LIST_PAGES`] with older packs still unlisted,
    /// so contiguity from the oldest listed pack would claim a range nothing
    /// walked.
    pub truncated: bool,
    /// Pages requested.
    pub pages: usize,
}

/// Walks `GET /sync/packs` newest first. `Err` means "no packs here": an old
/// server's 404, any non-2xx, or a body that does not parse.
pub async fn list(
    http: &HttpClient,
    vault_id: Option<&str>,
    now_s: i64,
) -> Result<Listing, String> {
    let mut listing = Listing::default();
    let mut cursor: Option<String> = None;
    for page in 0..MAX_PACK_LIST_PAGES {
        let mut path = format!("/sync/packs?limit={PACK_LIST_PAGE_LIMIT}");
        if let Some(cursor) = &cursor {
            path.push_str("&cursor=");
            path.push_str(&query_encode(cursor));
        }
        let mut request = ApiRequest::new("GET", &path)
            .auth(Auth::Session)
            .retry(RetryPolicy::polled());
        if let Some(vault_id) = vault_id {
            request = request.header(VAULT_ID_HEADER, vault_id);
        }
        listing.pages += 1;
        let body: Json = http
            .send_json(request)
            .await
            .map_err(|error| error.to_string())?;
        let listed = body
            .get("packs")
            .and_then(Json::as_array)
            .ok_or("the pack list carried no `packs` array")?;
        listing
            .packs
            .extend(listed.iter().filter_map(|pack| listed_pack(pack, now_s)));
        if page == 0 {
            listing.coverage = read_coverage(&body);
        }
        cursor = body
            .get("nextCursor")
            .and_then(Json::as_str)
            .filter(|next| !next.is_empty())
            .map(str::to_owned);
        if cursor.is_none() {
            break;
        }
        listing.truncated = page == MAX_PACK_LIST_PAGES - 1;
    }
    Ok(listing)
}

/// A listed pack of a kind this reader knows, with a presigned URL that is
/// still live.
pub fn listed_pack(pack: &Json, now_s: i64) -> Option<PackSummary> {
    let kind = match pack.get("itemKind").and_then(Json::as_str)? {
        "record" => PackKind::Record,
        "crdt_snapshot" => PackKind::CrdtSnapshot,
        "crdt_update" => PackKind::CrdtUpdate,
        _ => return None,
    };
    let cover_from = pack.get("coverFrom").and_then(Json::as_i64);
    let cover_through = pack.get("coverThrough").and_then(Json::as_i64);
    let summary = PackSummary {
        id: pack.get("id").and_then(Json::as_str)?.to_owned(),
        kind,
        max_cursor: pack.get("maxCursor").and_then(Json::as_i64)?,
        item_count: pack.get("itemCount").and_then(Json::as_u64).unwrap_or(0),
        url: pack.get("url").and_then(Json::as_str)?.to_owned(),
        expires_at: pack.get("expiresAt").and_then(Json::as_i64)?,
        cover: cover_from.zip(cover_through),
    };
    summary.live(now_s).then_some(summary)
}

/// `coverage`, entry by entry: one this reader cannot parse leaves that kind
/// uncovered (§8.9).
fn read_coverage(body: &Json) -> HashMap<&'static str, Coverage> {
    let mut coverage = HashMap::new();
    for entry in body
        .get("coverage")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
    {
        let kind = match entry.get("itemKind").and_then(Json::as_str) {
            Some("record") => PackKind::Record,
            Some("crdt_snapshot") => PackKind::CrdtSnapshot,
            Some("crdt_update") => PackKind::CrdtUpdate,
            _ => continue,
        };
        let (Some(packed_through), Some(covered_through)) = (
            entry.get("packedThrough").and_then(Json::as_i64),
            entry.get("coveredThrough").and_then(Json::as_i64),
        ) else {
            continue;
        };
        coverage.insert(
            kind.as_str(),
            Coverage {
                packed_through,
                covered_through,
            },
        );
    }
    coverage
}

/// §8.10's `T_kind` for one kind: walk the usable ranges from 0 in ascending
/// `coverFrom`, then trust `coveredThrough` only when the walk reaches
/// `packedThrough`. No coverage statement gives 0.
pub fn tail_start(ranges: &[(i64, i64)], coverage: Option<Coverage>) -> i64 {
    let Some(coverage) = coverage else {
        return 0;
    };
    let mut sorted = ranges.to_vec();
    sorted.sort_unstable();
    let mut end = 0;
    for (from, through) in sorted {
        if from <= end {
            end = end.max(through);
        }
    }
    if end >= coverage.packed_through {
        end.max(coverage.covered_through)
    } else {
        end
    }
}

/// The keyset cursor is opaque (`maxCursor` + separator + id), so every byte
/// outside RFC 3986's unreserved set is escaped.
pub(crate) fn query_encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const COVERED: Coverage = Coverage {
        packed_through: 30,
        covered_through: 40,
    };

    #[test]
    fn a_live_presigned_pack_of_a_known_kind_is_listed() {
        let listed = |kind: &str, expires: i64| {
            serde_json::json!({"id": "p", "itemKind": kind, "maxCursor": 5,
                "url": "https://r2.example/p", "expiresAt": expires,
                "coverFrom": 0, "coverThrough": 5})
        };
        assert!(listed_pack(&listed("crdt_snapshot", 1_000), 900).is_some());
        let record = listed_pack(&listed("record", 1_000), 900).expect("a record pack");
        assert_eq!(record.cover, Some((0, 5)));
        assert!(listed_pack(&listed("crdt_update", 1_000), 900).is_some());
        assert!(listed_pack(&listed("attachment", 1_000), 900).is_none());
        assert!(listed_pack(&listed("crdt_snapshot", 1_000), 980).is_none());
        assert!(
            listed_pack(
                &serde_json::json!({"id": "p", "itemKind": "crdt_snapshot",
                    "maxCursor": 5, "expiresAt": 1_000}),
                900
            )
            .is_none()
        );
    }

    #[test]
    fn coverage_parses_entry_by_entry() {
        let body = serde_json::json!({"coverage": [
            {"itemKind": "record", "packedThrough": 30, "coveredThrough": 40},
            {"itemKind": "attachment", "packedThrough": 1, "coveredThrough": 1},
            {"itemKind": "crdt_update", "packedThrough": "x"}
        ]});
        let coverage = read_coverage(&body);
        assert_eq!(coverage.get("record"), Some(&COVERED));
        assert_eq!(coverage.len(), 1);
    }

    #[test]
    fn the_tail_starts_at_covered_through_only_when_the_ranges_chain_to_packed_through() {
        assert_eq!(tail_start(&[(0, 10), (10, 30)], Some(COVERED)), 40);
        // Overlap is fine.
        assert_eq!(tail_start(&[(0, 20), (10, 30)], Some(COVERED)), 40);
        // A gap (a 404, a pack delisted mid-walk) stops the walk below it.
        assert_eq!(tail_start(&[(0, 10), (20, 30)], Some(COVERED)), 10);
        // No range from 0.
        assert_eq!(tail_start(&[(5, 30)], Some(COVERED)), 0);
        // No coverage statement: every server before step 07.
        assert_eq!(tail_start(&[(0, 30)], None), 0);
    }
}
