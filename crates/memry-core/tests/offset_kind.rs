//! The registry's documents count text in UTF-8 bytes (#3601), and every
//! index-based write agrees with that unit on non-ASCII text.
//!
//! The offset kind never reaches the wire: an update encodes item clocks in
//! UTF-16 whatever the kind, so a bytes document, a UTF-16 document (the unit
//! Yjs uses on desktop) and a document from before #3601 merge with each other.

use std::collections::HashMap;
use std::sync::Arc;

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::blocks::{Block, extract_blocks};
use memry_core::crdt::body_edit::{BlockEdit, apply};
use memry_core::crdt::canonical::canonical_fragment;
use memry_core::crdt::registry::{Document, UpdateSink};
use yrs::updates::decoder::Decode as _;
use yrs::{
    Any, Doc, OffsetKind, Options, ReadTxn as _, StateVector, Text as _, Transact as _,
    TransactionMut, Update, Xml as _, XmlElementPrelim, XmlFragment as _, XmlOut, XmlTextPrelim,
    XmlTextRef,
};

/// Turkish, an emoji with a skin-tone modifier, CJK, and combining marks.
const SAMPLES: [&str; 4] = ["çağrı ışık", "a🙂b👍🏽c", "漢字かな", "e\u{301}a\u{308}o"];

fn registry_document(device: &str) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    DocumentRegistry::new(device, sink)
        .get_or_open("abc123def456")
        .expect("open")
}

/// One paragraph `p` holding `text`, authored on a document of `kind`.
fn paragraph_body(kind: OffsetKind, text: &str) -> Doc {
    let doc = Doc::with_options(Options {
        client_id: yrs::ClientID::new(1),
        offset_kind: kind,
        ..Options::default()
    });
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    {
        let mut txn = doc.transact_mut();
        let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
        let container = group.push_back(&mut txn, XmlElementPrelim::empty("blockContainer"));
        container.insert_attribute(&mut txn, "id", "p");
        let paragraph = container.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        paragraph.push_back(&mut txn, XmlTextPrelim::new(text));
    }
    doc
}

