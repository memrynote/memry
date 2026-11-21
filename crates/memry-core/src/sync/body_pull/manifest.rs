//! The body checks a pack reader runs after it holds the pack bytes (chapter
//! 08 §8.4.3, §8.10, #5232): a **body manifest read** of
//! `GET /sync/crdt/manifest`, and `POST /sync/crdt/updates/batch` when the
//! server has no manifest route or the read stops short.

use std::collections::HashMap;

use serde_json::{Value as Json, json};

use crate::protocol::http::RetryPolicy;
use crate::sync::pack_bootstrap::body_plan::{BodyCheck, ServerSnapshot};
use crate::sync::pack_bootstrap::query_encode;

use super::{BodyPull, BodyPullError, PROBE_CHUNK};

/// Documents per manifest page: the route's ceiling (chapter 07 §7.4.1).
pub const CRDT_MANIFEST_PAGE_LIMIT: u32 = 1000;

/// A read that has not ended after this many pages stops short. Ten million
/// documents, far past any vault, so it only stops a cursor that never ends.
const MAX_MANIFEST_PAGES: usize = 10_000;

impl BodyPull {
    /// Every page from no `cursor` until `nextCursor` is `null`. `None` when
    /// the read stops short: a 404 from a server before the route, any failed
    /// or malformed page, a document listed twice, or a cursor that does not
    /// move. A short read answers nothing (§8.4.3), so a rate-limited page
    /// waits out `Retry-After` and is asked again (#5349).
    pub(in crate::sync) async fn read_body_manifest(
        &self,
        requests: &mut usize,
    ) -> Result<Option<HashMap<String, BodyCheck>>, BodyPullError> {
        let mut checks = HashMap::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_MANIFEST_PAGES {
            let mut path = format!("/sync/crdt/manifest?limit={CRDT_MANIFEST_PAGE_LIMIT}");
            if let Some(cursor) = &cursor {
                path.push_str("&cursor=");
                path.push_str(&query_encode(cursor));
            }
            *requests += 1;
            let request = self.request("GET", &path).retry(RetryPolicy::walk());
            let Ok(body) = self.http.send_json::<Json>(request).await else {
                return Ok(None);
            };
            let Some((documents, next)) = read_manifest_page(&body) else {
                return Ok(None);
            };
            for (doc_id, check) in documents {
                if checks.insert(doc_id, check).is_some() {
                    return Ok(None);
                }
            }
            match next {
                None => return Ok(Some(checks)),
                Some(next) if cursor.as_deref() == Some(next.as_str()) => return Ok(None),
                Some(next) => cursor = Some(next),
            }
        }
        Ok(None)
    }

    /// The batch route's `floor` and `snapshotMeta` for each `(docId, since)`,
    /// a hundred per request. **Fail closed**: a document whose request failed
    /// or that the answer left out gets no check, so none of its packed bodies
    /// is applied. No `maxSequenceNum` comes back, so no document is proven
    /// current here; each keeps its route pull.
    pub(in crate::sync) async fn batch_checks(
        &self,
        docs: &[(String, i64)],
        requests: &mut usize,
    ) -> Result<HashMap<String, BodyCheck>, BodyPullError> {
        let mut checks = HashMap::new();
        for chunk in docs.chunks(PROBE_CHUNK) {
            let notes: Vec<Json> = chunk
                .iter()
                .map(|(doc_id, since)| json!({ "noteId": doc_id, "since": since }))
                .collect();
            *requests += 1;
            let request = self
                .request("POST", "/sync/crdt/updates/batch")
                .json(&json!({ "notes": notes, "limit": 1 }))
                .retry(RetryPolicy::polled());
            let Ok(body) = self.http.send_json::<Json>(request).await else {
                continue;
            };
            let metas = body.get("snapshotMeta").filter(|metas| metas.is_object());
            for (doc_id, _) in chunk {
                let Some(note) = body.get("notes").and_then(|notes| notes.get(doc_id)) else {
                    continue;
                };
                let snapshot = match metas.map(|metas| metas.get(doc_id)) {
                    None => ServerSnapshot::Unknown,
                    Some(None | Some(Json::Null)) => ServerSnapshot::None,
                    Some(Some(meta)) => read_snapshot(meta).unwrap_or(ServerSnapshot::Unknown),
                };
                checks.insert(
                    doc_id.clone(),
                    BodyCheck {
                        floor: note.get("floor").and_then(non_negative),
                        snapshot,
                        max_sequence_num: None,
                    },
                );
            }
        }
        Ok(checks)
    }
}

type ManifestPage = (Vec<(String, BodyCheck)>, Option<String>);

/// `CrdtManifestResponseSchema`: any field missing or out of range makes the
/// whole page malformed.
fn read_manifest_page(body: &Json) -> Option<ManifestPage> {
    let next = match body.get("nextCursor")? {
        Json::Null => None,
        Json::String(next) if !next.is_empty() => Some(next.clone()),
        _ => return None,
    };
    let documents = body.get("documents")?.as_array()?;
    let mut out = Vec::with_capacity(documents.len());
    for document in documents {
        let doc_id = document
            .get("noteId")?
            .as_str()
            .filter(|id| !id.is_empty())?;
        let snapshot = match document.get("snapshot")? {
            Json::Null => ServerSnapshot::None,
            meta => read_snapshot(meta)?,
        };
        out.push((
            doc_id.to_owned(),
            BodyCheck {
                floor: Some(non_negative(document.get("floor")?)?),
                snapshot,
                max_sequence_num: Some(non_negative(document.get("maxSequenceNum")?)?),
            },
        ));
    }
    Some((out, next))
}

fn read_snapshot(meta: &Json) -> Option<ServerSnapshot> {
    Some(ServerSnapshot::Some {
        sequence_num: non_negative(meta.get("sequenceNum")?)?,
        revision: meta
            .get("revision")?
            .as_str()
            .filter(|revision| !revision.is_empty())?
            .to_owned(),
    })
}

fn non_negative(value: &Json) -> Option<i64> {
    value.as_i64().filter(|number| *number >= 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_with_any_bad_field_is_malformed() {
        let good = json!({"documents": [
            {"noteId": "a", "floor": 0, "snapshot": null, "maxSequenceNum": 2},
            {"noteId": "b", "floor": 3, "snapshot": {"revision": "r", "sequenceNum": 1},
             "maxSequenceNum": 0}
        ], "nextCursor": null});
        let (documents, next) = read_manifest_page(&good).expect("a page");
        assert_eq!(documents.len(), 2);
        assert_eq!(next, None);
        assert_eq!(documents[1].1.floor, Some(3));

        for bad in [
            json!({"documents": [{"noteId": "a", "snapshot": null, "maxSequenceNum": 2}],
                   "nextCursor": null}),
            json!({"documents": [{"noteId": "a", "floor": -1, "snapshot": null,
                                  "maxSequenceNum": 2}], "nextCursor": null}),
            json!({"documents": [{"noteId": "a", "floor": 0,
                                  "snapshot": {"revision": "", "sequenceNum": 1},
                                  "maxSequenceNum": 2}], "nextCursor": null}),
            json!({"documents": [], "nextCursor": ""}),
            json!({"documents": []}),
        ] {
            assert!(read_manifest_page(&bad).is_none(), "{bad}");
        }
    }
}
