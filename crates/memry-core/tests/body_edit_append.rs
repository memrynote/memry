//! Appending a block snapshot to another body: desktop's block menu "Move to"
//! (`moveBlockToNote` in `ContentArea.tsx`). The block lands at the end of the
//! target with its children, marks and inline nodes; ids the target already
//! holds are minted afresh, and a note the vault does not hold is an answer,
//! not a write.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::blocks::extract_blocks;
use memry_core::crdt::body_edit::{BlockEdit, append_snapshot, apply, snapshot_block};
use memry_core::crdt::canonical::canonical_fragment;
use memry_core::crdt::registry::{Document, UpdateSink};
use memry_core::crdt::update_log;
use memry_core::domain::notes::{self, NewNote};
use memry_core::domain::{body_write, reads};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use yrs::{
    Doc, ReadTxn as _, Transact as _, Xml as _, XmlElementPrelim, XmlElementRef, XmlFragment as _,
    XmlTextPrelim,
};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-append";

/// `(id, kind, text, children)`.
struct Spec(&'static str, &'static str, &'static str, Vec<Spec>);

fn place(txn: &mut yrs::TransactionMut<'_>, group: &XmlElementRef, specs: &[Spec]) {
    for (index, Spec(id, kind, text, children)) in specs.iter().enumerate() {
        let container = group.insert(txn, index as u32, XmlElementPrelim::empty("blockContainer"));
        container.insert_attribute(txn, "id", *id);
        let block = container.insert(txn, 0, XmlElementPrelim::empty(*kind));
        if !text.is_empty() {
            block.insert(txn, 0, XmlTextPrelim::new(*text));
        }
        if !children.is_empty() {
            let nested = container.insert(txn, 1, XmlElementPrelim::empty("blockGroup"));
            place(txn, &nested, children);
        }
    }
}

fn body(specs: &[Spec]) -> Vec<u8> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    place(&mut txn, &group, specs);
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}

fn opened(doc_id: &str, update: &[u8]) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new("device-body-append", sink)
        .get_or_open(doc_id)
        .expect("open");
    document.apply_durable_update(update).expect("apply");
    document
}

fn edit(document: &Document, edit: BlockEdit) {
    apply(document, &edit).unwrap_or_else(|error| panic!("{edit:?}: {error:?}"));
}

/// `(id, depth)` in body order.
fn outline(document: &Document) -> Vec<(String, u32)> {
    extract_blocks(document)
        .expect("blocks")
        .into_iter()
        .map(|block| (block.id.unwrap_or_default(), block.depth))
        .collect()
}

/// The canonical form from `id`'s container to the end of the body.
fn tail_from(canonical: &str, id: &str) -> String {
    canonical
        .split(&format!("blockContainer id=\"{id}\""))
        .nth(1)
        .unwrap_or_else(|| panic!("no block {id} in:\n{canonical}"))
        .to_owned()
}

#[test]
fn an_appended_block_lands_last_with_its_children_marks_and_inline_nodes() {
    let source = opened(
        "source",
        &body(&[
            Spec("p", "paragraph", "stays", vec![]),
            Spec(
                "a",
                "bulletListItem",
                "hello and end",
                vec![Spec("a1", "bulletListItem", "child", vec![])],
            ),
        ]),
    );
    edit(
        &source,
        BlockEdit::SetMark {
            block_id: "a".to_owned(),
            start: 0,
            end: 5,
            mark: "bold".to_owned(),
            value: None,
        },
    );
    edit(
        &source,
        BlockEdit::InsertInline {
            block_id: "a".to_owned(),
            start: 6,
            end: 6,
            kind: "hashTag".to_owned(),
            text: "#work".to_owned(),
            attrs: HashMap::from([("tag".to_owned(), "work".to_owned())]),
        },
    );
    let snapshot = snapshot_block(&source, "a").expect("snapshot");

    let target = opened(
        "target",
        &body(&[
            Spec("t1", "paragraph", "first", vec![]),
            Spec("t2", "heading", "second", vec![]),
        ]),
    );
    append_snapshot(&target, &snapshot).expect("append");

    assert_eq!(
        outline(&target),
        vec![
            ("t1".to_owned(), 0),
            ("t2".to_owned(), 0),
            ("a".to_owned(), 0),
            ("a1".to_owned(), 1),
        ]
    );
    let moved = tail_from(&canonical_fragment(&target).expect("canonical"), "a");
    let original = tail_from(&canonical_fragment(&source).expect("canonical"), "a");
    assert_eq!(
        moved, original,
        "marks, the tag node and the child travel as they were"
    );
    assert!(moved.contains("bold"), "{moved}");
    assert!(moved.contains("hashTag"), "{moved}");
}

