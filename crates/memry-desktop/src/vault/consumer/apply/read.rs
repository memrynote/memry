//! Reading the note file a fact names.

use super::{Applier, SCOPE};
use crate::vault::activity::failure_key;
use crate::vault::file_types::FileType;
use crate::vault::note_file::{NoteFile, NoteFileError, hash_file, read_note};

/// Why [`Applier::read`] has no note file.
pub(super) enum Unread {
    /// No file was there when it was read: gone, or missing for a moment mid-save. Retried
    /// either way, and its row's pairing hash stays.
    Missing,
    /// It is there and was not read, and is retried. `file_hash` is its bytes' hash when this
    /// build reads them only as bytes (not UTF-8, past the note size cap), else `None`.
    /// `failure` is the read's error when the read itself failed.
    Failed {
        file_hash: Option<String>,
        failure: Option<String>,
    },
}

impl Applier {
    /// The markdown file at `path`, read once; `Ok(None)` for every other kind. A markdown file
    /// found missing is retried like one that could not be read (#3736): a save can leave the
    /// name missing for a moment (Windows renaming a new file over it, an editor that deletes
    /// and writes again), and the watcher, which already reported the bytes it puts back, does
    /// not report them again. The retry has the watcher look again, keeping what it reported
    /// for the note: a file that is back is reported again, a move pairs on the bytes last
    /// reported, and a file that is gone gets its removal, which waits out the rename window
    /// and finds it absent once more.
    pub(super) fn read(&self, path: &str, file_type: FileType) -> Result<Option<NoteFile>, Unread> {
        if file_type != FileType::Markdown {
            return Ok(None);
        }
        match read_note(&self.root, path) {
            Ok(Some(file)) => {
                // A file that read again is reported the next time it does not, inside the
                // hour too.
                self.activity
                    .release(&self.root, &failure_key("read-failed", path));
                Ok(Some(file))
            }
            Ok(None) => Err(Unread::Missing),
            Err(error) => {
                tracing::warn!(scope = SCOPE, "a vault file could not be read: {error}");
                // The hash the watcher pairs a move of such a file on: Electron's, streamed.
                // A read that failed knows no bytes, and is the only one Electron, which reads
                // any file as text, reports as `read-failed`: the open or the read itself.
                let (file_hash, failure) = match error {
                    NoteFileError::NotUtf8 | NoteFileError::TooLarge => {
                        (hash_file(&self.root, path).ok().flatten(), None)
                    }
                    NoteFileError::Open(_) | NoteFileError::Io(_) => {
                        (None, Some(error.to_string()))
                    }
                    _ => (None, None),
                };
                Err(Unread::Failed { file_hash, failure })
            }
        }
    }
}
