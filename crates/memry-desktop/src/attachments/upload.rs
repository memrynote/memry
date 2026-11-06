//! The chunked upload of an attachment larger than one request body (#3531 14f-2).
//!
//! A Tauri `Channel` carries messages from Rust to the page only, so the page sends the file as
//! raw request bodies of at most [`CHUNK_BYTES`], one awaited call at a time, and never holds
//! more than one part. The parts are appended, strictly in order, to
//! `<vault>/.memry/uploads/<id>.part`. After the last one the file reaches disk and moves into
//! the note's attachments folder under a fresh name, through the checks of a one-body upload
//! and the recheck right before the move ([`super::store`]). So the attachments folder never
//! holds part of a file, and the watcher and sync, which skip `.memry`, never see a part file.
//!
//! An upload ends in its whole file or in nothing. A refused or failed chunk, a cancel from the
//! page, the page reloading or its window closing, and the vault closing (a switch, a quit)
//! delete the part file. A crash leaves it, and the next open of the vault deletes it
//! ([`sweep_uploads`]).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use super::{AttachmentError, SavedAttachment, check, create_dir, inside_vault, store};
use crate::session::{OpenStage, OpenVault, Session};
use crate::shell::file_open::{Resolution, resolve_under_root};
use crate::vault::fs_atomic::{
    BeforeCommit, RETRY_DELAYS_MS, WriteError, rename_no_replace, sync_dir, with_transient_retry,
};
use crate::vault::layout::{MEMRY_DIR, UPLOADS_DIR};

/// The largest part, and the size of every part but the last.
pub const CHUNK_BYTES: usize = 8 * 1024 * 1024;
/// Uploads in flight at once. The app uploads one file after another; this bounds a runaway page.
pub const MAX_UPLOADS: usize = 8;

const SCOPE: &str = "attachments";

struct Upload {
    vault: PathBuf,
    note_id: String,
    file_name: String,
    size: u64,
    written: u64,
    temp: PathBuf,
    /// `None` once the upload ended: its part file was moved into place or deleted.
    file: Option<File>,
}

impl Upload {
    /// Ends the upload with nothing: the part file is closed, then deleted.
    fn discard(&mut self) {
        self.file = None;
        if let Err(error) = fs::remove_file(&self.temp)
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!(
                scope = SCOPE,
                "an upload's part file was not deleted: {:?}",
                error.kind()
            );
        }
    }
}

struct Entry {
    /// The page that began it, a webview label.
    owner: String,
    upload: Arc<Mutex<Upload>>,
}