#[test]
fn ids_the_target_already_holds_are_minted_afresh() {
    let source = opened(
        "source",
        &body(&[Spec(
            "a",
            "paragraph",
            "moving",
            vec![
                Spec("shared", "paragraph", "child", vec![]),
                Spec("own", "paragraph", "kept", vec![]),
            ],
        )]),
    );
    let snapshot = snapshot_block(&source, "a").expect("snapshot");
    let target = opened(
        "target",
        &body(&[
            Spec("a", "paragraph", "here already", vec![]),
            Spec("shared", "paragraph", "too", vec![]),
        ]),
    );

    append_snapshot(&target, &snapshot).expect("append");

    let ids: Vec<String> = outline(&target).into_iter().map(|(id, _)| id).collect();
    assert_eq!(ids.len(), 5);
    assert_eq!(&ids[..2], &["a".to_owned(), "shared".to_owned()]);
    assert_ne!(ids[2], "a", "the moved block's id was taken");
    assert_ne!(ids[3], "shared", "the child's id was taken");
    assert_eq!(ids[4], "own", "an id the target does not hold is kept");
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len());
}

#[test]
fn a_snapshot_the_core_cannot_read_is_refused() {
    let target = opened("target", &body(&[Spec("t1", "paragraph", "first", vec![])]));
    assert!(append_snapshot(&target, "not a snapshot").is_err());
    assert_eq!(outline(&target), vec![("t1".to_owned(), 0)]);
}

// MARK: - Through the note's log

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-body-append-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn seed_note(conn: &Connection, id: &str, specs: &[Spec]) {
    notes::create(
        conn,
        &NewNote {
            id,
            title: id,
            folder_path: None,
            content: "",
            tags: &[],
            properties: None,
        },
        DEVICE,
        NOW,
    )
    .expect("create the note");
    update_log::append_server_update(conn, id, 1, &body(specs), NOW).expect("seed the body");
}

fn queued(conn: &Connection, id: &str) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM outbox WHERE item_id = ?1",
        params![id],
        |row| row.get(0),
    )
    .expect("count the queue")
}

#[test]
fn appending_to_a_note_is_durable_and_queued_and_a_missing_note_is_an_answer() {
    let db = open("log");
    db.call_blocking(|conn| {
        seed_note(conn, "target", &[Spec("t1", "paragraph", "first", vec![])]);
        let source = opened("source", &body(&[Spec("a", "quote", "moving", vec![])]));
        let snapshot = snapshot_block(&source, "a").expect("snapshot");
        let before = queued(conn, "target");

        assert!(
            !body_write::append_snapshot(conn, "nowhere", &snapshot, DEVICE, NOW).expect("answer"),
            "a note the vault does not hold"
        );

        assert!(
            body_write::append_snapshot(conn, "target", &snapshot, DEVICE, NOW).expect("append")
        );
        let blocks = reads::note_blocks(conn, "target")
            .expect("read the body")
            .expect("the note is here");
        let kinds: Vec<(Option<String>, String)> = blocks
            .into_iter()
            .map(|block| (block.id, block.kind))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (Some("t1".to_owned()), "paragraph".to_owned()),
                (Some("a".to_owned()), "quote".to_owned()),
            ]
        );
        assert_eq!(
            queued(conn, "target"),
            before + 1,
            "the update is queued for the other devices"
        );
        Ok(())
    })
    .expect("append through the log");
}
