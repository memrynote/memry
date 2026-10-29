//! The note a vault file is, for the vault tier (Step 13d, #3530): the tier's
//! [`NoteIdentity`] over the core's note records. The rules live in
//! `memry_core::domain::notes::identity`; this reads what only the file system
//! knows (the file's name, folder, text and dates, whether Electron's database is
//! beside the core's, where the journal folder is) and hands it over.
//!
//! A file gets a note, and a push leaves, only on evidence that the file and the
//! note are one thing and that Electron would sync it. When unsure the answer is
//! `Defer` (asked again at the next open), never a create or a delete:
//!
//! - A markdown file is a note titled by its file name without `.md`, in the
//!   folder it is in (`extractTitleFromPath`, `vault/frontmatter.ts`). Other
//!   files are not named here yet: core creates markdown notes only, and a file
//!   note (PDF, image, audio, video) comes with its attachment bytes.
//! - A large-file class markdown file (over 1 MiB, or a block over 128 KiB) is
//!   not named: Electron lists it without a body and never syncs it, and a note
//!   here would push an empty body for it.
//! - A file under the journal folder, and a move into or out of it, is left to
//!   Step 13m, which ports the journal day's file and id rules (`j<YYYY-MM-DD>`
//!   on every device, `renameKeepsJournalDate`). A vault config that is there but
//!   unreadable leaves the journal folder unknown, so no file is named then.
//! - A new note carries the file's creation and modification times, as
//!   Electron's indexer gives a file it finds.
//!
//! Every answer is the core's; a failure is the consumer's to log and retry
//! ([`crate::vault::consumer::MAX_RETRIES`]), and the next open asks again.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::identity::{Adopted, Deferral, FileNote, Moved, Removed};
use memry_core::markdown::frontmatter::split_frontmatter_block;
use memry_core::markdown::shared::markdown_class::{
    MarkdownClassThresholds, classify_markdown_content, classify_markdown_stat,
};
use memry_core::seams::secure_store::SecureStore;

use crate::vault::config::read_vault_config_strict;
use crate::vault::consumer::converter_for;
use crate::vault::consumer::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NoteIdentity, Removal,
};
use crate::vault::file_types::FileType;

const SCOPE: &str = "note_identity";

/// What is told once per vault and process, not once per file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Notice {
    ElectronNotImported,
    ConfigUnreadable,
}

pub struct NotesIdentity {
    store: Arc<dyn SecureStore>,
    told: Mutex<HashSet<(Notice, PathBuf)>>,
}

impl NotesIdentity {
    pub fn new(store: Arc<dyn SecureStore>) -> Arc<Self> {
        Arc::new(Self {
            store,
            told: Mutex::default(),
        })
    }

    fn writer(&self, ctx: &IdentityCtx<'_>) -> Result<Arc<NotesWriter>, IdentityError> {
        ctx.vault
            .notes_writer(self.store.clone())
            .map_err(|error| IdentityError::Other(error.to_string()))
    }

    fn tell_once(&self, notice: Notice, root: &Path) {
        let first = self
            .told
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert((notice, root.to_path_buf()));
        if !first {
            return;
        }
        match notice {
            Notice::ElectronNotImported => tracing::warn!(
                scope = SCOPE,
                "this vault holds the database of the previous app version, whose notes this \
                 app did not import; its files are not made notes here, so none syncs twice"
            ),
            Notice::ConfigUnreadable => tracing::warn!(
                scope = SCOPE,
                "the vault config cannot be read, so the journal folder is unknown; no file is \
                 made a note until it can be"
            ),
        }
    }

    /// Whether `path` is under the vault's journal folder; `None` when the vault config is
    /// there but unreadable.
    fn in_journal_folder(&self, root: &Path, path: &str) -> Option<bool> {
        match read_vault_config_strict(root) {
            Ok(config) => Some(under_journal_folder(&config.journal_folder, path)),
            Err(_) => {
                self.tell_once(Notice::ConfigUnreadable, root);
                None
            }
        }
    }
}

