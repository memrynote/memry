//! #2845: a wiki link alone on its line carries `size`, `cover` and `preview`
//! as ordinary attributes of its `wikiLink` element. The core reads them as
//! `mark_attrs`, carries them through body edits, and never parses the
//! `<!-- link-card:{...} -->` marker line (desktop owns that conversion).

use std::collections::HashMap;
use std::sync::Arc;

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::blocks::{InlineRun, extract_blocks};
use memry_core::crdt::body_edit::{BlockEdit, apply};
use memry_core::crdt::canonical::canonical_fragment;
use memry_core::crdt::markdown_seed::plan;
use memry_core::crdt::registry::{Document, UpdateSink};
use yrs::{
    Any, Doc, ReadTxn as _, Transact as _, Xml as _, XmlElementPrelim, XmlFragment as _,
    XmlTextPrelim,
};

const NODE: char = '\u{FFFC}';

/// A paragraph `a` holding a text run `lead` (when non-empty) and a card link
/// written the way the editor writes it: `size` a string, the flags booleans.
fn card_body(lead: &str) -> Vec<u8> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    let container = group.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
    container.insert_attribute(&mut txn, "id", "a");
    let block = container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
    if !lead.is_empty() {
        block.push_back(&mut txn, XmlTextPrelim::new(lead));
    }
    let link = block.push_back(&mut txn, XmlElementPrelim::empty("wikiLink"));
    link.insert_attribute(&mut txn, "target", "Dune");
    link.insert_attribute(&mut txn, "size", "medium");
    link.insert_attribute(&mut txn, "cover", Any::Bool(true));
    link.insert_attribute(&mut txn, "preview", Any::Bool(true));
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}

fn opened(update: &[u8]) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new("device-link-card", sink)
        .get_or_open("abc123def456")
        .expect("open");
    document.apply_durable_update(update).expect("apply");
    document
}

fn runs(document: &Document) -> Vec<InlineRun> {
    extract_blocks(document)
        .expect("blocks")
        .into_iter()
        .find(|block| block.id.as_deref() == Some("a"))
        .expect("a")
        .inline
}

fn link(document: &Document) -> InlineRun {
    runs(document)
        .into_iter()
        .find(|run| run.marks.iter().any(|mark| mark == "wikiLink"))
        .expect("the link")
}

fn assert_card(run: &InlineRun) {
    let attr = |name: &str| run.mark_attrs.get(&format!("wikiLink.{name}")).cloned();
    assert_eq!(run.target.as_deref(), Some("Dune"));
    assert_eq!(attr("size").as_deref(), Some("medium"));
    assert_eq!(attr("cover").as_deref(), Some("true"));
    assert_eq!(attr("preview").as_deref(), Some("true"));
}

#[test]
fn the_display_attributes_reach_the_shell_as_text() {
    let document = opened(&card_body(""));
    assert_card(&link(&document));
}

#[test]
fn a_link_without_display_attributes_reads_with_none_of_them() {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    {
        let mut txn = doc.transact_mut();
        let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
        let container = group.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
        container.insert_attribute(&mut txn, "id", "a");
        let block = container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        let link = block.push_back(&mut txn, XmlElementPrelim::empty("wikiLink"));
        link.insert_attribute(&mut txn, "target", "Dune");
    }
    let update = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    let run = link(&opened(&update));
    for name in ["size", "cover", "preview"] {
        assert_eq!(run.mark_attrs.get(&format!("wikiLink.{name}")), None);
    }
}

#[test]
fn typing_around_a_card_link_keeps_its_attributes() {
    let document = opened(&card_body("see "));
    let shown = format!("see {NODE}");
    apply(
        &document,
        &BlockEdit::ReplaceText {
            block_id: "a".to_owned(),
            text: format!("see more {NODE}"),
            base: Some(shown),
        },
    )
    .expect("type around the link");
    assert_card(&link(&document));
}

#[test]
fn duplicating_a_block_copies_the_card_attributes_and_their_types() {
    let document = opened(&card_body(""));
    apply(
        &document,
        &BlockEdit::Duplicate {
            block_id: "a".to_owned(),
            new_block_id: "b".to_owned(),
        },
    )
    .expect("duplicate");
    let canonical = canonical_fragment(&document).expect("canonical");
    assert_eq!(canonical.matches("cover=true").count(), 2, "{canonical}");
    assert_eq!(canonical.matches("preview=true").count(), 2, "{canonical}");
    assert_eq!(
        canonical.matches("size=\"medium\"").count(),
        2,
        "{canonical}"
    );
}

#[test]
fn an_inserted_link_stores_the_flags_as_booleans() {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new("device-link-card", sink)
        .get_or_open("abc123def456")
        .expect("open");
    document
        .apply_durable_update(&{
            let doc = Doc::new();
            let fragment = doc.get_or_insert_xml_fragment("prosemirror");
            let mut txn = doc.transact_mut();
            let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
            let container = group.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
            container.insert_attribute(&mut txn, "id", "a");
            let block = container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
            block.push_back(&mut txn, XmlTextPrelim::new("x"));
            txn.encode_state_as_update_v1(&yrs::StateVector::default())
        })
        .expect("apply");
    apply(
        &document,
        &BlockEdit::InsertInline {
            block_id: "a".to_owned(),
            start: 0,
            end: 1,
            kind: "wikiLink".to_owned(),
            text: String::new(),
            attrs: HashMap::from([
                ("target".to_owned(), "Dune".to_owned()),
                ("size".to_owned(), "medium".to_owned()),
                ("cover".to_owned(), "true".to_owned()),
                ("preview".to_owned(), "true".to_owned()),
            ]),
        },
    )
    .expect("insert a card");
    let canonical = canonical_fragment(&document).expect("canonical");
    assert!(canonical.contains("cover=true"), "{canonical}");
    assert!(canonical.contains("preview=true"), "{canonical}");
    assert_card(&link(&document));
}

/// The core never turns the marker into attributes. A template that holds one
/// seeds it as literal text and is reported as a fallback; the link stays text.
#[test]
fn a_marker_line_seeds_as_literal_text_and_builds_no_link() {
    let marker = r#"<!-- link-card:{"size":"medium","cover":true,"preview":true} -->"#;
    let seeded = plan(&format!("{marker}\n[[Dune]]"));
    assert_eq!(seeded.fallbacks.len(), 1);
    assert_eq!(seeded.fallbacks[0].reason, "HTML");
    assert_eq!(seeded.fallbacks[0].lines, [marker, "[[Dune]]"]);
    let texts: Vec<_> = seeded
        .blocks
        .iter()
        .map(|block| format!("{:?}", block.content))
        .collect();
    assert!(texts[0].contains("link-card") && texts[1].contains("[[Dune]]"));
}
