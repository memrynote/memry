//! `BlockEdit::ReplaceText`, and `SetMark` past an inline node.
//!
//! `ReplaceText` is how a shell edits a block that holds formatting or inline
//! nodes: in place, keeping everything outside the edited span, so a formatted
//! block stays editable and a peer's concurrent typing survives the merge.

use std::collections::HashMap;
use std::sync::Arc;

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::blocks::{InlineRun, extract_blocks};
use memry_core::crdt::body_edit::{BlockEdit, apply};
use memry_core::crdt::registry::{Document, UpdateSink};
use yrs::updates::decoder::Decode as _;
use yrs::{
    Doc, ReadTxn as _, Text as _, Transact as _, Xml as _, XmlElementPrelim, XmlFragment as _,
    XmlTextPrelim,
};

const NODE: char = '\u{FFFC}';

fn opened_as(device: &str, update: &[u8]) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new(device, sink);
    let document = registry.get_or_open("abc123def456").expect("open");
    document.apply_durable_update(update).expect("apply");
    document
}

fn opened(update: &[u8]) -> Arc<Document> {
    opened_as("device-replace-text", update)
}

/// One paragraph `a` holding `text`.
fn paragraph(text: &str) -> Vec<u8> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    let container = group.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
    container.insert_attribute(&mut txn, "id", "a");
    let block = container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
    if !text.is_empty() {
        block.insert(&mut txn, 0, XmlTextPrelim::new(text));
    }
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}

fn runs(document: &Document) -> Vec<InlineRun> {
    extract_blocks(document)
        .expect("blocks")
        .into_iter()
        .find(|block| block.id.as_deref() == Some("a"))
        .expect("a")
        .inline
}

/// The block as a shell shows it: text, and each inline node as U+FFFC.
fn shown(document: &Document) -> String {
    runs(document)
        .iter()
        .map(|run| {
            if run.text.is_empty() && !run.marks.is_empty() {
                NODE.to_string()
            } else {
                run.text.clone()
            }
        })
        .collect()
}

/// The text carrying `mark`, run by run.
fn marked(document: &Document, mark: &str) -> Vec<String> {
    runs(document)
        .into_iter()
        .filter(|run| run.marks.iter().any(|name| name == mark))
        .map(|run| run.text)
        .collect()
}

fn replace(document: &Document, text: &str) {
    apply(
        document,
        &BlockEdit::ReplaceText {
            block_id: "a".to_owned(),
            text: text.to_owned(),
            base: None,
        },
    )
    .expect("replace text");
}

fn bold(document: &Document, start: u32, end: u32) {
    apply(
        document,
        &BlockEdit::SetMark {
            block_id: "a".to_owned(),
            start,
            end,
            mark: "bold".to_owned(),
            value: None,
        },
    )
    .expect("bold");
}

fn wiki_link(document: &Document, at: u32, target: &str) {
    apply(
        document,
        &BlockEdit::InsertInline {
            block_id: "a".to_owned(),
            start: at,
            end: at,
            kind: "wikiLink".to_owned(),
            text: String::new(),
            attrs: HashMap::from([
                ("target".to_owned(), target.to_owned()),
                ("alias".to_owned(), String::new()),
            ]),
        },
    )
    .expect("wiki link");
}

#[test]
fn typing_after_a_bold_word_keeps_the_bold_word_bold() {
    let document = opened(&paragraph("hello world"));
    bold(&document, 0, 5);
    replace(&document, "hello big world");

    assert_eq!(shown(&document), "hello big world");
    assert_eq!(marked(&document, "bold"), vec!["hello"]);
}

#[test]
fn typing_at_the_end_of_a_bold_word_continues_the_bold() {
    let document = opened(&paragraph("hello world"));
    bold(&document, 0, 5);
    replace(&document, "hellooo world");

    assert_eq!(marked(&document, "bold"), vec!["hellooo"]);
}

#[test]
fn a_delete_across_a_mark_boundary_keeps_both_sides_formatting() {
    let document = opened(&paragraph("hello world"));
    bold(&document, 0, 5);
    replace(&document, "helworld");

    assert_eq!(shown(&document), "helworld");
    assert_eq!(marked(&document, "bold"), vec!["hel"]);
}

