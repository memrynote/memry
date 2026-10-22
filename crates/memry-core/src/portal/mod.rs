//! `portal`: resolves a `memry-portal` fence against a source note's blocks.
//!
//! A portal is a fenced code block (`language: "memry-portal"`) whose JSON body
//! names a note, or root blocks of a note by anchor and which of their
//! children are open (format v1). Chapter 12 §12.6.3 owns the
//! format; `packages/shared/src/portal-resolve.ts` is the reference port and
//! `portal-resolve.json` holds the two together. The core resolves so a shell
//! renders the slice and holds no portal rules.
//!
//! Scope matches the reference: this answers `Ok` or `MissingBlock` (no root
//! anchor matches) for a
//! readable definition and `Invalid` for one it cannot read. Search targets are
//! computed elsewhere and report `Invalid` here, as the reference does.
//! `MissingNote` is decided by [`crate::api::notes::Notes::portal_slice`].

use std::collections::HashMap;

use crate::crdt::blocks::Block;

mod anchor;
mod definition;
mod resolve;

pub use anchor::{extract_anchor, is_anchor};
pub use definition::{PortalDefinition, PortalOpen, PortalTarget, parse_portal_definition};

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

/// [`PortalSlice`] plus what the portal leaves out, for callers that draw
/// "N hidden" rows. Not exported over UniFFI: the shells draw the slice only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortalResolution {
    pub status: PortalStatus,
    pub blocks: Vec<Block>,
    /// Same-parent siblings of the roots that are not shown, in document order.
    pub hidden_siblings: Vec<Block>,
    /// Hidden children of each shown block, keyed by that block's anchor.
    pub hidden_children: HashMap<String, Vec<Block>>,
}

/// A portal definition (the fence's JSON text) over its source note's blocks.
pub fn resolve_portal(definition_json: &str, blocks: Vec<Block>) -> PortalSlice {
    let resolution = resolve_portal_detailed(definition_json, blocks);
    PortalSlice {
        status: resolution.status,
        blocks: resolution.blocks,
    }
}

pub use resolve::resolve_portal_detailed;
