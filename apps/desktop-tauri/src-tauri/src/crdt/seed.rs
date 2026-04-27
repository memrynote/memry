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
    let element = fragment.push_back(txn, XmlElementPrelim::empty(tag_for_block(block)));
    if let Some(level) = block.level {
        element.insert_attribute(txn, "data-level", level.to_string());
    }
    if let Some(language) = block.language.as_ref() {
        element.insert_attribute(txn, "data-language", language);
    }
    element.push_back(txn, XmlTextPrelim::new(block.text.as_str()));
}

fn tag_for_block(block: &BlockNoteBlock) -> &'static str {
    match block.kind.as_str() {
        "heading" => match block.level {
            Some(1) => "h1",
            Some(2) => "h2",
            Some(3) => "h3",
            Some(4) => "h4",
            Some(5) => "h5",
            Some(6) => "h6",
            _ => "h1",
        },
        "bulletListItem" | "numberedListItem" => "li",
        "codeBlock" => "pre",
        _ => "p",
    }
}
