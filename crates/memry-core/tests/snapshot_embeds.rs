//! A block that is copied through its snapshot (duplicate, move, indent,
//! outdent, turn into, `RestoreBlock`, "Move to", a column list unwrapped)
//! keeps an embed inside its text run, with its marks (#4262). An embed that
//! is a shared type cannot be copied without a deep copy, so the edit is
//! refused before anything changes rather than dropping it.

use std::collections::HashMap;
use std::sync::Arc;

use memry_core::crdt::body_edit::{BlockEdit, append_snapshot, apply, snapshot_block};
use memry_core::crdt::registry::{Document, UpdateSink};
use memry_core::crdt::{CrdtError, DocumentRegistry};
use yrs::updates::decoder::Decode as _;
use yrs::{
    Any, Doc, GetString as _, Out, ReadTxn as _, StateVector, Text as _, TextPrelim, Transact as _,
    Update, Xml as _, XmlElementPrelim, XmlElementRef, XmlFragment as _, XmlOut, XmlTextPrelim,
};

/// What sits inside `b`'s run in every body here: bold "ab", an embed, "cd".
fn embed() -> Any {
    Any::Map(Arc::new(HashMap::from([(
        "x".to_owned(),
        Any::Number(1.0),
    )])))
}

fn expected() -> Vec<String> {
    vec![
        "*ab*".to_owned(),
        format!("<{:?}>", embed()),
        "cd".to_owned(),
    ]
}

fn opened(update: &[u8], device: &str) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new(device, sink)
        .get_or_open("abc123def456")
        .expect("open");
    document.apply_durable_update(update).expect("apply");
    document
}

/// Paragraphs `a`, `b`, `c` at the top level; `b`'s run is bold "ab", then
/// `embed` (an `Any` when `shared` is false, a `YText` when true), then "cd".
fn body(shared: bool) -> Vec<u8> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    for id in ["a", "b", "c"] {
        let container = group.push_back(&mut txn, XmlElementPrelim::empty("blockContainer"));
        container.insert_attribute(&mut txn, "id", id);
        let paragraph = container.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        let run = paragraph.push_back(&mut txn, XmlTextPrelim::new(""));
        if id != "b" {
            run.insert(&mut txn, 0, id);
            continue;
        }
        let bold = HashMap::from([(Arc::from("bold"), Any::Map(Arc::new(HashMap::new())))]);
        run.insert_with_attributes(&mut txn, 0, "ab", bold);
        if shared {
            run.insert_embed_with_attributes(&mut txn, 2, TextPrelim::new("inner"), HashMap::new());
        } else {
            run.insert_embed_with_attributes(&mut txn, 2, embed(), HashMap::new());
        }
        run.insert_with_attributes(&mut txn, 3, "cd", HashMap::new());
    }
    txn.encode_state_as_update_v1(&StateVector::default())
}

/// Every container's id with its block's run chunks (`*bold*`, `<embed>`),
/// depth first, so a nested block is listed after its parent.
fn runs(document: &Document) -> Vec<(String, Vec<String>)> {
    fn walk(txn: &yrs::Transaction, element: &XmlElementRef, out: &mut Vec<(String, Vec<String>)>) {
        if element.tag().as_ref() == "blockContainer" {
            let id = element.get_attribute(txn, "id").map(|id| id.to_string(txn));
            let mut chunks = Vec::new();
            for child in element.children(txn) {
                let XmlOut::Element(block) = child else {
                    continue;
                };
                if block.tag().as_ref() == "blockGroup" {
                    continue;
                }
                for inner in block.children(txn) {
                    let XmlOut::Text(run) = inner else { continue };
                    for chunk in run.diff(txn, yrs::types::text::YChange::identity) {
                        let shown = match &chunk.insert {
                            Out::Any(Any::String(text)) => text.to_string(),
                            Out::Any(any) => format!("<{any:?}>"),
                            Out::YText(text) => format!("<shared {}>", text.get_string(txn)),
                            other => panic!("unexpected embed {other:?}"),
                        };
                        let bold = chunk
                            .attributes
                            .is_some_and(|attrs| attrs.contains_key("bold"));
                        chunks.push(if bold { format!("*{shown}*") } else { shown });
                    }
                }
            }
            out.push((id.unwrap_or_default(), chunks));
        }
        for child in element.children(txn) {
            if let XmlOut::Element(inner) = child {
                walk(txn, &inner, out);
            }
        }
    }
    let doc = Doc::new();
    doc.transact_mut()
        .apply_update(Update::decode_v1(&document.encode_state().expect("state")).expect("decode"))
        .expect("merge");
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let txn = doc.transact();
    let mut out = Vec::new();
    for child in fragment.children(&txn) {
        if let XmlOut::Element(element) = child {
            walk(&txn, &element, &mut out);
        }
    }
    out
}

