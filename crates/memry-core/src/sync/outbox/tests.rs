use super::*;

fn row(id: i64, item_type: &str, item_id: &str, op: &str) -> OutboxRow {
    OutboxRow {
        id,
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        op: op.to_owned(),
        payload: None,
        enqueued_at: 0,
        attempt_count: 0,
        last_error: None,
        next_attempt_at: None,
    }
}

#[test]
fn collapse_keeps_the_newest_row_per_key_and_drops_no_id() {
    let collapsed = collapse_records(vec![
        row(1, "task", "t1", OP_UPSERT),
        row(2, "task", "t2", OP_UPSERT),
        row(3, "task", "t1", OP_DELETE),
    ]);
    assert_eq!(collapsed.len(), 2);
    assert_eq!(collapsed[0].row.id, 3);
    assert_eq!(collapsed[0].row.op, OP_DELETE);
    assert_eq!(collapsed[0].superseded, vec![1]);
    assert_eq!(collapsed[0].ids(), vec![3, 1]);
    assert_eq!(collapsed[1].row.id, 2);
    assert!(collapsed[1].superseded.is_empty());
}

#[test]
fn collapse_never_touches_a_crdt_row() {
    let collapsed = collapse_records(vec![
        row(1, "note", "n1", OP_CRDT_UPDATE),
        row(2, "note", "n1", OP_CRDT_UPDATE),
    ]);
    assert!(
        collapsed.is_empty(),
        "collapsing CRDT rows drops updates a peer has not seen"
    );
}

#[test]
fn the_same_id_under_two_types_is_two_push_items() {
    // §5.15: the bookkeeping key is `(type, id)` and never `id` alone.
    let collapsed = collapse_records(vec![
        row(1, "project", "inbox", OP_UPSERT),
        row(2, "tag_definition", "inbox", OP_UPSERT),
    ]);
    assert_eq!(collapsed.len(), 2);
}

#[test]
fn last_error_is_truncated() {
    let long = "x".repeat(MAX_LAST_ERROR_CHARS * 2);
    assert_eq!(truncate(&long).chars().count(), MAX_LAST_ERROR_CHARS);
}
