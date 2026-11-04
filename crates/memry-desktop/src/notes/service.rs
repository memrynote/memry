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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use memry_core::api::journal::Journal;
use memry_core::seams::secure_store::SecureStore;

use super::error::NotesError;
use super::tag_template::Undos;
use super::write_order::WriteOrder;
use crate::session::OpenVault;
use crate::vault::app_edit::OwnFiles;
use crate::vault::consumer::VaultTier;
use crate::vault::trash::move_to_trash;

/// Moves a file to the OS trash.
pub type Trash = fn(&Path) -> Result<(), String>;

pub struct NotesService {
    pub(crate) tier: Arc<VaultTier>,
    pub(crate) store: Arc<dyn SecureStore>,
    pub(crate) order: WriteOrder,
    pub(crate) trash: Trash,
    /// The files this run wrote for its notes, which a save replaces with no version: set by a
    /// create ([`super::create`]), kept by the saves ([`super::update`]).
    pub(crate) own_files: OwnFiles,
    /// The tag templates' fills that can still be taken back ([`super::tag_template`]).
    pub(crate) undos: Undos,
    /// Test hook: runs once inside the next journal save, after the day's new file is written
    /// aside and before it lands ([`Self::before_next_day_file_lands`]).
    pub(crate) day_file_lands: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Test hook: the next moved note's refs edit fails its feed (`AppEdit::fail_next_feed`).
    pub(crate) fail_next_ref_feed: AtomicBool,
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
            own_files: OwnFiles::default(),
            undos: Undos::default(),
            day_file_lands: Mutex::new(None),
            fail_next_ref_feed: AtomicBool::new(false),
        })
    }

    /// The journal of the open vault, for its reads (`journal::calendar`).
    pub fn journal(&self, open: &OpenVault) -> Result<Arc<Journal>, NotesError> {
        Ok(open.vault.journal(self.store.clone())?)
    }

    /// Test hook: `hook` runs inside the next journal save, between its file write and the
    /// record's mirror, as a pull or an outside edit can.
    #[doc(hidden)]
    pub fn before_next_day_file_lands(&self, hook: Box<dyn FnOnce() + Send>) {
        *self
            .day_file_lands
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(hook);
    }

    /// Test hook: the next moved note's refs edit fails its feed, as for a document that does
    /// not load, so its file is written and the watcher brings it in.
    #[doc(hidden)]
    pub fn fail_next_ref_feed(&self) {
        self.fail_next_ref_feed.store(true, Ordering::Relaxed);
    }
}