fn ids(document: &Document) -> Vec<String> {
    runs(document).into_iter().map(|(id, _)| id).collect()
}

fn run_of(document: &Document, id: &str) -> Vec<String> {
    runs(document)
        .into_iter()
        .find(|(candidate, _)| candidate == id)
        .unwrap_or_else(|| panic!("no block {id}"))
        .1
}

fn edit(document: &Document, edit: BlockEdit) {
    apply(document, &edit).unwrap_or_else(|error| panic!("{edit:?}: {error:?}"));
}

#[test]
fn a_duplicated_block_keeps_its_embed() {
    let document = opened(&body(false), "device-embed-dup");
    edit(
        &document,
        BlockEdit::Duplicate {
            block_id: "b".to_owned(),
            new_block_id: "b2".to_owned(),
        },
    );
    assert_eq!(ids(&document), ["a", "b", "b2", "c"]);
    assert_eq!(run_of(&document, "b"), expected());
    assert_eq!(run_of(&document, "b2"), expected());
}

#[test]
fn a_moved_block_keeps_its_embed() {
    let document = opened(&body(false), "device-embed-move");
    edit(
        &document,
        BlockEdit::MoveBlock {
            block_id: "b".to_owned(),
            after_block_id: Some("c".to_owned()),
        },
    );
    assert_eq!(ids(&document), ["a", "c", "b"]);
    assert_eq!(run_of(&document, "b"), expected());
}

#[test]
fn an_indented_then_outdented_block_keeps_its_embed() {
    let document = opened(&body(false), "device-embed-indent");
    edit(
        &document,
        BlockEdit::Indent {
            block_id: "b".to_owned(),
        },
    );
    assert_eq!(ids(&document), ["a", "b", "c"]);
    assert_eq!(run_of(&document, "b"), expected());
    edit(
        &document,
        BlockEdit::Outdent {
            block_id: "b".to_owned(),
        },
    );
    assert_eq!(run_of(&document, "b"), expected());
}

#[test]
fn a_block_turned_into_a_heading_keeps_its_embed() {
    let document = opened(&body(false), "device-embed-turn");
    edit(
        &document,
        BlockEdit::TurnInto {
            block_id: "b".to_owned(),
            kind: "heading".to_owned(),
        },
    );
    assert_eq!(run_of(&document, "b"), expected());
}

#[test]
fn a_deleted_block_restored_from_its_snapshot_keeps_its_embed() {
    let document = opened(&body(false), "device-embed-restore");
    let snapshot = snapshot_block(&document, "b").expect("snapshot");
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "b".to_owned(),
        },
    );
    assert_eq!(ids(&document), ["a", "c"]);
    edit(&document, BlockEdit::RestoreBlock { snapshot });
    assert_eq!(ids(&document), ["a", "b", "c"]);
    assert_eq!(run_of(&document, "b"), expected());
}

#[test]
fn a_block_moved_to_another_note_keeps_its_embed() {
    let source = opened(&body(false), "device-embed-source");
    let target = opened(&body(false), "device-embed-target");
    let snapshot = snapshot_block(&source, "b").expect("snapshot");
    append_snapshot(&target, &snapshot).expect("append");
    let target_runs = runs(&target);
    let (_, appended) = target_runs.last().expect("appended");
    assert_eq!(*appended, expected());
}