#[test]
fn text_typed_after_a_wiki_link_lands_after_it_and_keeps_the_link() {
    let document = opened(&paragraph("see "));
    wiki_link(&document, 4, "Dune");
    assert_eq!(shown(&document), format!("see {NODE}"));

    replace(&document, &format!("see {NODE} now"));
    assert_eq!(shown(&document), format!("see {NODE} now"));

    replace(&document, &format!("read {NODE} now"));
    assert_eq!(shown(&document), format!("read {NODE} now"));
    let link = runs(&document)
        .into_iter()
        .find(|run| run.marks.iter().any(|mark| mark == "wikiLink"))
        .expect("the link survives");
    assert_eq!(
        link.mark_attrs.get("wikiLink.target").map(String::as_str),
        Some("Dune")
    );
}

#[test]
fn deleting_the_placeholder_removes_the_node_and_nothing_else() {
    let document = opened(&paragraph("see "));
    wiki_link(&document, 4, "Dune");
    replace(&document, &format!("see {NODE} now"));

    replace(&document, "see  now");
    assert_eq!(shown(&document), "see  now");
    assert!(marked(&document, "wikiLink").is_empty());
}

#[test]
fn text_typed_before_a_date_mention_lands_before_it() {
    // The mention replaces the whole of "x", leaving only the node.
    let document = opened(&paragraph("x"));
    apply(
        &document,
        &BlockEdit::InsertInline {
            block_id: "a".to_owned(),
            start: 0,
            end: 1,
            kind: "dateMention".to_owned(),
            text: String::new(),
            attrs: HashMap::from([
                ("anchorId".to_owned(), "dm_1".to_owned()),
                ("dateISO".to_owned(), "2099-01-01T09:00:00.000Z".to_owned()),
                ("hasTime".to_owned(), "false".to_owned()),
            ]),
        },
    )
    .expect("date mention");
    let before = shown(&document);
    let wanted = format!("due {before}");
    replace(&document, &wanted);
    assert_eq!(shown(&document), wanted);

    let date = runs(&document)
        .into_iter()
        .find(|run| run.marks.iter().any(|mark| mark == "dateMention"))
        .expect("the date survives");
    // Stored as a boolean, which the reader spells `false`, never the string
    // "false" a truthiness test would read as set.
    assert_eq!(
        date.mark_attrs
            .get("dateMention.hasTime")
            .map(String::as_str),
        Some("false")
    );
}

#[test]
fn a_mark_reaches_text_after_an_inline_node() {
    let document = opened(&paragraph("see "));
    wiki_link(&document, 4, "Dune");
    replace(&document, &format!("see {NODE} later"));

    // "see " is 4 bytes and the link displays nothing, so " later" is 4..10.
    bold(&document, 5, 10);
    assert_eq!(marked(&document, "bold"), vec!["later"]);
}

#[test]
fn a_concurrent_edit_elsewhere_in_a_formatted_block_survives_the_merge() {
    let base = opened(&paragraph("hello world"));
    bold(&base, 0, 5);
    let state = base.encode_state().expect("state");

    let here = opened_as("device-here", &state);
    let there = opened_as("device-there", &state);

    replace(&here, "hello brave world");
    replace(&there, "hello world!");

    let from_here = here.encode_state().expect("here");
    let from_there = there.encode_state().expect("there");
    here.apply_durable_update(&from_there).expect("merge there");
    there.apply_durable_update(&from_here).expect("merge here");

    assert_eq!(shown(&here), "hello brave world!");
    assert_eq!(shown(&there), "hello brave world!");
    assert_eq!(marked(&here, "bold"), vec!["hello"]);
}

#[test]
fn an_unchanged_text_writes_nothing() {
    let document = opened(&paragraph("hello"));
    bold(&document, 0, 5);
    let before = document.encode_state().expect("before");
    replace(&document, "hello");
    assert_eq!(document.encode_state().expect("after"), before);
}

fn replace_from(document: &Document, base: &str, text: &str) {
    apply(
        document,
        &BlockEdit::ReplaceText {
            block_id: "a".to_owned(),
            text: text.to_owned(),
            base: Some(base.to_owned()),
        },
    )
    .expect("replace text from base");
}

fn mark(document: &Document, start: u32, end: u32, name: &str) {
    apply(
        document,
        &BlockEdit::SetMark {
            block_id: "a".to_owned(),
            start,
            end,
            mark: name.to_owned(),
            value: None,
        },
    )
    .expect("mark");
}

/// One paragraph `a`: `before`, a `hardBreak`, then `after`, as desktop
/// writes a Shift-Enter line break.
fn paragraph_with_break(before: &str, after: &str) -> Vec<u8> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    let container = group.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
    container.insert_attribute(&mut txn, "id", "a");
    let block = container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
    block.insert(&mut txn, 0, XmlTextPrelim::new(before));
    block.insert(&mut txn, 1, XmlElementPrelim::empty("hardBreak"));
    block.insert(&mut txn, 2, XmlTextPrelim::new(after));
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}

