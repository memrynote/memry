//! The block walk, held to the text walk it must never disagree with.
//!
//! `extract_text` is pinned byte-for-byte to the committed `text-extract`
//! class, because SC-010's cross-shell digest is only meaningful once both
//! ports agree. `extract_blocks` is a second, richer walk of the same
//! fragment, and a second walk is exactly how two readings of one document
//! drift apart: a block type one knows and the other does not is silent until
//! a user's note renders with a paragraph missing.
//!
//! So the guarantee is asserted rather than assumed. For every committed case,
//! rendering the blocks the way `extract_text` renders the document has to
//! produce the same bytes. The inputs are the class's own; nothing here
//! recomputes an expectation.

mod support;

use std::collections::HashMap;
use std::sync::Arc;

use memry_core::crdt::blocks::{
    Block, TableContent, blocks_to_text, extract_blocks, extract_table,
};
use memry_core::crdt::registry::{Document, UpdateSink};
use memry_core::crdt::{BODY_FRAGMENT, DocumentRegistry, extract_text};
use support::{hex_field, str_field, vector_file};
use yrs::{
    Any, Doc, ReadTxn as _, StateVector, Text as _, Transact as _, TransactionMut, Xml as _,
    XmlElementPrelim, XmlElementRef, XmlFragment as _, XmlFragmentRef, XmlTextPrelim,
};

/// Both walks over one document, through the registry — the only door chapter
/// 12 §12.5.1 allows.
fn walks(case_name: &str, update: &[u8]) -> (String, Vec<Block>) {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-vectors", sink);
    let document = registry
        .get_or_open("abc123def456")
        .unwrap_or_else(|error| panic!("{case_name}: open: {error}"));
    document
        .apply_durable_update(update)
        .unwrap_or_else(|error| panic!("{case_name}: apply: {error}"));
    let text =
        extract_text(&document).unwrap_or_else(|error| panic!("{case_name}: extract: {error}"));
    let blocks =
        extract_blocks(&document).unwrap_or_else(|error| panic!("{case_name}: blocks: {error}"));
    (text, blocks)
}

#[test]
fn blocks_render_to_the_same_text_as_extract_text() {
    let vectors = vector_file("text-extract");
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "the class must not be empty");

    for case in cases {
        let name = str_field(case, "name");
        let update = hex_field(case, "updateHex");
        let (text, blocks) = walks(name, &update);
        let rendered = blocks_to_text(&blocks);

        assert_eq!(
            rendered.as_bytes(),
            text.as_bytes(),
            "{name}: the two walks disagree\n  text   {text:?}\n  blocks {rendered:?}"
        );
    }
}

/// The negative control: a walk that dropped every block would pass the
/// assertion above on an empty document and on nothing else, so at least one
/// committed case has to produce blocks.
#[test]
fn the_class_exercises_real_blocks() {
    let vectors = vector_file("text-extract");
    let cases = vectors["cases"].as_array().expect("cases");

    let mut kinds: Vec<String> = Vec::new();
    for case in cases {
        let update = hex_field(case, "updateHex");
        let (_, blocks) = walks(str_field(case, "name"), &update);
        kinds.extend(blocks.iter().map(|block| block.kind.clone()));
    }
    kinds.sort();
    kinds.dedup();

    assert!(
        kinds.iter().any(|kind| kind == "paragraph"),
        "no case produced a paragraph; the walk is not reaching the body"
    );
    assert!(
        kinds.len() > 1,
        "every block came out as one kind ({kinds:?}), which no real note is"
    );
}

/// What the text walk drops and this one must not: a heading's level survives
/// as a property rather than as a `#` the shell would have to parse back.
#[test]
fn a_heading_keeps_its_level_as_a_property() {
    let vectors = vector_file("text-extract");
    let cases = vectors["cases"].as_array().expect("cases");

    let mut seen_heading = false;
    for case in cases {
        let update = hex_field(case, "updateHex");
        let (_, blocks) = walks(str_field(case, "name"), &update);
        for block in blocks.iter().filter(|block| block.kind == "heading") {
            seen_heading = true;
            assert!(
                block.props.iter().any(|prop| prop.name == "level"),
                "a heading crossed without its level: {:?}",
                block.props
            );
        }
    }
    assert!(seen_heading, "the class carries no heading to check");
}