fn state(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn merge(doc: &Doc, update: &[u8]) {
    doc.transact_mut()
        .apply_update(Update::decode_v1(update).expect("decode"))
        .expect("apply");
}

fn block_p(document: &Document) -> Block {
    extract_blocks(document)
        .expect("blocks")
        .into_iter()
        .find(|block| block.id.as_deref() == Some("p"))
        .expect("block p")
}

fn text_of(block: &Block) -> String {
    block.inline.iter().map(|run| run.text.as_str()).collect()
}

#[test]
fn the_registry_counts_bytes() {
    let document = registry_document("device-kind");
    let kind = document
        .write(|txn| txn.doc().offset_kind())
        .expect("write");
    assert_eq!(kind, OffsetKind::Bytes);
}

/// `insert_inline` rebuilds the run's formatted tail after the node. It
/// counted the tail in characters against a document that counts bytes, so a
/// mention typed after "çağrı " lost text and moved the bold.
#[test]
fn an_inline_node_after_non_ascii_text_keeps_the_formatted_tail() {
    for sample in SAMPLES {
        let document = registry_document("device-inline");
        let text = format!("{sample}|{sample}|{sample}");
        document
            .apply_durable_update(&state(&paragraph_body(OffsetKind::Bytes, &text)))
            .expect("base");
        let middle = (sample.len() + 1) as u32;
        apply(
            &document,
            &BlockEdit::SetMark {
                block_id: "p".to_owned(),
                start: middle,
                end: middle + sample.len() as u32,
                mark: "bold".to_owned(),
                value: None,
            },
        )
        .expect("bold");
        apply(
            &document,
            &BlockEdit::InsertInline {
                block_id: "p".to_owned(),
                start: sample.len() as u32,
                end: sample.len() as u32,
                kind: "dateMention".to_owned(),
                text: "yarın".to_owned(),
                attrs: HashMap::from([("date".to_owned(), "2026-09-23".to_owned())]),
            },
        )
        .expect("inline");

        let block = block_p(&document);
        assert_eq!(
            text_of(&block),
            format!("{sample}yarın|{sample}|{sample}"),
            "{sample:?}"
        );
        let bold: Vec<&str> = block
            .inline
            .iter()
            .filter(|run| run.marks.iter().any(|mark| mark == "bold"))
            .map(|run| run.text.as_str())
            .collect();
        assert_eq!(
            bold,
            [sample],
            "{sample:?}: the bold must stay on the middle copy"
        );
    }
}

/// An embed in the run takes one position in either offset kind, so the tail
/// walk steps over it as one: a mention typed after "çağrı" + embed + "çağrı"
/// keeps the "|çağrı" that followed the cursor.
#[test]
fn an_inline_node_after_an_embed_and_non_ascii_text_keeps_the_formatted_tail() {
    let sample = "çağrı";
    let document = registry_document("device-embed");
    let base = paragraph_body(OffsetKind::Bytes, &format!("{sample}{sample}|{sample}"));
    insert_embed_into_run(&base, sample.len() as u32);
    document.apply_durable_update(&state(&base)).expect("base");
    // The embed sits at `sample.len()`, so the second copy ends one further on.
    let cursor = (2 * sample.len() + 1) as u32;
    apply(
        &document,
        &BlockEdit::InsertInline {
            block_id: "p".to_owned(),
            start: cursor,
            end: cursor,
            kind: "dateMention".to_owned(),
            text: "yarın".to_owned(),
            attrs: HashMap::from([("date".to_owned(), "2026-09-23".to_owned())]),
        },
    )
    .expect("inline");

    let runs: Vec<String> = block_p(&document)
        .inline
        .into_iter()
        .map(|run| run.text)
        .collect();
    assert_eq!(runs.last().map(String::as_str), Some("|çağrı"), "{runs:?}");
}

/// An embed after the cursor belongs to the tail the run is split into: a
/// mention typed before it must not delete it (#4255).
#[test]
fn an_inline_node_before_an_embed_keeps_the_embed_and_its_marks() {
    let sample = "çağrı";
    let document = registry_document("device-embed-tail");
    let base = paragraph_body(OffsetKind::Bytes, &format!("{sample}|{sample}"));
    insert_embed_into_run(&base, (sample.len() + 1) as u32);
    document.apply_durable_update(&state(&base)).expect("base");
    apply(
        &document,
        &BlockEdit::SetMark {
            block_id: "p".to_owned(),
            start: sample.len() as u32,
            end: (2 * sample.len() + 2) as u32,
            mark: "bold".to_owned(),
            value: None,
        },
    )
    .expect("bold");
    apply(
        &document,
        &BlockEdit::InsertInline {
            block_id: "p".to_owned(),
            start: sample.len() as u32,
            end: sample.len() as u32,
            kind: "dateMention".to_owned(),
            text: "yarın".to_owned(),
            attrs: HashMap::from([("date".to_owned(), "2026-09-23".to_owned())]),
        },
    )
    .expect("inline");

    assert_eq!(
        paragraph_children(&document),
        ["çağrı", "<dateMention>", "*|*", "*<embed>*", "*çağrı*",]
    );
}

/// An offset inside a character is refused, and the text is left as it was,
/// instead of splitting the character's bytes (#4255).
#[test]
fn an_offset_inside_a_character_is_refused_and_changes_nothing() {
    for (sample, inside) in [("çağrı", 1u32), ("a🙂b", 2), ("漢字", 4), ("e\u{301}", 2)] {
        let document = registry_document("device-boundary");
        document
            .apply_durable_update(&state(&paragraph_body(OffsetKind::Bytes, sample)))
            .expect("base");
        let before = canonical(&document);
        let len = sample.len() as u32;
        let edits = [
            BlockEdit::InsertInline {
                block_id: "p".to_owned(),
                start: inside,
                end: inside,
                kind: "hashTag".to_owned(),
                text: String::new(),
                attrs: HashMap::from([("tag".to_owned(), "x".to_owned())]),
            },
            BlockEdit::InsertInline {
                block_id: "p".to_owned(),
                start: 0,
                end: inside,
                kind: "hashTag".to_owned(),
                text: String::new(),
                attrs: HashMap::from([("tag".to_owned(), "x".to_owned())]),
            },
            BlockEdit::SetMark {
                block_id: "p".to_owned(),
                start: inside,
                end: len,
                mark: "bold".to_owned(),
                value: None,
            },
            BlockEdit::SetMark {
                block_id: "p".to_owned(),
                start: 0,
                end: inside,
                mark: "bold".to_owned(),
                value: None,
            },
            BlockEdit::RemoveMark {
                block_id: "p".to_owned(),
                start: inside,
                end: len,
                mark: "bold".to_owned(),
            },
        ];
        for edit in edits {
            let error = apply(&document, &edit).expect_err(&format!("{sample:?} {edit:?}"));
            assert!(
                error.to_string().contains("inside a character"),
                "{sample:?} {edit:?}: {error}"
            );
            assert_eq!(canonical(&document), before, "{sample:?} {edit:?}");
        }
    }
}

/// A selection replacing non-ASCII text in the middle of a run.
#[test]
fn an_inline_node_replacing_a_non_ascii_range_removes_exactly_that_range() {
    for sample in SAMPLES {
        let document = registry_document("device-range");
        let text = format!("<{sample}>");
        document
            .apply_durable_update(&state(&paragraph_body(OffsetKind::Bytes, &text)))
            .expect("base");
        apply(
            &document,
            &BlockEdit::InsertInline {
                block_id: "p".to_owned(),
                start: 1,
                end: 1 + sample.len() as u32,
                kind: "hashTag".to_owned(),
                text: String::new(),
                attrs: HashMap::from([("tag".to_owned(), "etiket".to_owned())]),
            },
        )
        .expect("inline");
        assert_eq!(text_of(&block_p(&document)), "<>", "{sample:?}");
    }
}

#[test]
fn replace_text_edits_non_ascii_text_in_place() {
    for sample in SAMPLES {
        let document = registry_document("device-replace");
        document
            .apply_durable_update(&state(&paragraph_body(
                OffsetKind::Bytes,
                &format!("{sample} {sample}"),
            )))
            .expect("base");
        let wanted = format!("{sample}–{sample}{sample}");
        apply(
            &document,
            &BlockEdit::ReplaceText {
                block_id: "p".to_owned(),
                text: wanted.clone(),
                base: None,
            },
        )
        .expect("replace");
        assert_eq!(text_of(&block_p(&document)), wanted, "{sample:?}");
    }
}

/// A bytes document (the registry) and a UTF-16 document (desktop's Yjs unit)
/// edit the same non-ASCII text concurrently, and a third document edits it by
/// bytes with the default offset kind, which is bytes too. All three converge
/// once they swap updates. The bytes and UTF-16 pair is the evidence.
#[test]
fn bytes_and_utf16_documents_merge_concurrent_non_ascii_edits() {
    for sample in SAMPLES {
        let text = format!("{sample} {sample}");
        let base = state(&paragraph_body(OffsetKind::Bytes, &text));

        let registry = registry_document("device-merge");
        registry.apply_durable_update(&base).expect("base");

        let desktop = Doc::with_options(Options {
            client_id: yrs::ClientID::new(2),
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        merge(&desktop, &base);
        let bytes_peer = Doc::with_client_id(3);
        merge(&bytes_peer, &base);

        // Registry: bold over the second copy, by bytes.
        let second = (sample.len() + 1) as u32;
        apply(
            &registry,
            &BlockEdit::SetMark {
                block_id: "p".to_owned(),
                start: second,
                end: second + sample.len() as u32,
                mark: "bold".to_owned(),
                value: None,
            },
        )
        .expect("bold");
        // Desktop: Yjs inserts after the first copy, by UTF-16 units.
        let utf16 = sample.encode_utf16().count() as u32;
        insert_into_run(&desktop, utf16, "!");
        // Default-kind document: an insert before the second copy, by bytes.
        insert_into_run(&bytes_peer, second, "?");

        let updates = [
            registry.encode_state().expect("registry state"),
            state(&desktop),
            state(&bytes_peer),
        ];
        let merged: Vec<String> = (0..3)
            .map(|index| {
                let target = registry_document(&format!("device-check-{index}"));
                for update in &updates {
                    target.apply_durable_update(update).expect("merge");
                }
                assert_eq!(
                    text_of(&block_p(&target)),
                    format!("{sample}! ?{sample}"),
                    "{sample:?}"
                );
                canonical_fragment(&target).expect("canonical")
            })
            .collect();
        assert!(
            merged.windows(2).all(|pair| pair[0] == pair[1]),
            "{sample:?}"
        );
        let bold: Vec<String> = block_p(&registry_after(&updates))
            .inline
            .into_iter()
            .filter(|run| run.marks.iter().any(|mark| mark == "bold"))
            .map(|run| run.text)
            .collect();
        assert_eq!(bold, [sample.to_owned()], "{sample:?}");
    }
}

fn registry_after(updates: &[Vec<u8>]) -> Arc<Document> {
    let document = registry_document("device-after");
    for update in updates {
        document.apply_durable_update(update).expect("merge");
    }
    document
}

fn canonical(document: &Document) -> String {
    canonical_fragment(document).expect("canonical")
}

/// Paragraph `p`'s children: each text chunk (`*bold*`), each embed as
/// `<embed>`, and each inline node as `<tag>`.
fn paragraph_children(document: &Document) -> Vec<String> {
    let doc = Doc::new();
    merge(&doc, &document.encode_state().expect("state"));
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let txn = doc.transact();
    let mut node = fragment.get(&txn, 0);
    for _ in 0..2 {
        node = match node {
            Some(XmlOut::Element(element)) => element.get(&txn, 0),
            other => panic!("unexpected layout: {other:?}"),
        };
    }
    let Some(XmlOut::Element(paragraph)) = node else {
        panic!("no paragraph");
    };
    let mut out = Vec::new();
    for child in paragraph.children(&txn) {
        match child {
            XmlOut::Text(run) => {
                for chunk in run.diff(&txn, yrs::types::text::YChange::identity) {
                    let shown = match &chunk.insert {
                        yrs::Out::Any(Any::String(text)) => text.to_string(),
                        _ => "<embed>".to_owned(),
                    };
                    let bold = chunk
                        .attributes
                        .is_some_and(|attrs| attrs.contains_key("bold"));
                    out.push(if bold { format!("*{shown}*") } else { shown });
                }
            }
            XmlOut::Element(element) => out.push(format!("<{}>", element.tag())),
            XmlOut::Fragment(_) => {}
        }
    }
    out
}

/// Runs `edit` on paragraph `p`'s text run.
fn with_run(doc: &Doc, edit: impl FnOnce(&mut TransactionMut, &XmlTextRef)) {
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let mut node = fragment.get(&txn, 0);
    for _ in 0..3 {
        node = match node {
            Some(XmlOut::Element(element)) => element.get(&txn, 0),
            other => panic!("unexpected layout: {other:?}"),
        };
    }
    let Some(XmlOut::Text(run)) = node else {
        panic!("no text run");
    };
    edit(&mut txn, &run);
}

/// Inserts `text` at `index`, in `doc`'s own unit, into paragraph `p`'s run.
fn insert_into_run(doc: &Doc, index: u32, text: &str) {
    with_run(doc, |txn, run| run.insert(txn, index, text));
}

/// Inserts an embed at `index`, in `doc`'s own unit, into paragraph `p`'s run.
fn insert_embed_into_run(doc: &Doc, index: u32) {
    with_run(doc, |txn, run| {
        run.insert_embed(txn, index, Any::Bool(true));
    });
}
