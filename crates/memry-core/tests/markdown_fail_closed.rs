//! A document the converter cannot represent never reaches a vault file: the
//! write path answers `None` (the caller keeps the file) or states what it
//! dropped, and the live document is the same afterwards. The oracle outputs
//! for these shapes are pinned in `serialize-doc.json`
//! (`serialize-hex/doc-serialize/*`); this test drives them through the public
//! `Converter` API on a live document.

#![cfg(feature = "markdown")]

mod support;

use memry_core::crdt::registry::Document;
use memry_core::markdown::convert::restore::SerializeOptions;
use support::doc_case::{FRAGMENT, converter_for, open_document};
use yrs::types::xml::XmlIn;
use yrs::{TransactionMut, WriteTxn, Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim};

fn paragraph(text: &str) -> XmlElementPrelim {
    XmlElementPrelim::new("paragraph", [XmlIn::from(XmlTextPrelim::new(text))])
}

fn add_container(
    txn: &mut TransactionMut,
    parent: &impl XmlFragment,
    id: &str,
    child: XmlElementPrelim,
) {
    let block = parent.push_back(txn, XmlElementPrelim::empty("blockContainer"));
    block.insert_attribute(txn, "id", id);
    block.push_back(txn, child);
}

fn document(
    build: impl FnOnce(&mut yrs::TransactionMut, &yrs::XmlFragmentRef),
) -> std::sync::Arc<Document> {
    let document = open_document();
    document
        .write(|txn| {
            let fragment = txn.get_or_insert_xml_fragment(FRAGMENT);
            build(txn, &fragment);
        })
        .expect("write");
    document
}

fn markdown_of(document: &Document) -> Option<String> {
    let converter = converter_for(&serde_json::json!({}));
    converter
        .doc_to_markdown(document, FRAGMENT, &SerializeOptions::default())
        .map(|body| body.markdown)
}

/// The live document must be byte-identical after every read.
fn assert_untouched(document: &Document, check: impl FnOnce(&Document)) {
    let before = document.encode_state().expect("state");
    let vector = document.state_vector().expect("vector");
    check(document);
    assert_eq!(before, document.encode_state().expect("state"));
    assert_eq!(vector, document.state_vector().expect("vector"));
}

#[test]
fn an_unknown_node_is_reported_and_its_container_is_not_written() {
    let doc = document(|txn, fragment| {
        let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
        add_container(txn, &group, "a", XmlElementPrelim::empty("mysteryBlock"));
    });
    assert_untouched(&doc, |doc| {
        assert_eq!(markdown_of(doc), None);
        let converter = converter_for(&serde_json::json!({}));
        assert_eq!(
            converter.find_unrepresentable_nodes(doc, FRAGMENT),
            vec!["mysteryBlock".to_owned()]
        );
        assert!(converter.doc_to_canonical_markdown(doc, FRAGMENT).is_none());
    });
}

#[test]
fn an_unknown_node_beside_a_block_keeps_only_the_block() {
    let doc = document(|txn, fragment| {
        let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
        add_container(txn, &group, "a", XmlElementPrelim::empty("mysteryBlock"));
        add_container(txn, &group, "b", paragraph("kept"));
    });
    assert_untouched(&doc, |doc| {
        assert_eq!(markdown_of(doc).as_deref(), Some("kept"));
        let converter = converter_for(&serde_json::json!({}));
        assert_eq!(
            converter.find_unrepresentable_nodes(doc, FRAGMENT),
            vec!["mysteryBlock".to_owned()]
        );
    });
}

#[test]
fn a_childless_table_row_is_dropped_not_written_as_a_broken_table() {
    let doc = document(|txn, fragment| {
        let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
        let table =
            XmlElementPrelim::new("table", [XmlIn::from(XmlElementPrelim::empty("tableRow"))]);
        add_container(txn, &group, "a", table);
        add_container(txn, &group, "b", paragraph("after"));
    });
    assert_untouched(&doc, |doc| {
        assert_eq!(markdown_of(doc).as_deref(), Some("after"));
    });
}

#[test]
fn a_root_block_container_beside_the_block_group_is_ignored() {
    let doc = document(|txn, fragment| {
        let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
        add_container(txn, &group, "a", paragraph("in"));
        add_container(txn, fragment, "b", paragraph("loose"));
    });
    assert_untouched(&doc, |doc| {
        assert_eq!(markdown_of(doc).as_deref(), Some("in"));
    });
}

#[test]
fn text_at_the_fragment_root_fails_closed() {
    let doc = document(|txn, fragment| {
        fragment.push_back(txn, XmlTextPrelim::new("loose"));
    });
    assert_untouched(&doc, |doc| {
        assert_eq!(markdown_of(doc), None);
        let converter = converter_for(&serde_json::json!({}));
        assert!(converter.blocks(doc, FRAGMENT).is_none());
    });
}
