//! Chapter 07 §7.11's wire shapes, read tolerantly.
//!
//! A separate module from [`super::body_pull`] because it is a different kind
//! of code: no I/O, no database, no decisions — one JSON value in, one plain
//! struct out — and because §7.11 is the section a second port checks this
//! against, so it is worth being able to read on its own.
//!
//! **What the chapter does and does not write down.** §7.11 gives the update
//! entry and the **batch** response. It does not give the batch *request*, and
//! it gives the single-document response only by analogy. So the reader below
//! accepts both shapes for the same fields and treats an absent one as absent
//! rather than as a failure, which is chapter 13 §13.2.2's rule for an
//! envelope key a client does not know.

use serde_json::Value as Json;

/// §7.11: `{ sequenceNum, data, createdAt, signerDeviceId }`, where `data` is
/// base64 of the packed envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct UpdateEntry {
    pub(super) sequence_num: i64,
    /// Still base64. Decoding here would make an undecodable payload look like
    /// an absent entry, and an absent entry is skipped — which is exactly the
    /// permanent skip §7.9 forbids. The decode happens where a failure can
    /// stop the document instead.
    pub(super) data: String,
    pub(super) signer_device_id: Option<String>,
}

/// §7.11's `snapshotMeta` entry. `signerDeviceId` is deliberately absent:
/// §7.11.1 says it is advisory and **a client MUST NOT branch on it**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SnapshotMeta {
    pub(super) sequence_num: i64,
    pub(super) revision: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct UpdatePage {
    pub(super) updates: Vec<UpdateEntry>,
    pub(super) has_more: bool,
    /// Absent means **no server snapshot at all** (§7.11), which §7.8 turns
    /// into "do not fetch" rather than into "fetch to find out".
    pub(super) snapshot_meta: Option<SnapshotMeta>,
}

/// Reads the page tolerantly through both the single-document shape and
/// §7.11's batch shape, because the chapter writes down only the latter.
pub(super) fn read_update_page(body: &Json, doc_id: &str) -> UpdatePage {
    let per_note = body
        .get("notes")
        .and_then(|notes| notes.get(doc_id))
        .unwrap_or(body);

    let updates = per_note
        .get("updates")
        .and_then(Json::as_array)
        .map(|entries| entries.iter().filter_map(read_update_entry).collect())
        .unwrap_or_default();

    let meta_holder = body.get("snapshotMeta");
    let meta = meta_holder
        .and_then(|meta| meta.get(doc_id))
        .or(meta_holder)
        .and_then(read_snapshot_meta);

    UpdatePage {
        updates,
        has_more: per_note
            .get("hasMore")
            .and_then(Json::as_bool)
            .unwrap_or(false),
        snapshot_meta: meta,
    }
}

fn read_update_entry(entry: &Json) -> Option<UpdateEntry> {
    let sequence_num = entry.get("sequenceNum").and_then(Json::as_i64)?;
    let data = entry.get("data").and_then(Json::as_str)?.to_owned();
    Some(UpdateEntry {
        sequence_num,
        data,
        signer_device_id: entry
            .get("signerDeviceId")
            .and_then(Json::as_str)
            .map(str::to_owned),
    })
}

fn read_snapshot_meta(meta: &Json) -> Option<SnapshotMeta> {
    Some(SnapshotMeta {
        sequence_num: meta.get("sequenceNum").and_then(Json::as_i64)?,
        revision: meta.get("revision").and_then(Json::as_str)?.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_page_reads_through_both_the_single_and_the_batch_shape() {
        let single = read_update_page(
            &json!({
                "updates": [{"sequenceNum": 3, "data": "YWJj", "createdAt": 7, "signerDeviceId": "dev-1"}],
                "hasMore": true
            }),
            "abc123def456",
        );
        assert_eq!(single.updates.len(), 1);
        assert_eq!(single.updates[0].sequence_num, 3);
        assert_eq!(single.updates[0].data, "YWJj");
        assert_eq!(single.updates[0].signer_device_id.as_deref(), Some("dev-1"));
        assert!(single.has_more);

        // §7.11's batch shape, keyed by note id, with the snapshot meta map
        // beside it.
        let batch = read_update_page(
            &json!({
                "notes": { "abc123def456": { "updates": [{"sequenceNum": 9, "data": "YWJj"}], "hasMore": false } },
                "snapshotMeta": { "abc123def456": { "sequenceNum": 8, "revision": "rev-1" } }
            }),
            "abc123def456",
        );
        assert_eq!(batch.updates.len(), 1);
        assert_eq!(batch.updates[0].sequence_num, 9);
        assert_eq!(
            batch.snapshot_meta,
            Some(SnapshotMeta {
                sequence_num: 8,
                revision: "rev-1".into()
            })
        );
    }

    #[test]
    fn a_document_absent_from_snapshot_meta_has_no_server_snapshot() {
        // §7.11, and §7.8's `: false` branch: an old server advertising
        // nothing means "do not fetch", never "fetch to find out".
        let page = read_update_page(
            &json!({ "updates": [], "snapshotMeta": { "other12345678": { "sequenceNum": 1, "revision": "r" } } }),
            "abc123def456",
        );
        assert_eq!(page.snapshot_meta, None);
        assert!(!page.has_more);
    }

    #[test]
    fn an_undecodable_payload_survives_the_read_so_it_can_stop_the_document() {
        // Only an entry with no sequence number at all is dropped: there is
        // nothing a client could do with it. An entry whose `data` will not
        // decode is kept, so §7.9's stop-at-gap fires in the pull loop rather
        // than the entry quietly vanishing and the cursor stepping over it.
        let page = read_update_page(
            &json!({ "updates": [
                {"data": "YWJj"},
                {"sequenceNum": 4, "data": "not base64 !!"},
                {"sequenceNum": 5, "data": "YWJj"}
            ]}),
            "abc123def456",
        );
        assert_eq!(page.updates.len(), 2);
        assert_eq!(page.updates[0].sequence_num, 4);
        assert_eq!(page.updates[1].sequence_num, 5);
    }
}
