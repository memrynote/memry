//! A forked body never reaches the file (#2536): a body seeded from its file beside the server
//! body it was owed holds two roots, and once the editor deleted one, what is left can be empty.
//! The file is kept and the fork logged; nothing heals the body.

use memry_core::domain::write_back::Fork;
use yrs::{GetString as _, Text as _, XmlElementPrelim, XmlFragment as _, XmlOut, XmlTextPrelim};

use super::*;

/// Appends a root block group holding one paragraph of `text`: a second seed's root.
fn push_root(txn: &mut yrs::TransactionMut, text: &str) {
    let fragment = yrs::WriteTxn::get_or_insert_xml_fragment(txn, BODY_FRAGMENT);
    let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
    let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
    let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
    paragraph.push_back(txn, XmlTextPrelim::new(text));
}

/// Empties the text of the body's first paragraph, in the root it has.
fn clear_first_paragraph(txn: &mut yrs::TransactionMut) {
    let fragment = yrs::WriteTxn::get_or_insert_xml_fragment(txn, BODY_FRAGMENT);
    let child = |node: Option<XmlOut>| match node {
        Some(XmlOut::Element(element)) => element,
        other => panic!("not an element: {other:?}"),
    };
    let group = child(fragment.get(txn, 0));
    let paragraph = child(child(group.get(txn, 0)).get(txn, 0));
    let Some(XmlOut::Text(text)) = paragraph.get(txn, 0) else {
        panic!("a paragraph with text");
    };
    let len = text.get_string(txn).encode_utf16().count() as u32;
    text.remove_range(txn, 0, len);
}

fn feed_outside_edit(f: &Fixture, id: &str) -> FeedOutcome {
    let input = FeedInput {
        note_id: id,
        markdown: "an outside edit\n",
        note_path: Some("n.md"),
        writing: None,
        frontmatter: None,
        embeds: None,
    };
    f.vault
        .external_feed(f.store.clone())
        .unwrap()
        .feed(&converter_for(None), input)
        .unwrap()
}

/// Two roots: the write would keep the first root's text and the editor deletes the other. A
/// feed of the file would replace both, so it is refused too.
#[test]
fn a_body_with_two_roots_keeps_its_file_and_refuses_a_feed() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    f.edit_from_sync(&id, |txn| push_root(txn, "the server's words"));
    let outcome = f.run(&id);
    assert_kept(
        &mut f,
        &outcome,
        Keep::Forked(Fork::Roots),
        "n.md",
        "first words\n",
    );
    let fed = feed_outside_edit(&f, &id);
    assert!(matches!(fed, FeedOutcome::Refused(_)), "{fed:?}");
}

/// The root the file was written from was deleted, and the root left holds no text.
#[test]
fn a_root_replaced_by_an_empty_one_keeps_the_file() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    f.edit_from_sync(&id, |txn| {
        let fragment = yrs::WriteTxn::get_or_insert_xml_fragment(txn, BODY_FRAGMENT);
        fragment.remove_range(txn, 0, 1);
        push_root(txn, "");
    });
    let outcome = f.run(&id);
    assert_kept(
        &mut f,
        &outcome,
        Keep::Forked(Fork::RootReplaced),
        "n.md",
        "first words\n",
    );
}

/// A user who clears a note, here or on another device, keeps its root: the file is emptied.
#[test]
fn a_note_cleared_in_its_root_is_written_empty() {
    for way in 0..2 {
        let mut f = fixture();
        let id = f.adopt("n.md", "first words\n");
        match way {
            0 => f.edit_in_app(&id, ""),
            _ => f.edit_from_sync(&id, clear_first_paragraph),
        }
        let outcome = f.run(&id);
        let written = assert_wrote(&mut f, &outcome, "n.md");
        assert_eq!(written.trim(), "", "way {way}");
    }
}

/// With no mark of the row's stamp the log cannot say the root is the file's: an empty body is
/// not written over the text.
#[test]
fn an_empty_body_whose_root_the_log_cannot_place_keeps_the_file() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    f.sql("DELETE FROM note_file_marks WHERE note_id = ?1", &id);
    f.edit_in_app(&id, "");
    let outcome = f.run(&id);
    assert_kept(
        &mut f,
        &outcome,
        Keep::Forked(Fork::RootReplaced),
        "n.md",
        "first words\n",
    );
}