impl NoteIdentity for NotesIdentity {
    fn adopt_or_create(
        &self,
        ctx: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError> {
        if file.file_type != FileType::Markdown
            || self.in_journal_folder(ctx.root, file.path) != Some(false)
        {
            return Ok(Adoption::Defer);
        }
        let Some(text) = file.file else {
            return Ok(Adoption::Defer);
        };
        if is_large_file(file.size, &text.raw) {
            tracing::debug!(
                scope = SCOPE,
                "a large-file class markdown file is not a note"
            );
            return Ok(Adoption::Defer);
        }
        let (folder_path, title) = place(file.path);
        let note = FileNote {
            path: file.path,
            title,
            folder_path,
            body: split_frontmatter_block(&text.raw).body,
            created_ms: created_ms(&ctx.root.join(file.path)).unwrap_or(file.modified_ms),
            modified_ms: file.modified_ms,
            electron_db_beside: ctx.root.join(".memry").join("data.db").is_file(),
        };
        let converter = || converter_for(ctx.vault.app_settings(self.store.clone()).ok().as_ref());
        let adopted = self
            .writer(ctx)?
            .adopt_file(note, converter)
            .map_err(|error| IdentityError::Other(error.to_string()))?;
        Ok(match adopted {
            Adopted::Existing(id) => Adoption::Existing(id),
            Adopted::Created(id) => Adoption::Created(id),
            Adopted::Deferred(Deferral::ElectronNotImported) => {
                self.tell_once(Notice::ElectronNotImported, ctx.root);
                Adoption::Defer
            }
            Adopted::Deferred(Deferral::Undecided) => {
                tracing::debug!(
                    scope = SCOPE,
                    "a note with this file's name may be this file; asked again at the next open"
                );
                Adoption::Defer
            }
        })
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

    /// A move into or out of the journal folder changes what the file is (a note or a journal
    /// day); Electron then deletes the old item and lists the file as a new one. Until Step 13m
    /// ports that, the record is left as it is and nothing is pushed: the row follows the file.
    // TODO(#3530 13m): port `renameKeepsJournalDate` (`vault/watcher.ts`) here, and split the
    // rows of notes this left under the journal folder.
    fn on_renamed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<(), IdentityError> {
        let crosses = [old_path, new_path]
            .iter()
            .any(|path| self.in_journal_folder(ctx.root, path) != Some(false));
        if crosses {
            tracing::info!(
                scope = SCOPE,
                note_id,
                "a move into or out of the journal folder leaves the note's record as it was"
            );
            return Ok(());
        }
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

/// Large-file class (`packages/shared/src/markdown-class.ts`): the size alone, else the text.
fn is_large_file(size: u64, raw: &str) -> bool {
    let thresholds = MarkdownClassThresholds::default();
    let by_size = usize::try_from(size).map_or(true, |bytes| {
        classify_markdown_stat(bytes, thresholds).is_some()
    });
    by_size
        || classify_markdown_content(raw, thresholds)
            .large_file
            .is_some()
}

/// The folder (`None` at the root) and the title of a vault-relative `/` path: the file name
/// without `.md`, as `path.basename(p, '.md')` reads it (a name that is only `.md` keeps it).
/// Exact: a title that differs from a record's only in case or Unicode normalization is
/// another title, as it is to Electron.
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

/// Whether `path` is under `journal_folder` (`journalStem`,
/// `database/queries/notes/journal-queries.ts`). No journal folder configured means none.
fn under_journal_folder(journal_folder: &str, path: &str) -> bool {
    let folder = normalize_journal_folder(journal_folder);
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
        assert!(under_journal_folder("journal", "journal/2025-01-01.md"));
        assert!(!under_journal_folder("journal", "journals/2025-01-01.md"));
        assert!(!under_journal_folder("", "journal/2025-01-01.md"));
    }

    #[test]
    fn the_large_file_class_is_the_size_or_a_block() {
        assert!(!is_large_file(5, "small"));
        assert!(is_large_file(2 * 1024 * 1024, "small"));
        assert!(is_large_file(200 * 1024, &"x".repeat(200 * 1024)));
        assert!(!is_large_file(200 * 1024, &"x\n\n".repeat(60 * 1024)));
    }
}
