//! The token rule over text, and the promotion of a body that holds tokens
//! as text, read back in the canonical form the vectors use.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use yrs::types::Attrs;
use yrs::{
    Any, ReadTxn as _, Text as _, TransactionMut, XmlElementPrelim, XmlFragment as _, XmlTextPrelim,
};

use super::*;
use crate::crdt::canonical::canonical_fragment;
use crate::crdt::registry::{Document, DocumentRegistry, UpdateSink};
use crate::crdt::text_extract::BODY_FRAGMENT;

/// `{anchorId:"dm_1", dateISO:"2026-08-14T09:00:00.000Z", hasTime:false,
/// dateFormat:"relative", remind:"none", timeFormat:"system"}`.
pub(crate) const DATE: &str = "((date:eyJhbmNob3JJZCI6ImRtXzEiLCJkYXRlSVNPIjoiMjAyNi0wOC0xNFQwOTowMDowMC4wMDBaIiwiaGFzVGltZSI6ZmFsc2UsImRhdGVGb3JtYXQiOiJyZWxhdGl2ZSIsInJlbWluZCI6Im5vbmUiLCJ0aW1lRm9ybWF0Ijoic3lzdGVtIn0))";
/// A token from before the `remind` enum: `remind: true`, which the strict
/// parse refuses and the salvage keeps as a plain date.
const LEGACY_DATE: &str = "((date:eyJhbmNob3JJZCI6ImRtXzIiLCJkYXRlSVNPIjoiMjAyNi0wOC0xNFQwOTozMDowMC4wMDBaIiwiaGFzVGltZSI6dHJ1ZSwicmVtaW5kIjp0cnVlLCJsZWFkIjoiMWQifQ))";
/// A legacy token whose date `Date.parse` refuses: it stays text.
const DATELESS: &str = "((date:eyJhbmNob3JJZCI6ImRtXzMiLCJkYXRlSVNPIjoic29vbiIsImhhc1RpbWUiOnRydWUsInJlbWluZCI6dHJ1ZX0))";
const LINK: &str = "((mention:https%3A%2F%2Fwww.example.com%2Fx))";

const DATE_NODE: &str = "element dateMention anchorId=\"dm_1\" dateFormat=\"relative\" dateISO=\"2026-08-14T09:00:00.000Z\" hasTime=false remind=\"none\" timeFormat=\"system\"";
const LINK_NODE: &str = "element linkMention domain=\"example.com\" favicon=\"\" siteName=\"\" title=\"\" url=\"https://www.example.com/x\"";

#[test]
fn text_is_cut_at_each_token_that_parses() {
    let text = format!("a {DATE} b {LINK}{DATELESS} ((date:)) ((mention:%ZZ))");
    let pieces = split(&text).expect("promoted");
    assert_eq!(pieces.len(), 5);
    assert_eq!(pieces[0], Piece::Text("a "));
    assert!(matches!(&pieces[1], Piece::Node(InlineToken::Date(date)) if date.anchor_id == "dm_1"));
    assert_eq!(pieces[2], Piece::Text(" b "));
    assert!(
        matches!(&pieces[3], Piece::Node(InlineToken::Link { domain, .. }) if domain == "example.com")
    );
    assert_eq!(
        pieces[4],
        Piece::Text(&text[text.find(DATELESS).expect("kept")..])
    );
    assert_eq!(split("no tokens"), None);
    assert_eq!(split(DATELESS), None);
}

#[test]
fn a_legacy_date_is_salvaged_without_its_reminder() {
    let Some(pieces) = split(LEGACY_DATE) else {
        panic!("salvaged");
    };
    let [Piece::Node(InlineToken::Date(date))] = pieces.as_slice() else {
        panic!("{pieces:?}");
    };
    assert_eq!((date.remind.as_str(), date.has_time), ("none", true));
    assert_eq!(date.time_format, "system");
}

fn document() -> (Arc<Document>, Arc<Mutex<usize>>) {
    let updates = Arc::new(Mutex::new(0));
    let sink: UpdateSink = {
        let updates = Arc::clone(&updates);
        Arc::new(move |_, _| *updates.lock().expect("lock") += 1)
    };
    let document = DocumentRegistry::new("device-promote", sink)
        .get_or_open("note-promote")
        .expect("open");
    (document, updates)
}

fn attrs(marks: &[&str]) -> Attrs {
    let mut attrs = Attrs::new();
    for mark in marks {
        attrs.insert(
            (*mark).into(),
            Any::Map(HashMap::<String, Any>::new().into()),
        );
    }
    attrs
}

/// One paragraph block in `group` whose single run is `chunks`.
fn paragraph(txn: &mut TransactionMut, group: &XmlElementRef, chunks: &[(&str, Attrs)]) {
    let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
    let block = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
    write_run(txn, &block, chunks);
}

fn write_run(txn: &mut TransactionMut, host: &XmlElementRef, chunks: &[(&str, Attrs)]) {
    let run = host.push_back(txn, XmlTextPrelim::new(""));
    for (text, attrs) in chunks {
        let end = run.len(txn);
        run.insert_with_attributes(txn, end, text, attrs.clone());
    }
}