/// The chunked uploads in flight, of the open vault only.
#[derive(Default)]
pub struct Uploads {
    open: Mutex<HashMap<String, Entry>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Uploads {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Deletes what a crash left when a vault opens, before any upload can begin in it, and ends
    /// every upload when the vault closes.
    pub fn register(self: &Arc<Self>, session: &Session) {
        session.on_open(
            "attachment-uploads",
            OpenStage::Defaults,
            Arc::new(|view| {
                sweep_uploads(&view.path)
                    .map(|_| ())
                    .map_err(|error| format!("leftover uploads not deleted: {error}"))
            }),
        );
        let uploads = Arc::clone(self);
        session.on_close("attachment-uploads", Arc::new(move |_| uploads.abort_all()));
    }

    /// Starts the upload of a file of `size` bytes to a note of the open vault, for page
    /// `owner`. A refused note id, type or size creates nothing. Returns the upload's id.
    pub fn begin(
        &self,
        open: &OpenVault,
        owner: &str,
        note_id: &str,
        file_name: &str,
        size: u64,
    ) -> Result<String, AttachmentError> {
        check(
            note_id,
            file_name,
            usize::try_from(size).unwrap_or(usize::MAX),
        )?;
        let mut uploads = lock(&self.open);
        if uploads.len() >= MAX_UPLOADS {
            return Err(AttachmentError::TooManyUploads);
        }
        let rel = format!("{MEMRY_DIR}/{UPLOADS_DIR}");
        let dir = open.path.join(MEMRY_DIR).join(UPLOADS_DIR);
        create_dir(&dir)?;
        inside_vault(&open.path, &rel)?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let temp = dir.join(format!("{id}.part"));
        let file = part_file_options().open(&temp)?;
        let upload = Upload {
            vault: open.path.clone(),
            note_id: note_id.to_owned(),
            file_name: file_name.to_owned(),
            size,
            written: 0,
            temp,
            file: Some(file),
        };
        uploads.insert(
            id.clone(),
            Entry {
                owner: owner.to_owned(),
                upload: Arc::new(Mutex::new(upload)),
            },
        );
        Ok(id)
    }

    /// Appends `bytes` at `offset`, which must be the count received so far. The part that
    /// completes the file moves it into the note's attachments folder and returns it. Any
    /// failure ends the upload with nothing.
    pub fn write_chunk(
        &self,
        open: &OpenVault,
        id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<Option<SavedAttachment>, AttachmentError> {
        self.write_chunk_with(open, id, offset, bytes, &mut |_| {})
    }

    /// Test hook: [`Self::write_chunk`] with `before_recheck` run with the target right before
    /// the last check of the note's folder, the one in the same step as the move, so a test can
    /// swap a link in there or put a file at the target.
    #[cfg(feature = "test-hooks")]
    #[doc(hidden)]
    pub fn write_chunk_checked(
        &self,
        open: &OpenVault,
        id: &str,
        offset: u64,
        bytes: &[u8],
        before_recheck: &mut dyn FnMut(&Path),
    ) -> Result<Option<SavedAttachment>, AttachmentError> {
        self.write_chunk_with(open, id, offset, bytes, before_recheck)
    }

    fn write_chunk_with(
        &self,
        open: &OpenVault,
        id: &str,
        offset: u64,
        bytes: &[u8],
        before_recheck: &mut dyn FnMut(&Path),
    ) -> Result<Option<SavedAttachment>, AttachmentError> {
        let upload = lock(&self.open)
            .get(id)
            .map(|entry| Arc::clone(&entry.upload))
            .ok_or(AttachmentError::UploadGone)?;
        let mut upload = lock(&upload);
        let outcome = match append(&mut upload, offset, bytes) {
            Ok(true) => commit(&mut upload, open, before_recheck).map(Some),
            other => other.map(|_| None),
        };
        if !matches!(outcome, Ok(None)) {
            upload.discard();
            drop(upload);
            lock(&self.open).remove(id);
        }
        outcome
    }

    /// Cancels an upload. An id that is not in flight has ended already.
    pub fn abort(&self, id: &str) {
        let entry = lock(&self.open).remove(id);
        end(entry);
    }

    /// Ends the uploads of page `owner`: it reloaded, or its window closed. They are out of the
    /// map when this returns, so a new page of that label starts clean; their part files go in
    /// [`Ended::finish`], which waits for a part being written and belongs off the main thread.
    pub fn release_owner(&self, owner: &str) -> Ended {
        Ended(
            lock(&self.open)
                .extract_if(|_, entry| entry.owner == owner)
                .map(|(_, entry)| entry)
                .collect(),
        )
    }

    /// Ends every upload: the vault closes.
    pub fn abort_all(&self) {
        Ended(lock(&self.open).drain().map(|(_, entry)| entry).collect()).finish();
    }
}

/// Uploads taken out of the map whose part files are still to be deleted.
#[must_use = "the part files stay until `finish` runs"]
pub struct Ended(Vec<Entry>);

impl Ended {
    pub fn finish(self) {
        self.0.into_iter().for_each(|entry| end(Some(entry)));
    }
}

/// Waits for a chunk being written to finish, then deletes the part file. A part that has just
/// moved into place is a finished upload and stays.
fn end(entry: Option<Entry>) {
    if let Some(entry) = entry {
        lock(&entry.upload).discard();
    }
}

/// Whether the upload is complete after `bytes` at `offset`.
fn append(upload: &mut Upload, offset: u64, bytes: &[u8]) -> Result<bool, AttachmentError> {
    let file = upload.file.as_mut().ok_or(AttachmentError::UploadGone)?;
    let end = offset
        .checked_add(bytes.len() as u64)
        .filter(|end| offset == upload.written && bytes.len() <= CHUNK_BYTES && *end <= upload.size)
        .ok_or(AttachmentError::BadChunk)?;
    file.write_all(bytes)?;
    upload.written = end;
    Ok(end == upload.size)
}

/// Moves the complete part file into the note's attachments folder, referenced from the note's
/// file as it is now.
fn commit(
    upload: &mut Upload,
    open: &OpenVault,
    before_recheck: &mut dyn FnMut(&Path),
) -> Result<SavedAttachment, AttachmentError> {
    let file = upload.file.take().ok_or(AttachmentError::UploadGone)?;
    file.sync_all()?;
    drop(file);
    // A closing vault ends its uploads under their locks, so this is the one the upload began in.
    debug_assert_eq!(open.path, upload.vault);
    let row = open.vault.note_files().by_id(&upload.note_id)?;
    let temp = upload.temp.clone();
    store(
        &upload.vault,
        &upload.note_id,
        row.as_ref().map(|row| row.path.as_str()),
        &upload.file_name,
        usize::try_from(upload.written).unwrap_or(usize::MAX),
        before_recheck,
        &mut |target, recheck| move_into(&temp, target, recheck),
    )
}

/// Renames the part file to `target`, never over a file there, after `recheck`.
fn move_into(temp: &Path, target: &Path, recheck: BeforeCommit<'_>) -> Result<(), WriteError> {
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    with_transient_retry(&delays, || {
        recheck()?;
        rename_no_replace(temp, target)
    })
    .map_err(|source| WriteError {
        path: target.to_path_buf(),
        source,
    })?;
    if let Some(folder) = target.parent() {
        sync_dir(folder);
    }
    Ok(())
}

/// A new part file; on Unix only the user can read it, as the temp file of a one-body upload.
fn part_file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

/// Deletes the files in the vault's uploads folder: part files a crash or a killed app left.
/// Runs when the vault opens, while no upload of it is in flight. A folder that resolves out of
/// the vault is left alone. Returns how many went.
fn sweep_uploads(vault: &Path) -> io::Result<usize> {
    let rel = format!("{MEMRY_DIR}/{UPLOADS_DIR}");
    let Resolution::Inside(dir) = resolve_under_root(vault, &rel)? else {
        return Ok(0);
    };
    let mut removed = 0;
    for entry in fs::read_dir(dir)? {
        let outcome = entry.and_then(|entry| {
            if entry.file_type()?.is_file() {
                fs::remove_file(entry.path())?;
                removed += 1;
            }
            Ok(())
        });
        if let Err(error) = outcome {
            tracing::warn!(
                scope = SCOPE,
                "a leftover upload was not deleted: {:?}",
                error.kind()
            );
        }
    }
    Ok(removed)
}