/// A run with no embed is written in the snapshot shape builds before #4262
/// wrote and read, so a snapshot of ordinary text means the same to both.
#[test]
fn a_snapshot_without_an_embed_keeps_the_text_shape_older_builds_read() {
    let document = opened(&body(false), "device-embed-shape");
    let plain = snapshot_block(&document, "a").expect("snapshot");
    assert!(plain.contains(r#"{"Text":[["a",null]]}"#), "{plain}");
    assert!(!plain.contains("Chunks"), "{plain}");

    edit(
        &document,
        BlockEdit::Delete {
            block_id: "a".to_owned(),
        },
    );
    edit(&document, BlockEdit::RestoreBlock { snapshot: plain });
    assert_eq!(run_of(&document, "a"), ["a"]);
}

fn refused(document: &Document, edit: &BlockEdit) {
    let before = document.encode_state().expect("state");
    match apply(document, edit) {
        Err(CrdtError::Undecodable { what, .. }) => {
            assert!(what.contains("shared type"), "{edit:?}: {what}");
        }
        other => panic!("{edit:?} was not refused: {other:?}"),
    }
    assert_eq!(document.encode_state().expect("state"), before, "{edit:?}");
}

/// A shared-type embed is refused by every snapshot-based edit, with the
/// document left exactly as it was: never deep-copied, never dropped.
#[test]
fn a_shared_type_embed_refuses_every_snapshot_based_edit() {
    let document = opened(&body(true), "device-embed-shared");
    let shared = run_of(&document, "b");
    assert_eq!(shared[1], "<shared inner>");
    for edit in [
        BlockEdit::Duplicate {
            block_id: "b".to_owned(),
            new_block_id: "b2".to_owned(),
        },
        BlockEdit::MoveBlock {
            block_id: "b".to_owned(),
            after_block_id: Some("c".to_owned()),
        },
        BlockEdit::Indent {
            block_id: "b".to_owned(),
        },
        BlockEdit::TurnInto {
            block_id: "b".to_owned(),
            kind: "heading".to_owned(),
        },
    ] {
        refused(&document, &edit);
    }

    // Outdent needs `b` nested, so it is indented before the embed arrives.
    let nested = opened(&body(false), "device-embed-shared-nested");
    edit(
        &nested,
        BlockEdit::Indent {
            block_id: "b".to_owned(),
        },
    );
    share_b(&nested);
    refused(
        &nested,
        &BlockEdit::Outdent {
            block_id: "b".to_owned(),
        },
    );
    match snapshot_block(&document, "b") {
        Err(CrdtError::Undecodable { what, .. }) => assert!(what.contains("shared type"), "{what}"),
        other => panic!("snapshot was not refused: {other:?}"),
    }
    assert_eq!(run_of(&document, "b"), shared);
}

/// Two columns: the first holds `x` alone, the second holds `b` (the embed
/// paragraph of [`body`]). Deleting `x` empties its column, which unwraps the
/// list and rebuilds `b` beside it.
fn columns(shared: bool) -> Arc<Document> {
    let document = opened(
        &body(shared),
        if shared {
            "device-col-shared"
        } else {
            "device-col"
        },
    );
    edit(
        &document,
        BlockEdit::InsertColumnList {
            after_block_id: Some("c".to_owned()),
            columns: 2,
            new_block_id: "list".to_owned(),
        },
    );
    let column_blocks: Vec<String> = ids(&document)
        .into_iter()
        .filter(|id| !["a", "b", "c", "list"].contains(&id.as_str()))
        .collect();
    let [_, second] = column_blocks.as_slice() else {
        panic!("two column paragraphs: {column_blocks:?}");
    };
    edit(
        &document,
        BlockEdit::MoveBlock {
            block_id: "b".to_owned(),
            after_block_id: Some(second.clone()),
        },
    );
    edit(
        &document,
        BlockEdit::Delete {
            block_id: second.clone(),
        },
    );
    document
}

#[test]
fn a_column_unwrapped_by_a_delete_keeps_its_blocks_embed() {
    let document = columns(false);
    let first = ids(&document)
        .into_iter()
        .find(|id| !["a", "b", "c", "list"].contains(&id.as_str()))
        .expect("first column block");
    edit(&document, BlockEdit::Delete { block_id: first });
    assert_eq!(ids(&document), ["a", "c", "b"]);
    assert_eq!(run_of(&document, "b"), expected());
}

/// Puts a shared-type embed at the start of `b`'s run, through an update as
/// a peer would, so a setup that moves `b` runs before it is there.
fn share_b(document: &Document) {
    let doc = Doc::new();
    doc.transact_mut()
        .apply_update(Update::decode_v1(&document.encode_state().expect("state")).expect("decode"))
        .expect("merge");
    let before = doc.transact().state_vector();
    {
        let fragment = doc.get_or_insert_xml_fragment("prosemirror");
        let mut txn = doc.transact_mut();
        let run = find_run(&txn, &fragment, "b").expect("b's run");
        run.insert_embed(&mut txn, 0, TextPrelim::new("inner"));
    }
    let update = doc.transact().encode_state_as_update_v1(&before);
    document
        .apply_durable_update(&update)
        .expect("shared embed");
}

fn first_column_block(document: &Document) -> String {
    ids(document)
        .into_iter()
        .find(|id| !["a", "b", "c", "list"].contains(&id.as_str()))
        .expect("first column block")
}

#[test]
fn a_delete_that_would_unwrap_a_shared_type_embed_is_refused() {
    let document = columns(false);
    share_b(&document);
    let first = first_column_block(&document);
    refused(&document, &BlockEdit::Delete { block_id: first });
}

/// Moving the first column's only block out empties its column, which
/// unwraps the list and would rebuild `b`, whose shared-type embed a copy
/// cannot carry. Refused with nothing changed, not left as a one-column list
/// the next peer deletes with `b` in it.
#[test]
fn a_move_out_of_a_column_that_would_unwrap_a_shared_type_embed_is_refused() {
    let document = columns(false);
    share_b(&document);
    let first = first_column_block(&document);
    refused(
        &document,
        &BlockEdit::MoveBlock {
            block_id: first,
            after_block_id: Some("a".to_owned()),
        },
    );
}

/// Deleting `b`, the shared-type embed's own block, unwraps the list too, but
/// only the other column is rebuilt, so nothing that cannot be copied is.
#[test]
fn deleting_the_shared_type_embed_block_that_empties_its_column_unwraps_the_list() {
    let document = columns(false);
    share_b(&document);
    let first = first_column_block(&document);
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "b".to_owned(),
        },
    );
    assert_eq!(ids(&document), ["a", "c", first.as_str()]);
}

fn find_run<T: yrs::ReadTxn>(
    txn: &T,
    fragment: &yrs::XmlFragmentRef,
    id: &str,
) -> Option<yrs::XmlTextRef> {
    fn walk<T: yrs::ReadTxn>(
        txn: &T,
        element: &XmlElementRef,
        id: &str,
    ) -> Option<yrs::XmlTextRef> {
        if element.tag().as_ref() == "blockContainer"
            && element
                .get_attribute(txn, "id")
                .map(|v| v.to_string(txn))
                .as_deref()
                == Some(id)
        {
            let XmlOut::Element(block) = element.get(txn, 0)? else {
                return None;
            };
            let XmlOut::Text(run) = block.get(txn, 0)? else {
                return None;
            };
            return Some(run);
        }
        element.children(txn).find_map(|child| match child {
            XmlOut::Element(inner) => walk(txn, &inner, id),
            _ => None,
        })
    }
    fragment.children(txn).find_map(|child| match child {
        XmlOut::Element(element) => walk(txn, &element, id),
        _ => None,
    })
}
