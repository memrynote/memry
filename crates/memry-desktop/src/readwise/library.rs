//! The vault as a Readwise run sees it: the notes it reads and writes, the editor's busy check,
//! and the images it downloads. One per open vault; every call blocks, so the run lives on a
//! blocking thread and reaches the network through `runtime`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::api::readwise::ReadwiseStore;
use memry_core::domain::readwise::{ReadwiseItem, parse_readwise_url};

use crate::attachments::RemoteImages;
use crate::editor::EditorHost;
use crate::notes::read;
use crate::notes::service::NotesService;
use crate::notes::view::{NoteView, SizeClass};
use crate::session::OpenVault;
use crate::vault::activity::ActivityLog;

/// A note open in a window, or updated from the server this recently, is not written (D6).
pub const BUSY_WINDOW: Duration = Duration::from_millis(2000);

pub struct Library {
    pub open: OpenVault,
    pub notes: Arc<NotesService>,
    pub editor: Arc<EditorHost>,
    pub images: Arc<RemoteImages>,
    /// True while the vault's first index build runs: a missing note may only be unindexed.
    pub indexing: Arc<dyn Fn() -> bool + Send + Sync>,
    pub runtime: tokio::runtime::Handle,
    /// The vault's activity log, which gets one line for a run that changed something (D19).
    pub activity: Arc<ActivityLog>,
    /// One write at a time (`inflight` in `note-writer.ts`): a run and a book command must not
    /// both create a book's note or overwrite each other's append.
    pub(crate) writes: Mutex<()>,
}

impl Library {
    pub fn new(
        open: OpenVault,
        notes: Arc<NotesService>,
        editor: Arc<EditorHost>,
        images: Arc<RemoteImages>,
        indexing: Arc<dyn Fn() -> bool + Send + Sync>,
        runtime: tokio::runtime::Handle,
        activity: Arc<ActivityLog>,
    ) -> Self {
        Self {
            open,
            notes,
            editor,
            images,
            indexing,
            runtime,
            activity,
            writes: Mutex::new(()),
        }
    }

    pub fn store(&self) -> ReadwiseStore {
        self.open.vault.readwise()
    }

    /// The note, `None` when it has no live row or file. A large file is refused: its text is
    /// not read, so no section of it can be compared or kept.
    pub(crate) fn note(&self, id: &str) -> Result<Option<NoteView>, String> {
        let note = read::get(&self.open, id, None).map_err(|error| error.to_string())?;
        match note {
            Some(note) if note.size_class == SizeClass::LargeFile || note.content_omitted => {
                Err("The note is too large for Readwise to write into".to_owned())
            }
            note => Ok(note),
        }
    }

    /// `isBusy` (D6). A scheduled write skips a note a window holds or the server just updated;
    /// a command the user started skips only the server update (#5053 departure 12).
    pub(crate) fn busy(&self, note_id: &str, user_started: bool) -> bool {
        match user_started {
            true => self
                .editor
                .took_remote_update(&self.open.path, note_id, BUSY_WINDOW),
            false => self.editor.is_busy(&self.open.path, note_id, BUSY_WINDOW),
        }
    }

    /// `findNoteByReadwiseUrl`: the lowest note id whose `readwise_url` names `item` and whose
    /// note exists.
    pub(crate) fn note_naming(&self, item: &ReadwiseItem) -> Result<Option<NoteView>, String> {
        self.first_naming(item, |id| self.note(id))
    }

    /// [`Self::note_naming`] for a caller that only links the note and never writes it: a large
    /// note counts, since its text is never read.
    pub(crate) fn note_id_naming(&self, item: &ReadwiseItem) -> Result<Option<String>, String> {
        self.first_naming(item, |id| {
            let note = read::get(&self.open, id, None).map_err(|error| error.to_string())?;
            Ok(note.map(|note| note.id))
        })
    }

    fn first_naming<T>(
        &self,
        item: &ReadwiseItem,
        found: impl Fn(&str) -> Result<Option<T>, String>,
    ) -> Result<Option<T>, String> {
        let values = self
            .open
            .search
            .property_values("readwise_url")
            .map_err(|error| error.to_string())?;
        for (note_id, value) in values {
            if parse_readwise_url(&value).as_ref() != Some(item) {
                continue;
            }
            if let Some(note) = found(&note_id)? {
                return Ok(Some(note));
            }
        }
        Ok(None)
    }

    /// `rebuildLinks` from the index's `readwise_url` values.
    pub fn rebuild_links(&self) -> Result<usize, String> {
        let values = self
            .open
            .search
            .property_values("readwise_url")
            .map_err(|error| error.to_string())?;
        self.store()
            .rebuild_links(values)
            .map_err(|error| error.to_string())
    }
}
