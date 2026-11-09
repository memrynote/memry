//! References into other notes' blocks ([`block_refs`]) from `index.db`, for the graph and the
//! usage lists. Not on the FFI surface.

use crate::api::errors::StorageError;
use crate::domain::search::block_refs::{self, BlockRefEdge};

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
}
