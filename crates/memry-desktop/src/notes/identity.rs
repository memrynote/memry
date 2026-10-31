//! The note or journal day a vault file is, for the vault tier (Steps 13d and 13m,
//! #3530): the tier's [`NoteIdentity`] over the core's records. The rules live in
//! `memry_core::domain::notes::{identity, journal_day}`; this reads what only the
//! file system knows (the file's name, folder, text and dates, whether Electron's
//! database is beside the core's, where the journal days are) and hands it over.
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
//!   not named: Electron never syncs it, and a note here would push an empty
//!   body for it. Electron does list it, as a read-only note of this device
//!   (`syncLargeFileBodyToCache`, `vault/note-sync.ts`); here it is not listed
//!   until the large-file viewer is ported (Step 14, #3531). A note that grows
//!   into the class after it was named stays a note: its record was synced, so a
//!   move still edits it, as Electron's `processRename`
//!   (`vault/rename-tracker.ts`) does. Its removal keeps it (below), where
//!   Electron deletes it.
//! - A file whose path names a day is that day's journal entry, `j<YYYY-MM-DD>`
//!   on every device: it is under the journal folder and its path below it,
//!   without `.md`, parses in the journal date format (`extractDateFromPath`,
//!   `database/queries/notes/journal-queries.ts`), unless a live note no row names already
//!   has its folder and title: that note claims it, as Electron keeps a claimed id
//!   (`vault/watcher.ts`). Any other file is a note, one under the journal folder included
//!   (`newMarkdownFileId`). Which day a path names is `JournalDays`'s
//!   (`vault::journal_format`), from the vault config read at every ask: a config changed
//!   while the vault is open applies to the next file event.
//! - A move keeps what the file is when the record's day (none for a note) is the
//!   day the new path names (`renameKeepsJournalDate`, `vault/watcher.ts`): a
//!   note's record takes the new title and folder, and a day's record is left as
//!   it is, since a day's path is never synced. A move that changes what the file
//!   is (a note into a day, a day out of the journal or to another day) Electron
//!   applies as a delete of the record and a new one for the file; here the
//!   record is left as it was, and owed the move, until the journal service
//!   (Step 13m part 2) ports that together with the journal folder follow. A
//!   vault config that is there but unreadable leaves the journal days unknown,
//!   so no file is named then, and every move is owed. An owed move is applied on
//!   a later ask once the config reads and the move keeps what the file is.
//! - A new note carries the file's creation and modification times, as
//!   Electron's indexer gives a file it finds.
//! - A removed file deletes its note only when its row says the file held the
//!   whole note: the row knows the bytes on disk (a move pairs on them, #3744),
//!   the document holds them, no edit came after the row's stamp, and no body is
//!   owed a pull. Otherwise (a large-file class text or a refused feed the
//!   document did not take, an app edit the write-back could not write, a pulled
//!   change not written yet, a server body not here yet) the note is kept, with a
//!   warning: a tombstone would delete on every device what the file never had.
//!
//! Every answer is the core's; a failure is the consumer's to log and retry
//! ([`crate::vault::consumer::MAX_RETRIES`]), and the next open asks again.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::identity::{Adopted, Deferral, FileNote, Moved, Removed};
use memry_core::domain::notes::journal_day::FileDay;
use memry_core::markdown::convert::EmbedResolver;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::frontmatter::split_frontmatter_block;
use memry_core::markdown::shared::markdown_class::{
    MarkdownClassThresholds, classify_markdown_content, classify_markdown_stat,
};
use memry_core::seams::secure_store::SecureStore;

use crate::vault::config::read_vault_config_strict;
use crate::vault::consumer::converter_of;
use crate::vault::consumer::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NoteIdentity, Removal,
};
use crate::vault::embeds::Resolved;
use crate::vault::file_types::FileType;
use crate::vault::journal_format::JournalDays;

const SCOPE: &str = "note_identity";

/// What is told once per vault and process, not once per file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Notice {
    ElectronNotImported,
    ConfigUnreadable,
    Undecided,
}

pub struct NotesIdentity {
    store: Arc<dyn SecureStore>,
    told: Mutex<HashSet<(Notice, PathBuf)>>,
    /// The vaults whose owed moves were settled since they opened, and none owed since.
    settled: Mutex<HashSet<PathBuf>>,
    /// The journal days of the last config read, kept while the config says the same.
    days: Mutex<Option<JournalDays>>,
}