/// A divider is a block a shell has to draw, and it used to be dropped before
/// it ever left the core — which is why `NoteBlockView`'s `case "divider"`
/// was unreachable code. It reaches the shell now, and the text walk still
/// drops it, so both statements hold at once.
#[test]
fn a_divider_reaches_the_shell_and_still_contributes_no_text() {
    let document = built(|txn, body| {
        block(txn, body, "paragraph", "Above");
        block(txn, body, "divider", "");
        block(txn, body, "paragraph", "Below");
    });

    let blocks = extract_blocks(&document).expect("blocks");
    assert_eq!(
        blocks.iter().map(|b| b.kind.as_str()).collect::<Vec<_>>(),
        ["paragraph", "divider", "paragraph"],
    );
    assert_eq!(
        blocks_to_text(&blocks),
        extract_text(&document).expect("text"),
    );
    assert_eq!(extract_text(&document).expect("text"), "Above\nBelow");
}

/// A mark's name is not its value. `textColor` alone cannot tell red from
/// blue, and before the attribute map existed that is exactly what the shell
/// received.
#[test]
fn an_inline_mark_carries_its_value() {
    let document = built(|txn, body| {
        let paragraph = block(txn, body, "paragraph", "");
        let text = paragraph.push_back(txn, XmlTextPrelim::new("red bold"));
        // BlockNote spells a string-valued style's value `stringValue`, which
        // is what y-prosemirror stores as the mark's attributes.
        text.format(
            txn,
            0,
            3,
            [("textColor".into(), mark_attrs(&[("stringValue", "red")]))].into(),
        );
        // A boolean style carries an empty attribute object.
        text.format(txn, 4, 4, [("bold".into(), mark_attrs(&[]))].into());
    });

    let blocks = extract_blocks(&document).expect("blocks");
    let runs = &blocks[0].inline;
    let red = runs
        .iter()
        .find(|run| run.marks.iter().any(|mark| mark == "textColor"))
        .expect("the coloured run");
    assert_eq!(red.text, "red");
    assert_eq!(
        red.mark_attrs.get("textColor").map(String::as_str),
        Some("red")
    );

    let bold = runs
        .iter()
        .find(|run| run.marks.iter().any(|mark| mark == "bold"))
        .expect("the bold run");
    assert_eq!(bold.text, "bold");
    assert!(
        bold.mark_attrs.is_empty(),
        "a boolean style says everything by being present: {:?}",
        bold.mark_attrs
    );
}

/// N013: a table with a header row, a header column, a set `colwidth` and a
/// coloured cell — the four things the flat block list could not carry.
#[test]
fn a_table_crosses_with_its_rows_columns_widths_and_colours() {
    let document = built(|txn, body| {
        let container = body.push_back(txn, XmlElementPrelim::empty("blockContainer"));
        container.insert_attribute(txn, "id", "table-1");
        let table = container.push_back(txn, XmlElementPrelim::empty("table"));

        // Header row: two `tableHeader` cells, the first also starting the
        // header column.
        let head = table.push_back(txn, XmlElementPrelim::empty("tableRow"));
        let corner = cell(txn, &head, "tableHeader", "");
        corner.insert_attribute(txn, "colwidth", Any::from(vec![Any::from(180.0)]));
        cell(txn, &head, "tableHeader", "Value");

        // Body row: a header cell in column 0, a coloured data cell after it.
        let row = table.push_back(txn, XmlElementPrelim::empty("tableRow"));
        cell(txn, &row, "tableHeader", "alpha");
        let coloured = cell(txn, &row, "tableCell", "1");
        coloured.insert_attribute(txn, "backgroundColor", "yellow");
        coloured.insert_attribute(txn, "textAlignment", "center");
    });

    let table: TableContent = extract_table(&document, "table-1")
        .expect("read")
        .expect("the table block");

    assert_eq!(table.block_id.as_deref(), Some("table-1"));
    assert_eq!(table.rows.len(), 2, "two rows, not four loose cells");
    assert_eq!(table.rows[0].cells.len(), 2);
    assert_eq!(
        table.column_widths,
        vec![Some(180.0), None],
        "a resized column keeps its width and an untouched one stays unset"
    );
    assert_eq!(table.header_rows, 1, "the first row is all headers");
    assert_eq!(table.header_cols, 1, "so is the first column");

    let data = &table.rows[1].cells[1];
    assert!(!data.is_header);
    assert_eq!(data.background_color.as_deref(), Some("yellow"));
    assert_eq!(data.text_alignment.as_deref(), Some("center"));
    assert_eq!(data.colspan, 1, "an absent colspan is one, not zero");
    assert_eq!(
        data.content
            .iter()
            .flat_map(|block| block.inline.iter())
            .map(|run| run.text.as_str())
            .collect::<String>(),
        "1"
    );

    // Q1, asserted rather than only written down: a cell has no id of its own,
    // so an edit cannot address one the way it addresses every other block.
    assert!(
        table
            .rows
            .iter()
            .flat_map(|row| row.cells.iter())
            .all(|cell| cell.block_id.is_none()),
        "a tableCell carries no blockContainer id"
    );
}

