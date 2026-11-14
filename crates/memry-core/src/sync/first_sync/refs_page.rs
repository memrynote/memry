//! One refs-pass page of the first sync, read tolerantly (chapter 05 §5.11.1). Split out of
//! [`super`] for the line ceiling.

use serde_json::Value as Json;

use super::now_ms;

/// One `/sync/changes` ref row, reduced to what the refs pass records
/// (chapter 05 §5.11.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RefRow {
    pub(super) item_id: String,
    pub(super) item_type: String,
    pub(super) modified_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct RefsPage {
    pub(super) refs: Vec<RefRow>,
    pub(super) deleted: Vec<String>,
    pub(super) has_more: bool,
    pub(super) next_cursor: Option<String>,
}

/// Reads the page tolerantly: chapter 13 §13.2.2 permits ignoring an envelope
/// key a client does not know, and a missing array reads as empty.
pub(super) fn read_refs_page(body: &Json) -> RefsPage {
    let refs = body
        .get("items")
        .and_then(Json::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(RefRow {
                        item_id: item.get("id").and_then(Json::as_str)?.to_owned(),
                        item_type: item.get("type").and_then(Json::as_str)?.to_owned(),
                        modified_at: item
                            .get("modifiedAt")
                            .and_then(Json::as_i64)
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    RefsPage {
        refs,
        deleted: body
            .get("deleted")
            .and_then(Json::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Json::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        has_more: body.get("hasMore").and_then(Json::as_bool).unwrap_or(false),
        // §5.11.1: `nextCursor` is an integer on this route. A server that
        // spells it as a string means the same thing.
        next_cursor: match body.get("nextCursor") {
            Some(Json::String(text)) => Some(text.clone()),
            Some(Json::Number(number)) => Some(number.to_string()),
            _ => None,
        },
    }
}

/// The deletion instant for a tombstoned id: the ref row's `modifiedAt` when
/// the page carried one, and the local clock otherwise. A refs-only pass has
/// no envelope to read `deletedAt` from, and inventing a far-future instant
/// would outrank a real edit.
pub(super) fn reference_now(refs: &[RefRow], item_id: &str) -> i64 {
    refs.iter()
        .find(|reference| reference.item_id == item_id)
        .map(|reference| reference.modified_at)
        .unwrap_or_else(now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_ref_page_keeps_the_type_and_the_modified_instant() {
        // §5.11.1's ref row. The refs pass needs `type` to file the row and
        // `modifiedAt` to order pass two, and needs nothing else.
        let page = read_refs_page(&json!({
            "items": [
                {"id": "abc123def456", "type": "note", "version": 3, "modifiedAt": 99, "size": 12},
                {"id": "no-type"}
            ],
            "deleted": ["gone1"],
            "hasMore": true,
            "nextCursor": 41
        }));
        assert_eq!(page.refs.len(), 1);
        assert_eq!(page.refs[0].item_type, "note");
        assert_eq!(page.refs[0].modified_at, 99);
        assert_eq!(page.deleted, ["gone1"]);
        assert!(page.has_more);
        assert_eq!(page.next_cursor.as_deref(), Some("41"));
    }

    #[test]
    fn a_page_missing_its_arrays_reads_as_empty_rather_than_failing() {
        let page = read_refs_page(&json!({}));
        assert!(page.refs.is_empty());
        assert!(page.deleted.is_empty());
        assert!(!page.has_more);
        assert_eq!(page.next_cursor, None);
    }
}