impl NotesIdentity {
    pub fn new(store: Arc<dyn SecureStore>) -> Arc<Self> {
        Arc::new(Self {
            store,
            told: Mutex::default(),
            settled: Mutex::default(),
            days: Mutex::default(),
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
            // TODO(#3531 Step 14): tell the user, in one notice with this step's unreadable
            // config, undecided files and kept removals (`on_removed`): until the import runs,
            // this vault names no file.
            Notice::ElectronNotImported => tracing::warn!(
                scope = SCOPE,
                "this vault holds the database of the previous app version, whose notes this \
                 app did not import; its files are not made notes here, so none syncs twice"
            ),
            Notice::ConfigUnreadable => tracing::warn!(
                scope = SCOPE,
                "the vault config cannot be read, so the journal days are unknown; no file is \
                 made a note or a day, and no move reaches its record, until it can be"
            ),
            Notice::Undecided => tracing::info!(
                scope = SCOPE,
                "a file has the name of a note or a day whose text is not the file's, or not \
                 here yet; it is not named, and the next open asks again"
            ),
        }
    }

    /// Where the vault's journal days are; `None` when the vault config is there but unreadable.
    /// Read at every ask, so a config changed while the vault is open applies to the next file
    /// event; compiled again only when it changed.
    fn journal(&self, root: &Path) -> Option<JournalDays> {
        match read_vault_config_strict(root) {
            Ok(config) => {
                let (folder, format) = (&config.journal_folder, &config.journal_date_format);
                let mut days = self.days.lock().unwrap_or_else(PoisonError::into_inner);
                if !days.as_ref().is_some_and(|days| days.is_of(folder, format)) {
                    *days = Some(JournalDays::new(folder, format));
                }
                days.clone()
            }
            Err(_) => {
                self.tell_once(Notice::ConfigUnreadable, root);
                None
            }
        }
    }

    /// What a file no row names is, from the core's answer.
    fn adoption(&self, adopted: Adopted, root: &Path) -> Adoption {
        match adopted {
            Adopted::Existing(id) => Adoption::Existing(id),
            Adopted::Created(id) => Adoption::Created(id),
            Adopted::Deferred(Deferral::ElectronNotImported) => {
                self.tell_once(Notice::ElectronNotImported, root);
                Adoption::Defer
            }
            Adopted::Deferred(Deferral::Undecided) => {
                self.tell_once(Notice::Undecided, root);
                Adoption::Defer
            }
        }
    }

    /// What reads a record's body for comparing with the file at `path` whose markdown below
    /// its frontmatter is `body`. Built before the core's writer is held: the embed lookup
    /// reads the rows.
    fn reader(
        &self,
        ctx: &IdentityCtx<'_>,
        path: &str,
        body: &str,
    ) -> Result<(Converter, Resolved), IdentityError> {
        let embeds = Resolved::of_markdown(ctx.root, &ctx.vault.note_files(), body, path);
        Ok((self.converter(ctx)?, embeds))
    }

    /// The converter that reads a note's body for comparing with a file. Fails, so the file is
    /// asked again, when the vault's callout types cannot be read: without them a callout
    /// writes out as another text, and a note that is the file would not look like it.
    fn converter(&self, ctx: &IdentityCtx<'_>) -> Result<Converter, IdentityError> {
        let settings = ctx
            .vault
            .app_settings(self.store.clone())
            .map_err(|error| IdentityError::Other(format!("app settings: {error}")))?;
        Ok(converter_of(&settings)?)
    }

    /// Applies the moves the records are owed whose file is outside the journal folder now,
    /// but `skip`'s (whose move the caller is about to apply): once per open, at the open or
    /// at the first ask after it that reads the vault config, and again after a move is owed.
    /// A failure is logged and does not fail the ask it came with: the next open tries again.
    fn settle_owed(
        &self,
        root: &Path,
        writer: &NotesWriter,
        journal: &JournalDays,
        skip: Option<&str>,
    ) {
        let first = self
            .settled
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(root.to_path_buf());
        if !first {
            return;
        }
        let owed = match writer.owed_places() {
            Ok(owed) => owed,
            Err(error) => {
                return tracing::error!(scope = SCOPE, "the owed moves could not be read: {error}");
            }
        };
        for owed in owed {
            if skip == Some(owed.note_id.as_str()) {
                continue;
            }
            match keeps_kind(journal, writer, &owed.note_id, &owed.path) {
                Ok(true) => {}
                Ok(false) => continue,
                Err(error) => {
                    tracing::error!(
                        scope = SCOPE,
                        note_id = owed.note_id,
                        "an owed move's record could not be read: {error}"
                    );
                    continue;
                }
            }
            // From the row's path: the record still says the owed one, and owing dropped the
            // note's slot there, so a slot at it now is another file's.
            let (folder_path, title) = place(&owed.path);
            let moved = Moved {
                old_path: &owed.path,
                new_path: &owed.path,
                title,
                folder_path,
            };
            if let Err(error) = writer.file_moved(&owed.note_id, moved) {
                tracing::error!(
                    scope = SCOPE,
                    note_id = owed.note_id,
                    "an owed move did not reach its note: {error}"
                );
            }
        }
    }
}

impl NoteIdentity for NotesIdentity {
    /// Settles the moves owed from an earlier session, when the vault config reads; else the
    /// first ask that reads it does.
    fn opened(&self, ctx: &IdentityCtx<'_>) {
        self.settled
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(ctx.root);
        let Some(journal) = self.journal(ctx.root) else {
            return;
        };
        match self.writer(ctx) {
            Ok(writer) => self.settle_owed(ctx.root, &writer, &journal, None),
            Err(error) => tracing::warn!(
                scope = SCOPE,
                "the owed moves wait for the first ask: {error}"
            ),
        }
    }

