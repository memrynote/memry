//! [`NotesWriter`]'s portal write (desktop `portals:stamp-anchor`). Not exported over UniFFI: iOS
//! does not author portals yet. Blocks; the shell runs it in `spawn_blocking`.

use super::{NotesWriter, now_ms};
use crate::crdt::errors::CrdtError;
use crate::domain::body_write;
use crate::portal::StampOutcome;

impl NotesWriter {
    /// Gives the block `block_id` of note `note_id` its ` ^anchor`, or answers the one it has
    /// ([`body_write::stamp_anchor`]). `None` when this vault holds no live note by that id.
    pub fn stamp_anchor(
        &self,
        note_id: String,
        block_id: String,
    ) -> Result<Option<StampOutcome>, CrdtError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| {
                Ok(body_write::stamp_anchor(
                    conn,
                    &note_id,
                    &block_id,
                    &device_id,
                    now_ms(),
                ))
            })
            .map_err(CrdtError::from)?
    }
}
