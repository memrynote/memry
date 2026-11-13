//! References into other notes' blocks ([`block_refs`]) from `index.db`, for the graph and the
//! usage lists. Not on the FFI surface.

use crate::api::errors::StorageError;
use crate::domain::search::block_refs::{self, BlockRefEdge};
use crate::domain::search::portal_reads::{self, PortalBlockSearch, PortalHost};

use super::Search;

impl Search {
    /// Every portal and block link whose target this vault holds ([`block_refs::edges`]).
    pub fn block_ref_edges(&self) -> Result<Vec<BlockRefEdge>, StorageError> {
        let index = self.index.clone();
        self.data
            .read_blocking(move |data| index.read_blocking(|index| block_refs::edges(data, index)))
    }

    /// The other notes that show `note_id`, or one of its blocks, through a portal, or link to
    /// one of its blocks. A note's references into itself are left out, as Electron's usage
    /// lists leave them out.
    pub fn block_refs(&self, note_id: &str) -> Result<Vec<BlockRefEdge>, StorageError> {
        let mut edges = self.block_ref_edges()?;
        edges.retain(|edge| edge.to_note == note_id && edge.from_note != note_id);
        Ok(edges)
    }

    /// The notes that show `note_id`, or its block `anchor`, through a portal or a link
    /// ([`portal_reads::usage`], desktop `portals:get-usage`).
    pub fn portal_usage(
        &self,
        note_id: &str,
        anchor: Option<&str>,
    ) -> Result<Vec<PortalHost>, StorageError> {
        let index = self.index.clone();
        self.data.read_blocking(move |data| {
            index.read_blocking(|index| portal_reads::usage(data, index, note_id, anchor))
        })
    }

    /// The blocks a portal search finds ([`portal_reads::search_blocks`], `portals:search`).
    pub fn portal_search(
        &self,
        text: Option<&str>,
        tag: Option<&str>,
        limit: usize,
    ) -> Result<PortalBlockSearch, StorageError> {
        let index = self.index.clone();
        self.data.read_blocking(move |data| {
            index.read_blocking(|index| portal_reads::search_blocks(data, index, text, tag, limit))
        })
    }
}
