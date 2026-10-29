//! The note a vault file is, for the vault tier (Step 13d, #3530): the tier's
//! [`NoteIdentity`] over the core's note records. The rules live in
//! `memry_core::domain::notes::identity`; this reads what only the file system
//! knows (the file's name, folder and dates, whether Electron's database is
//! beside the core's, where the journal folder is) and hands it over.
//!
//! - A markdown file is a note titled by its file name without `.md`, in the
//!   folder it is in (`extractTitleFromPath`, `vault/frontmatter.ts`). Other
//!   files are not named here yet: core creates markdown notes only, and a file
//!   note (PDF, image, audio, video) comes with its attachment bytes.
//! - A file under the journal folder is not named before Step 13m, which ports
//!   the journal day's file and id rules (`j<YYYY-MM-DD>` on every device).
//! - A new note carries the file's creation and modification times, as
//!   Electron's indexer gives a file it finds.
//!
//! Every answer is the core's; a failure is the consumer's to log and retry
//! ([`crate::vault::consumer::MAX_RETRIES`]), and the next open asks again.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::identity::{Adopted, FileNote, Moved, Removed};
use memry_core::seams::secure_store::SecureStore;

use crate::vault::config::read_vault_config;
use crate::vault::consumer::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NoteIdentity, Removal,
};
use crate::vault::file_types::FileType;

const SCOPE: &str = "note_identity";

pub struct NotesIdentity {
    store: Arc<dyn SecureStore>,
    /// The vault the withheld notice was logged for, so it is logged once per vault and
    /// process, not once per file.
    withheld_logged: Mutex<Option<std::path::PathBuf>>,
}

impl NotesIdentity {
    pub fn new(store: Arc<dyn SecureStore>) -> Arc<Self> {
        Arc::new(Self {
            store,
            withheld_logged: Mutex::new(None),
        })
    }

    fn writer(&self, ctx: &IdentityCtx<'_>) -> Result<Arc<NotesWriter>, IdentityError> {
        ctx.vault
            .notes_writer(self.store.clone())
            .map_err(|error| IdentityError::Other(error.to_string()))
    }

    fn log_withheld(&self, root: &Path) {
        let mut logged = self
            .withheld_logged
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if logged.as_deref() != Some(root) {
            *logged = Some(root.to_path_buf());
            tracing::warn!(
                scope = SCOPE,
                "this vault holds notes of the previous app version that were not imported; \
                 its files get no note until they are"
            );
        }
    }
}

impl NoteIdentity for NotesIdentity {
    fn adopt_or_create(
        &self,
        ctx: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError> {
        if file.file_type != FileType::Markdown || in_journal_folder(ctx.root, file.path) {
            return Ok(Adoption::Defer);
        }
        let (folder_path, title) = place(file.path);
        let note = FileNote {
            title,
            folder_path,
            created_ms: created_ms(&ctx.root.join(file.path)).unwrap_or(file.modified_ms),
            modified_ms: file.modified_ms,
            electron_db_beside: ctx.root.join(".memry").join("data.db").is_file(),
        };
        match self.writer(ctx)?.adopt_file(note)? {
            Adopted::Existing(id) => Ok(Adoption::Existing(id)),
            Adopted::Created(id) => Ok(Adoption::Created(id)),
            Adopted::Withheld => {
                self.log_withheld(ctx.root);
                Ok(Adoption::Defer)
            }
        }
    }

    fn on_removed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        path: &str,
    ) -> Result<Removal, IdentityError> {
        Ok(match self.writer(ctx)?.file_removed(note_id, path)? {
            Removed::Deleted => Removal::Deleted,
            Removed::Kept => Removal::Kept,
        })
    }

    fn on_renamed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<(), IdentityError> {
        let (folder_path, title) = place(new_path);
        let moved = Moved {
            old_path,
            new_path,
            title,
            folder_path,
        };
        Ok(self.writer(ctx)?.file_moved(note_id, moved)?)
    }
}

/// The folder (`None` at the root) and the title of a vault-relative `/` path: the file name
/// without `.md`, as `path.basename(p, '.md')` reads it (a name that is only `.md` keeps it).
fn place(path: &str) -> (Option<&str>, &str) {
    let (folder, name) = match path.rsplit_once('/') {
        Some((folder, name)) => (Some(folder), name),
        None => (None, path),
    };
    let title = match name.strip_suffix(".md") {
        Some(stem) if !stem.is_empty() => stem,
        _ => name,
    };
    (folder, title)
}

/// Whether `path` is under the vault's journal folder (`journalStem`,
/// `database/queries/notes/journal-queries.ts`). No journal folder configured means none.
fn in_journal_folder(root: &Path, path: &str) -> bool {
    let folder = normalize_journal_folder(&read_vault_config(root).journal_folder);
    !folder.is_empty()
        && path
            .strip_prefix(folder.as_str())
            .is_some_and(|rest| rest.starts_with('/'))
}

/// `normalizeJournalFolder` (`packages/storage-vault/src/journal-format.ts`): trimmed, `/` or
/// `\` separated, with empty, `.` and `..` segments dropped.
fn normalize_journal_folder(folder: &str) -> String {
    folder
        .trim()
        .split(['/', '\\'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty() && *segment != "." && *segment != "..")
        .collect::<Vec<_>>()
        .join("/")
}

/// When the file was created, where the file system records it.
fn created_ms(path: &Path) -> Option<i64> {
    let created = std::fs::metadata(path).ok()?.created().ok()?;
    let since = created.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_is_the_file_name_without_md_and_the_folder_its_parent() {
        assert_eq!(place("a.md"), (None, "a"));
        assert_eq!(place("x/y/a.b.md"), (Some("x/y"), "a.b"));
        assert_eq!(place("x/Note.MD"), (Some("x"), "Note.MD"));
        assert_eq!(place("x/.md"), (Some("x"), ".md"));
    }

    #[test]
    fn the_journal_folder_is_normalized_as_electron_does() {
        assert_eq!(normalize_journal_folder(" journal/ "), "journal");
        assert_eq!(normalize_journal_folder("a\\\\b/./../c"), "a/b/c");
        assert_eq!(normalize_journal_folder("  "), "");
    }
}