/// The table block itself has to reach the shell, or nothing can ask for the
/// structure above. It used to be a container, which put its id on the first
/// cell and left the shell no handle at all.
#[test]
fn a_table_is_a_block_and_keeps_its_id() {
    let document = built(|txn, body| {
        let container = body.push_back(txn, XmlElementPrelim::empty("blockContainer"));
        container.insert_attribute(txn, "id", "table-1");
        let table = container.push_back(txn, XmlElementPrelim::empty("table"));
        let row = table.push_back(txn, XmlElementPrelim::empty("tableRow"));
        cell(txn, &row, "tableHeader", "Name");
        cell(txn, &row, "tableCell", "alpha");
    });

    let blocks = extract_blocks(&document).expect("blocks");
    let table = blocks.first().expect("a first block");
    assert_eq!(table.kind, "table");
    assert_eq!(table.id.as_deref(), Some("table-1"));
    assert_eq!(table.depth, 0);

    // The row is a block of its own now, so the cells under it have a
    // boundary. A shell skips the whole subtree by depth and draws the table
    // from `extract_table` instead.
    assert_eq!(blocks[1].kind, "tableRow");
    assert_eq!(blocks[1].depth, 1);
    assert!(blocks[2..].iter().all(|block| block.depth > 1));

    // And the two walks still agree, which is what makes the change safe.
    assert_eq!(
        blocks_to_text(&blocks),
        extract_text(&document).expect("text")
    );
}

#[test]
fn a_block_that_is_not_a_table_is_not_a_table() {
    let document = built(|txn, body| {
        let container = body.push_back(txn, XmlElementPrelim::empty("blockContainer"));
        container.insert_attribute(txn, "id", "para-1");
        let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
        paragraph.push_back(txn, XmlTextPrelim::new("Not a table."));
    });

    assert!(extract_table(&document, "para-1").expect("read").is_none());
    assert!(extract_table(&document, "nope").expect("read").is_none());
}

// MARK: - Building a document

/// Authors an update in a separate `Doc` and applies the bytes through the
/// registry, which is the only door chapter 12 §12.5.1 allows.
fn built(build: impl FnOnce(&mut TransactionMut, &XmlFragmentRef)) -> Arc<Document> {
    let author = Doc::with_client_id(1);
    let fragment = author.get_or_insert_xml_fragment(BODY_FRAGMENT);
    {
        let mut txn = author.transact_mut();
        build(&mut txn, &fragment);
    }
    let update = author
        .transact()
        .encode_state_as_update_v1(&StateVector::default());

    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-blocks", sink);
    let document = registry.get_or_open("abc123def456").expect("open");
    document.apply_durable_update(&update).expect("apply");
    document
}

/// One mark's attributes, the way y-prosemirror stores them: the mark's own
/// `attrs` object, which is empty for a boolean style.
fn mark_attrs(entries: &[(&str, &str)]) -> Any {
    Any::from(
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), Any::from(*value)))
            .collect::<HashMap<String, Any>>(),
    )
}

/// `blockContainer > <block> > text`, the shape y-prosemirror gives a block.
fn block(
    txn: &mut TransactionMut,
    parent: &XmlFragmentRef,
    block_type: &str,
    text: &str,
) -> XmlElementRef {
    let container = parent.push_back(txn, XmlElementPrelim::empty("blockContainer"));
    let inner = container.push_back(txn, XmlElementPrelim::empty(block_type));
    if !text.is_empty() {
        inner.push_back(txn, XmlTextPrelim::new(text));
    }
    inner
}

/// `tableCell > tableParagraph > text`, which is how BlockNote builds a cell —
/// with no `blockContainer` and no id in between.
fn cell(txn: &mut TransactionMut, row: &XmlElementRef, tag: &str, text: &str) -> XmlElementRef {
    let cell = row.push_back(txn, XmlElementPrelim::empty(tag));
    let paragraph = cell.push_back(txn, XmlElementPrelim::empty("tableParagraph"));
    if !text.is_empty() {
        paragraph.push_back(txn, XmlTextPrelim::new(text));
    }
    cell
}