/// A body seeded by an older build: tokens as text, in a paragraph with a
/// bold token and a code token beside a plain one, a code block, and a table
/// cell.
fn legacy_body(document: &Document) {
    document
        .write(|txn| {
            let fragment = txn.get_xml_fragment(BODY_FRAGMENT).expect("body");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            paragraph(
                txn,
                &group,
                &[
                    ("due ", attrs(&[])),
                    (&format!("{DATE} é "), attrs(&[])),
                    (&format!("{LINK} bold"), attrs(&["bold"])),
                    (&format!(" {LINK}"), attrs(&["code"])),
                    (&format!(" then {LINK}"), attrs(&[])),
                ],
            );
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let code = container.push_back(txn, XmlElementPrelim::empty("codeBlock"));
            code.push_back(txn, XmlTextPrelim::new(DATE));
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let table = container.push_back(txn, XmlElementPrelim::empty("table"));
            let row = table.push_back(txn, XmlElementPrelim::empty("tableRow"));
            let cell = row.push_back(txn, XmlElementPrelim::empty("tableCell"));
            let cell_paragraph = cell.push_back(txn, XmlElementPrelim::empty("tableParagraph"));
            write_run(txn, &cell_paragraph, &[(&format!("{LINK}!"), attrs(&[]))]);
        })
        .expect("write");
}

#[test]
fn a_legacy_body_is_promoted_once_and_styled_and_code_tokens_stay_text() {
    let (document, updates) = document();
    legacy_body(&document);
    let before = *updates.lock().expect("lock");

    assert!(document.write(promote_in).expect("promote"));
    assert_eq!(*updates.lock().expect("lock"), before + 1);
    let expected = [
        "0 element blockGroup".to_owned(),
        "1 element blockContainer".to_owned(),
        "2 element paragraph".to_owned(),
        "3 text \"due \"".to_owned(),
        format!("3 {DATE_NODE}"),
        "3 text \" é \"".to_owned(),
        format!("3 text \"{LINK} bold\" bold={{}}"),
        format!("3 text \" {LINK}\" code={{}}"),
        "3 text \" then \"".to_owned(),
        format!("3 {LINK_NODE}"),
        "1 element blockContainer".to_owned(),
        "2 element codeBlock".to_owned(),
        format!("3 text \"{DATE}\""),
        "1 element blockContainer".to_owned(),
        "2 element table".to_owned(),
        "3 element tableRow".to_owned(),
        "4 element tableCell".to_owned(),
        "5 element tableParagraph".to_owned(),
        format!("6 {LINK_NODE}"),
        "6 text \"!\"".to_owned(),
    ]
    .join("\n");
    assert_eq!(canonical_fragment(&document).expect("canonical"), expected);

    // Nothing left to promote: the second pass authors no update.
    assert!(!document.write(promote_in).expect("promote"));
    assert_eq!(*updates.lock().expect("lock"), before + 1);
    assert_eq!(canonical_fragment(&document).expect("canonical"), expected);
}

#[test]
fn a_token_in_a_default_colour_is_promoted_and_one_in_a_link_is_not() {
    let (document, _) = document();
    let colour = |value: &str| {
        let mut attrs = Attrs::new();
        let mut inner = HashMap::new();
        inner.insert("stringValue".to_owned(), Any::String(value.into()));
        attrs.insert("textColor".into(), Any::Map(inner.into()));
        attrs
    };
    let mut link = Attrs::new();
    let mut href = HashMap::new();
    href.insert("href".to_owned(), Any::String("https://a.com".into()));
    link.insert("link".into(), Any::Map(href.into()));
    document
        .write(|txn| {
            let fragment = txn.get_xml_fragment(BODY_FRAGMENT).expect("body");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            paragraph(txn, &group, &[(DATE, colour("default"))]);
            paragraph(txn, &group, &[(DATE, colour("red"))]);
            paragraph(txn, &group, &[(DATE, link)]);
        })
        .expect("write");
    assert!(document.write(promote_in).expect("promote"));
    let canonical = canonical_fragment(&document).expect("canonical");
    assert_eq!(
        canonical.matches("element dateMention").count(),
        1,
        "{canonical}"
    );
    assert!(canonical.starts_with(&format!(
        "0 element blockGroup\n1 element blockContainer\n2 element paragraph\n3 {DATE_NODE}"
    )));
}

#[test]
fn an_empty_or_token_free_body_writes_nothing() {
    let (document, updates) = document();
    assert!(!document.write(promote_in).expect("promote"));
    document
        .write(|txn| {
            let fragment = txn.get_xml_fragment(BODY_FRAGMENT).expect("body");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            paragraph(
                txn,
                &group,
                &[("plain ((date:x", attrs(&[])), (DATELESS, attrs(&[]))],
            );
        })
        .expect("write");
    let before = *updates.lock().expect("lock");
    assert!(!document.write(promote_in).expect("promote"));
    assert_eq!(*updates.lock().expect("lock"), before);
}
