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

#[test]
fn an_upsert_over_an_unsent_create_is_sent_as_the_create() {
    let collapsed = collapse_records(vec![
        row(1, "property_definition", "gone", OP_CREATE),
        row(2, "property_definition", "gone", OP_UPSERT),
        row(3, "task", "t1", OP_CREATE),
        row(4, "task", "t1", OP_DELETE),
    ]);
    assert_eq!(collapsed[0].row.op, OP_CREATE);
    assert_eq!(collapsed[0].ids(), vec![2, 1]);
    assert_eq!(collapsed[1].row.op, OP_DELETE, "a delete still wins");

    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, item_type TEXT NOT NULL,
           item_id TEXT NOT NULL, op TEXT NOT NULL, payload BLOB, enqueued_at INTEGER NOT NULL,
           attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_attempt_at INTEGER);",
    )
    .unwrap();
    let ops = |conn: &Connection| -> Vec<String> {
        let mut statement = conn.prepare("SELECT op FROM outbox ORDER BY id").unwrap();
        let ops = statement.query_map([], |row| row.get(0)).unwrap();
        ops.collect::<Result<_, _>>().unwrap()
    };
    let queue = |change: Change| commit(&conn, &change, 1, |_| Ok(())).map(|_| ()).unwrap();
    queue(Change::create("property_definition", "gone"));
    queue(Change::upsert("property_definition", "gone"));
    assert_eq!(ops(&conn), [OP_CREATE]);
    queue(Change::delete("property_definition", "gone"));
    queue(Change::upsert("property_definition", "gone"));
    assert_eq!(ops(&conn), [OP_UPSERT]);
}
