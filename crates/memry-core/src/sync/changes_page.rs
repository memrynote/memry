//! One `GET /sync/changes` page, read tolerantly, and the plan for which of
//! its ids still go to `POST /sync/pull` (chapter 05 §5.11.2, §5.12).
//!
//! Split out of [`super::pull`], which owns fetching, decoding, applying and
//! the cursor. Nothing here touches the network or the database.

use serde_json::Value as Json;

/// One page of `GET /sync/changes`.
///
/// Only the **ids** of the ref rows are kept. A ref's type is read from the
/// `/sync/pull` response instead, so a client never has two opinions about an
/// item's type, and the presence of a ref row is the only thing §5.12.1 needs
/// it for: an id in `deleted` **without** one has no type on the wire.
pub(super) struct ChangesPage {
    pub(super) ref_ids: Vec<String>,
    pub(super) deleted: Vec<String>,
    pub(super) has_more: bool,
    pub(super) next_cursor: Option<String>,
    /// `/sync/pull` items the page carried inline (§5.11.2), unparsed:
    /// validation stays per item.
    pub(super) inline: Vec<Json>,
    /// `noteBodies` (§5.11.1), unparsed, and `None` when the key is absent:
    /// a server that does not serve bodies in the feed.
    pub(super) note_bodies: Option<Vec<Json>>,
}

/// §5.12: the client unions `deleted` into the `/sync/pull` request for the
/// **same** page, because tombstones arrive as full signed items.
pub(super) fn requested_ids(page: &ChangesPage) -> Vec<String> {
    let mut ids: Vec<String> = Vec::with_capacity(page.ref_ids.len() + page.deleted.len());
    for id in page.ref_ids.iter().chain(page.deleted.iter()) {
        if !ids.iter().any(|kept| kept == id) {
            ids.push(id.clone());
        }
    }
    ids
}

/// The page ids still fetched with `POST /sync/pull`, in page order.
///
/// §5.11.2: coverage is by id, so an id an inline element names is not pulled
/// again, even when that element fails to decode.
pub(super) fn uncovered_ids(page: &ChangesPage, ids: &[String]) -> Vec<String> {
    let covered: Vec<&str> = page
        .inline
        .iter()
        .filter_map(|item| item.get("id").and_then(Json::as_str))
        .collect();
    ids.iter()
        .filter(|id| !covered.contains(&id.as_str()))
        .cloned()
        .collect()
}

/// Reads the page shape tolerantly: chapter 13 §13.2.2 permits ignoring an
/// **envelope** key a client does not know, and a missing `items` or `deleted`
/// array reads as empty rather than as a failure.
pub(super) fn read_changes_page(body: &Json) -> ChangesPage {
    let ref_ids = body
        .get("items")
        .and_then(Json::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Json::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let deleted = body
        .get("deleted")
        .and_then(Json::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Json::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    ChangesPage {
        ref_ids,
        deleted,
        has_more: body.get("hasMore").and_then(Json::as_bool).unwrap_or(false),
        // The cursor is a decimal string on the wire; a server that sends it
        // as a number means the same thing (§5.11).
        next_cursor: match body.get("nextCursor") {
            Some(Json::String(text)) => Some(text.clone()),
            Some(Json::Number(number)) => Some(number.to_string()),
            _ => None,
        },
        inline: body
            .get("inline")
            .and_then(Json::as_array)
            .cloned()
            .unwrap_or_default(),
        note_bodies: body.get("noteBodies").and_then(Json::as_array).cloned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_requested_ids_union_the_refs_and_the_deleted_of_the_same_page() {
        let page = ChangesPage {
            ref_ids: vec!["a".into(), "b".into()],
            deleted: vec!["b".into(), "c".into()],
            has_more: false,
            next_cursor: None,
            inline: Vec::new(),
            note_bodies: None,
        };
        assert_eq!(requested_ids(&page), ["a", "b", "c"]);
    }

    #[test]
    fn a_page_shape_missing_its_arrays_reads_as_empty_rather_than_failing() {
        let page = read_changes_page(&json!({ "nextCursor": 41, "hasMore": true }));
        assert!(page.ref_ids.is_empty());
        assert!(page.deleted.is_empty());
        assert!(page.has_more);
        assert_eq!(page.next_cursor.as_deref(), Some("41"));
    }
}
