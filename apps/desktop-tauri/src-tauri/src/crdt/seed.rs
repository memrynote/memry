//! First-open markdown seeding for the BlockNote Y.XmlFragment.

use crate::crdt::docstore::DocHandle;
use crate::crdt::md_to_yjs::{md_to_blocknote_blocks, BlockNoteBlock};
use crate::error::AppResult;
use yrs::{ReadTxn, WriteTxn, Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim};

const PROSEMIRROR_FRAGMENT: &str = "prosemirror";

pub fn seed_from_markdown(handle: &DocHandle, markdown: &str) -> AppResult<()> {
    if handle.with_read(|txn| {
        txn.get_xml_fragment(PROSEMIRROR_FRAGMENT)
            .is_some_and(|fragment| fragment.len(txn) > 0)
    }) {
        return Ok(());
    }

    let blocks = md_to_blocknote_blocks(markdown);
    handle.with_write(|txn| {
        let fragment = txn.get_or_insert_xml_fragment(PROSEMIRROR_FRAGMENT);
        for block in &blocks {
            insert_block(&fragment, txn, block);
        }
    });

    Ok(())
}

fn insert_block(
    fragment: &impl XmlFragment,
    txn: &mut yrs::TransactionMut<'_>,
    block: &BlockNoteBlock,
) {
    let block_group = match fragment.first_child() {
        Some(yrs::XmlOut::Element(element)) if element.tag().as_ref() == "blockGroup" => element,
        _ => fragment.push_back(txn, XmlElementPrelim::empty("blockGroup")),
    };
    let block_container = block_group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
    block_container.insert_attribute(txn, "id", format!("seed-{}", block_group.len(txn) - 1));

    let element =
        block_container.push_back(txn, XmlElementPrelim::empty(node_name_for_block(block)));
    insert_default_block_attrs(&element, txn, block);
    if let Some(level) = block.level {
        element.insert_attribute(txn, "level", level.to_string());
    }
    if let Some(language) = block.language.as_ref() {
        element.insert_attribute(txn, "language", language);
    }
    element.push_back(txn, XmlTextPrelim::new(block.text.as_str()));
}

fn node_name_for_block(block: &BlockNoteBlock) -> &'static str {
    match block.kind.as_str() {
        "heading" => "heading",
        "bulletListItem" => "bulletListItem",
        "numberedListItem" => "numberedListItem",
        "codeBlock" => "codeBlock",
        _ => "paragraph",
    }
}

fn insert_default_block_attrs(
    element: &yrs::XmlElementRef,
    txn: &mut yrs::TransactionMut<'_>,
    block: &BlockNoteBlock,
) {
    if block.kind != "codeBlock" {
        element.insert_attribute(txn, "backgroundColor", "default");
        element.insert_attribute(txn, "textAlignment", "left");
        element.insert_attribute(txn, "textColor", "default");
    }
    if block.kind == "heading" {
        element.insert_attribute(txn, "isToggleable", "false");
    }
}
