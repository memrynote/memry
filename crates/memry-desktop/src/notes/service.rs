//! `NotesService`: the app's own note operations (Step 13f, #3530), ordering the vault file and
//! the core's records. The core owns the records, the vault tier's lane owns the `note_files`
//! rows, the file helpers move bytes; this decides the order:
//!
//! - **Create** ([`super::create`]): record, then row, then file, then the body seeded from
//!   the file. A failure once the file is on disk takes the file, the row and the record back.
//! - **Delete** ([`super::delete`]): file, then record, then row. A file that cannot go leaves
//!   the note whole; the row goes last, so a local-only note's delete is still withheld from
//!   sync when the record goes.
//!
//! The reads need neither and are free functions ([`super::read`]).
//!
//! Every method blocks: the shell calls it in `spawn_blocking`. The app's writes of a note go
//! one at a time ([`WriteOrder`]); every write tells the tier's own-write record first, so the
//! watcher never reports it back as an outside edit or an outside delete.

use std::path::Path;
use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;

use super::write_order::WriteOrder;
use crate::vault::consumer::VaultTier;
use crate::vault::trash::move_to_trash;

/// Moves a file to the OS trash.
pub type Trash = fn(&Path) -> Result<(), String>;

pub struct NotesService {
    pub(crate) tier: Arc<VaultTier>,
    pub(crate) store: Arc<dyn SecureStore>,
    pub(crate) order: WriteOrder,
    pub(crate) trash: Trash,
}

impl NotesService {
    pub fn new(tier: Arc<VaultTier>, store: Arc<dyn SecureStore>) -> Arc<Self> {
        Self::with_trash(tier, store, move_to_trash)
    }

    /// [`Self::new`] with another trash, for a test that cannot use the OS trash.
    #[doc(hidden)]
    pub fn with_trash(
        tier: Arc<VaultTier>,
        store: Arc<dyn SecureStore>,
        trash: Trash,
    ) -> Arc<Self> {
        Arc::new(Self {
            tier,
            store,
            order: WriteOrder::default(),
            trash,
        })
    }
}