    fn adopt_or_create(
        &self,
        ctx: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError> {
        if file.file_type != FileType::Markdown {
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
        let Some(journal) = self.journal(ctx.root) else {
            return Ok(Adoption::Defer);
        };
        let writer = self.writer(ctx)?;
        self.settle_owed(ctx.root, &writer, &journal, None);
        let body = split_frontmatter_block(&text.raw).body;
        let created_ms = created_ms(&ctx.root.join(file.path)).unwrap_or(file.modified_ms);
        let electron_db_beside = ctx.root.join(".memry").join("data.db").is_file();
        let (folder_path, title) = place(file.path);
        // A note that claims the file's place keeps it, a day's path too (`claimed`,
        // `vault/watcher.ts`): the file is that note or waits, never a second id for it.
        let claimed = writer.may_be_a_note(title, folder_path)?;
        let adopted = match journal.day_of(file.path) {
            Some(date) if !claimed => {
                let day = FileDay {
                    path: file.path,
                    date: &date,
                    title,
                    folder_path,
                    body,
                    created_ms,
                    modified_ms: file.modified_ms,
                    electron_db_beside,
                };
                let reader = if writer.may_be_a_day(&date)? {
                    Some(self.reader(ctx, file.path, body)?)
                } else {
                    None
                };
                let (converter, embeds) = parts(reader.as_ref());
                writer.adopt_day(day, converter, embeds)
            }
            _ => {
                let note = FileNote {
                    path: file.path,
                    title,
                    folder_path,
                    body,
                    created_ms,
                    modified_ms: file.modified_ms,
                    electron_db_beside,
                };
                let reader = if claimed {
                    Some(self.reader(ctx, file.path, body)?)
                } else {
                    None
                };
                let (converter, embeds) = parts(reader.as_ref());
                writer.adopt_file(note, converter, embeds)
            }
        };
        let adopted = adopted.map_err(|error| IdentityError::Other(error.to_string()))?;
        Ok(self.adoption(adopted, ctx.root))
    }

    fn on_removed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        path: &str,
    ) -> Result<Removal, IdentityError> {
        Ok(match self.writer(ctx)?.file_removed(note_id, path)? {
            Removed::Deleted => Removal::Deleted,
            // A file that is truly gone leaves a note the user deleted outside the app: told in
            // the Step 14 notice (TODO at `Notice::ElectronNotImported`).
            Removed::Undecided => {
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    "a removed file's note is kept: its row does not say the file held the whole \
                     note (the removal may be a move, or the note has text the file never had)"
                );
                Removal::Kept
            }
        })
    }

    /// A move that keeps what the file is reaches the record (`renameKeepsJournalDate`). One
    /// that changes it, a note into a day, a day out of the journal or to another day, Electron
    /// applies as a delete and a new item; until the journal service (Step 13m part 2) ports
    /// that, with the journal folder follow (`journal-folder-follow.ts`), the record is left as
    /// it is and nothing is pushed: the row follows the file, and the record is owed the move.
    /// So is a move while the journal days are unknown.
    // TODO(#3530 13m part 2): port the delete and re-create of a move that changes what the
    // file is, and the journal folder follow, then settle such owed moves (`owed_places`).
    fn on_renamed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<(), IdentityError> {
        let writer = self.writer(ctx)?;
        let journal = self.journal(ctx.root);
        let keeps = match &journal {
            Some(journal) => keeps_kind(journal, &writer, note_id, new_path)?,
            None => false,
        };
        if !keeps {
            tracing::info!(
                scope = SCOPE,
                note_id,
                "a move that may change a file between note and journal day leaves the record \
                 as it was, owed"
            );
            writer.owe_place(note_id, old_path)?;
            self.settled
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(ctx.root);
            return Ok(());
        }
        if let Some(journal) = &journal {
            self.settle_owed(ctx.root, &writer, journal, Some(note_id));
        }
        let (folder_path, title) = place(new_path);
        let moved = Moved {
            old_path,
            new_path,
            title,
            folder_path,
        };
        Ok(writer.file_moved(note_id, moved)?)
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

/// Whether the record `id` at `path` is what it was: its day (none for a note) is the day
/// `path` names.
fn keeps_kind(
    journal: &JournalDays,
    writer: &NotesWriter,
    id: &str,
    path: &str,
) -> Result<bool, IdentityError> {
    Ok(writer.journal_date(id)? == journal.day_of(path))
}

/// The converter and the embed lookup of a reader, borrowed.
fn parts(
    reader: Option<&(Converter, Resolved)>,
) -> (Option<&Converter>, Option<&dyn EmbedResolver>) {
    match reader {
        Some((converter, embeds)) => (Some(converter), Some(embeds as &dyn EmbedResolver)),
        None => (None, None),
    }
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
    fn the_large_file_class_is_the_size_or_a_block() {
        assert!(!is_large_file(5, "small"));
        assert!(is_large_file(2 * 1024 * 1024, "small"));
        assert!(is_large_file(200 * 1024, &"x".repeat(200 * 1024)));
        assert!(!is_large_file(200 * 1024, &"x\n\n".repeat(60 * 1024)));
    }
}
