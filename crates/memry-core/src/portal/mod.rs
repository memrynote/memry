//! `portal`: resolves a `memry-portal` fence against a source note's blocks.
//!
//! A portal is a fenced code block (`language: "memry-portal"`) whose JSON body
//! names a note, or one block of a note by anchor. Chapter 12 §12.6.3 owns the
//! format; `packages/shared/src/portal-resolve.ts` is the reference port and
//! `portal-resolve.json` holds the two together. The core resolves so a shell
//! renders the slice and holds no portal rules.
//!
//! Scope matches the reference: this answers `Ok` or `MissingBlock` for a
//! readable definition and `Invalid` for one it cannot read. Search targets are
//! computed elsewhere and report `MissingBlock` here, as the reference does.
//! `MissingNote` is decided by [`crate::api::notes::Notes::portal_slice`].

use crate::crdt::blocks::Block;

mod anchor;
mod definition;

pub use anchor::{extract_anchor, is_anchor};
pub use definition::{PortalDefinition, PortalTarget, parse_portal_definition};

/// Why a portal shows what it shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum PortalStatus {
    Ok,
    /// The source note is not in this vault.
    MissingNote,
    /// No block of the source note carries the anchor.
    MissingBlock,
    /// The fence JSON cannot be read as a portal definition.
    Invalid,
}

/// The blocks a portal shows, in document order.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PortalSlice {
    pub status: PortalStatus,
    pub blocks: Vec<Block>,
}

impl PortalSlice {
    pub(crate) fn empty(status: PortalStatus) -> Self {
        Self {
            status,
            blocks: Vec::new(),
        }
    }
}

fn block_text(block: &Block) -> String {
    block.inline.iter().map(|run| run.text.as_str()).collect()
}

/// A portal definition (the fence's JSON text) over its source note's blocks.
pub fn resolve_portal(definition_json: &str, blocks: Vec<Block>) -> PortalSlice {
    let Some(definition) = parse_portal_definition(definition_json) else {
        return PortalSlice::empty(PortalStatus::Invalid);
    };
    match &definition.target {
        PortalTarget::Search => PortalSlice::empty(PortalStatus::MissingBlock),
        PortalTarget::Note { .. } => PortalSlice {
            status: PortalStatus::Ok,
            blocks: visible_blocks(&blocks, &definition.hidden),
        },
        PortalTarget::Block { anchor, .. } => resolve_block(anchor, &definition.hidden, &blocks),
    }
}

/// `blocks` without every hidden anchor's block and that block's descendants.
fn visible_blocks(blocks: &[Block], hidden: &[String]) -> Vec<Block> {
    let mut shown = Vec::new();
    // Depth of the hidden block whose subtree is being skipped.
    let mut skip_below: Option<u32> = None;
    for block in blocks {
        if let Some(depth) = skip_below {
            if block.depth > depth {
                continue;
            }
            skip_below = None;
        }
        let is_hidden =
            extract_anchor(&block_text(block)).is_some_and(|found| hidden.contains(&found));
        if is_hidden {
            skip_below = Some(block.depth);
            continue;
        }
        shown.push(block.clone());
    }
    shown
}

fn resolve_block(anchor: &str, hidden: &[String], blocks: &[Block]) -> PortalSlice {
    let Some(root_index) = blocks
        .iter()
        .position(|block| extract_anchor(&block_text(block)).as_deref() == Some(anchor))
    else {
        return PortalSlice::empty(PortalStatus::MissingBlock);
    };

    let root_depth = blocks[root_index].depth;
    let end = blocks[root_index + 1..]
        .iter()
        .position(|block| block.depth <= root_depth)
        .map_or(blocks.len(), |offset| root_index + 1 + offset);
    let mut shown = vec![blocks[root_index].clone()];
    shown.extend(visible_blocks(&blocks[root_index + 1..end], hidden));
    PortalSlice {
        status: PortalStatus::Ok,
        blocks: shown,
    }
}