/// Block `a`'s content children in order: each text run's string, and each
/// element as `<tag>`.
fn layout(document: &Document) -> Vec<String> {
    let doc = Doc::new();
    let state = document.encode_state().expect("state");
    doc.transact_mut()
        .apply_update(yrs::Update::decode_v1(&state).expect("decode"))
        .expect("apply");
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let txn = doc.transact();
    let yrs::XmlOut::Element(group) = fragment.get(&txn, 0).expect("group") else {
        panic!("no group")
    };
    let yrs::XmlOut::Element(container) = group.get(&txn, 0).expect("container") else {
        panic!("no container")
    };
    let yrs::XmlOut::Element(block) = container.get(&txn, 0).expect("block") else {
        panic!("no block")
    };
    block
        .children(&txn)
        .map(|child| match child {
            yrs::XmlOut::Text(run) => run
                .diff(&txn, yrs::types::text::YChange::identity)
                .into_iter()
                .map(|chunk| match chunk.insert {
                    yrs::Out::Any(yrs::Any::String(piece)) => piece.to_string(),
                    _ => String::new(),
                })
                .collect(),
            yrs::XmlOut::Element(element) => format!("<{}>", element.tag()),
            yrs::XmlOut::Fragment(_) => "<fragment>".to_owned(),
        })
        .collect()
}

#[test]
fn typing_before_a_hard_break_keeps_the_break_and_both_lines_marks() {
    let document = opened(&paragraph_with_break("hello", "world"));
    // A hard break displays nothing, so "world" is 5..10 in the core's offsets.
    bold(&document, 0, 5);
    mark(&document, 5, 10, "italic");
    // The shell never sees the break: `extract_blocks` skips it.
    assert_eq!(shown(&document), "helloworld");

    replace(&document, "hello!world");

    assert_eq!(layout(&document), vec!["hello!", "<hardBreak>", "world"]);
    assert_eq!(marked(&document, "bold"), vec!["hello!"]);
    assert_eq!(marked(&document, "italic"), vec!["world"]);
}

#[test]
fn typing_after_a_hard_break_keeps_the_break_and_both_lines_marks() {
    let document = opened(&paragraph_with_break("hello", "world"));
    bold(&document, 0, 5);
    mark(&document, 5, 10, "italic");

    replace(&document, "helloworld, again");

    assert_eq!(
        layout(&document),
        vec!["hello", "<hardBreak>", "world, again"]
    );
    assert_eq!(marked(&document, "bold"), vec!["hello"]);
    assert_eq!(marked(&document, "italic"), vec!["world, again"]);
}

#[test]
fn a_delete_spanning_a_hard_break_never_removes_it() {
    let document = opened(&paragraph_with_break("hello", "world"));
    replace(&document, "helrld");
    assert_eq!(layout(&document), vec!["hel", "<hardBreak>", "rld"]);

    replace(&document, "");
    assert!(layout(&document).contains(&"<hardBreak>".to_owned()));
}

#[test]
fn a_replace_from_a_stale_base_keeps_the_peers_merged_edit() {
    // The shell read "hello world" and the user typed " brave" while a peer's
    // "!" merged in underneath: the live block is "hello world!".
    let document = opened(&paragraph("hello world"));
    bold(&document, 0, 5);
    replace(&document, "hello world!");

    replace_from(&document, "hello world", "hello brave world");

    assert_eq!(shown(&document), "hello brave world!");
    assert_eq!(marked(&document, "bold"), vec!["hello"]);
}

#[test]
fn a_replace_from_a_stale_base_keeps_a_peers_edit_before_the_users() {
    let document = opened(&paragraph("hello world"));
    replace(&document, "oh hello world");

    replace_from(&document, "hello world", "hello world, again");

    assert_eq!(shown(&document), "oh hello world, again");
}

#[test]
fn a_users_delete_keeps_a_peers_insert_inside_it() {
    let document = opened(&paragraph("hello world"));
    // The peer typed "big " inside " world", which the user deleted.
    replace(&document, "hello big world");

    replace_from(&document, "hello world", "hello");

    // What the CRDT merge of the two edits gives: the delete takes the text
    // it covered, the peer's insert survives.
    assert_eq!(shown(&document), "hellobig ");
}

#[test]
fn a_replace_whose_base_is_the_live_block_is_an_ordinary_replace() {
    let document = opened(&paragraph("hello world"));
    replace_from(&document, "hello world", "hello there");
    assert_eq!(shown(&document), "hello there");
}
