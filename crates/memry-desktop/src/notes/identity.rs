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
//!   (`vault/watcher.ts`). The core decides claim or day in one transaction, so a pull that
//!   removes or adds the note meanwhile never gives a day's path a note id or a second id.
//!   Any other file is a note, one under the journal folder included
//!   (`newMarkdownFileId`). Which day a path names is `JournalDays`'s
//!   (`vault::journal_format`), from the vault config read at every ask: a config changed
//!   while the vault is open applies to the next file event.
//! - A move keeps what the file is when the record's day (none for a note) is the
//!   day the new path names (`renameKeepsJournalDate`, `vault/watcher.ts`): a
//!   note's record takes the new title and folder, and a day's record is left as
//!   it is, since a day's path is never synced. A move that changes what the file
//!   is (a note into a day, a day out of the journal or to another day) deletes
//!   the record and the file is made anew ([`Rename::Crossed`]), as Electron does,
//!   unless the removal may not delete it (below): then the record is left as it
//!   was, owed the move. A vault config that is there but unreadable leaves the
//!   journal days unknown, so no file is named then, and every move is owed. An
//!   owed move that keeps what the file is is applied on a later ask once the
//!   config reads; one that changes it, at the next open's walk
//!   ([`NoteIdentity::settle_crossings`]). So is the app's own move that changes it.
//! - A new note carries the file's creation and modification times, as
//!   Electron's indexer gives a file it finds.
//! - A removed file deletes its note only when its row says the file held the
//!   whole note: the row knows the bytes on disk (a move pairs on them, #3744),
//!   the document holds them, no edit came after the row's stamp, and no body is
//!   owed a pull. Otherwise (a large-file class text or a refused feed the
//!   document did not take, an app edit the write-back could not write, a pulled
//!   change not written yet, a server body not here yet) the note is kept, with a
//!   warning: a tombstone would delete on every device what the file never had.
//! - An outside edit of the file a row named gives the record the file's frontmatter `tags`
//!   (#3825, [`tags`]): a note's record takes the file's list, a journal day's what the edit
//!   changed in it, so the tags only a day's record holds stay.
//! - The file's frontmatter property values reach the record ([`properties`]): a found file's
//!   fill the keys its record lacks, and an outside edit gives it what the edit changed since
//!   the record last took the file.
//! - The old and new path of an app move the core still records are that move's note's: no
//!   removal, pairing or new note there until the open that finishes the move ([`moving`]).
//!
//! Every answer is the core's; a failure is the consumer's to log and retry
//! ([`crate::vault::consumer::MAX_RETRIES`]), and the next open asks again.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::identity::{Adopted, Deferral, FileNote, Moved, Removed};
use memry_core::domain::notes::journal_day::FileDay;
use memry_core::markdown::convert::EmbedResolver;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::frontmatter::split_frontmatter_block;
use memry_core::seams::secure_store::SecureStore;

use crate::vault::app_move::on_disk;
use crate::vault::consumer::converter_of;
use crate::vault::consumer::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NewFile, NoteIdentity, Removal, Rename,
    Settled,
};
use crate::vault::embeds::Resolved;
use crate::vault::file_types::FileType;
use crate::vault::journal_format::JournalDays;
use crate::vault::note_file::NoteFile;
use crate::vault::notices::{Listed, VaultNotices};

mod file;
mod moving;
mod new_files;
mod notices;
mod properties;
mod tags;

use file::created_ms;
pub(super) use file::{electron_db_beside, is_large_file, place};
use notices::Notice;

use super::owed_moves::{self, held, keeps_kind};

const SCOPE: &str = "note_identity";

pub struct NotesIdentity {
    store: Arc<dyn SecureStore>,
    told: Mutex<HashSet<(Notice, PathBuf)>>,
    /// Where the vault states the user can act on are shown.
    notices: Arc<VaultNotices>,
    /// The vaults whose owed moves were settled since they opened, and none owed since.
    settled: Mutex<HashSet<PathBuf>>,
    /// The journal days of the last config read, kept while the config says the same.
    days: Mutex<Option<JournalDays>>,
}

impl NotesIdentity {
    /// With a board of its own that no session opens, so it shows nothing.
    pub fn new(store: Arc<dyn SecureStore>) -> Arc<Self> {
        Self::noticing(store, VaultNotices::new())
    }

    /// Raises the vault states the user can act on on `notices`.
    pub fn noticing(store: Arc<dyn SecureStore>, notices: Arc<VaultNotices>) -> Arc<Self> {
        Arc::new(Self {
            store,
            told: Mutex::default(),
            notices,
            settled: Mutex::default(),
            days: Mutex::default(),
        })
    }

    pub(super) fn writer(&self, ctx: &IdentityCtx<'_>) -> Result<Arc<NotesWriter>, IdentityError> {
        ctx.vault
            .notes_writer(self.store.clone())
            .map_err(|error| IdentityError::Other(error.to_string()))
    }

    /// What the file at `path` no row names is, from the core's answer.
    fn adoption(&self, adopted: Adopted, root: &Path, path: &str) -> Adoption {
        match adopted {
            Adopted::Existing(id) => {
                self.named(root, path);
                Adoption::Existing(id)
            }
            Adopted::Created(id) => {
                self.named(root, path);
                Adoption::Created(id)
            }
            Adopted::Deferred(Deferral::ElectronNotImported) => {
                self.tell_once(Notice::ElectronNotImported, root);
                Adoption::Defer
            }
            Adopted::Deferred(Deferral::Undecided) => {
                self.undecided(root, path);
                Adoption::Defer
            }
        }
    }

    /// What reads a record's body for comparing with the file at `path` whose markdown below
    /// its frontmatter is `body`. Built before the core's writer is held: the embed lookup
    /// reads the rows.
    pub(super) fn reader(
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

    /// A move was owed: the next ask settles the vault's owed moves again.
    fn unsettle(&self, root: &Path) {
        self.settled
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(root);
    }

    /// Applies the owed moves that keep what their file is (a crossing is the consumer's,
    /// [`NoteIdentity::settle_crossings`]), but `skip`'s (whose move the caller is about to
    /// apply): once per open, at the open or
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
    /// An Electron vault whose notes were not imported: by the core's rule, a file of it that
    /// matches no note the core has defers ([`Deferral::ElectronNotImported`]) instead of
    /// getting a new id. One whose answer cannot be read is left too, as the file asks then
    /// fail.
    fn leaves_vault(&self, ctx: &IdentityCtx<'_>) -> bool {
        if !electron_db_beside(ctx.root) {
            return false;
        }
        let mints = self
            .writer(ctx)
            .and_then(|writer| Ok(writer.mints_beside_electron()?));
        match mints {
            Ok(mints) => !mints,
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    "whether this vault's notes were imported could not be read: {error}"
                );
                true
            }
        }
    }

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

    fn watch_limited(&self, ctx: &IdentityCtx<'_>) {
        self.watch_limit(ctx.root);
    }

    fn file_returned(&self, ctx: &IdentityCtx<'_>, note_id: &str) {
        self.returned(ctx.root, note_id);
    }

    fn notices(&self) -> Option<Arc<VaultNotices>> {
        Some(self.notices.clone())
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
        if moving::is_moving_to(&writer, file.path)? {
            tracing::info!(
                scope = SCOPE,
                "a file at the new path of an unfinished app move waits for the open that \
                 finishes it"
            );
            return Ok(Adoption::Defer);
        }
        self.settle_owed(ctx.root, &writer, &journal, None);
        let split = split_frontmatter_block(&text.raw);
        let body = split.body;
        let created_ms = created_ms(&ctx.root.join(file.path)).unwrap_or(file.modified_ms);
        let electron_db_beside = electron_db_beside(ctx.root);
        let (folder_path, title) = place(file.path);
        // Whether a reader is built only: the core decides in its transaction whether a note
        // claims a day's path. A note pulled in after this read makes the day file wait.
        let may_be_a_note = writer.may_be_a_note(title, folder_path)?;
        let adopted = match journal.day_of(file.path) {
            Some(date) => {
                let declared = tags::of_block(split.block);
                let tags = declared.clone().unwrap_or_default();
                let day = FileDay {
                    path: file.path,
                    date: &date,
                    title,
                    folder_path,
                    body,
                    tags: &tags,
                    created_ms,
                    modified_ms: file.modified_ms,
                    electron_db_beside,
                };
                let reader = if may_be_a_note || writer.may_be_a_day(&date)? {
                    Some(self.reader(ctx, file.path, body)?)
                } else {
                    None
                };
                let (converter, embeds) = parts(reader.as_ref());
                let adopted = writer.adopt_day(day, converter, embeds);
                if let (Ok(Adopted::Created(id) | Adopted::Existing(id)), Some(declared)) =
                    (&adopted, &declared)
                {
                    tags::found(&writer, id, declared);
                }
                adopted
            }
            None => {
                let note = FileNote {
                    path: file.path,
                    title,
                    folder_path,
                    body,
                    created_ms,
                    modified_ms: file.modified_ms,
                    electron_db_beside,
                };
                let reader = if may_be_a_note {
                    Some(self.reader(ctx, file.path, body)?)
                } else {
                    None
                };
                let (converter, embeds) = parts(reader.as_ref());
                writer.adopt_file(note, converter, embeds)
            }
        };
        let adopted = adopted.map_err(|error| IdentityError::Other(error.to_string()))?;
        if let Adopted::Created(id) | Adopted::Existing(id) = &adopted {
            properties::found(&writer, ctx, self.store.clone(), id, text)?;
        }
        Ok(self.adoption(adopted, ctx.root, file.path))
    }

    fn may_be_new(&self, ctx: &IdentityCtx<'_>, files: &[Candidate<'_>]) -> Vec<bool> {
        new_files::may_be_new(self, ctx, files)
    }

    fn adopt_new_files(
        &self,
        ctx: &IdentityCtx<'_>,
        files: &[NewFile<'_>],
    ) -> Result<Vec<bool>, IdentityError> {
        new_files::adopt(self, ctx, files)
    }

    fn on_removed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        path: &str,
    ) -> Result<Removal, IdentityError> {
        let writer = self.writer(ctx)?;
        if moving::is_moving_from(&writer, note_id, path)? {
            // Not `Kept`, which drops the row's hash: row and hash stay as they are, so the
            // finished move carries them and the file's later edits and removal reach the note.
            return Err(moving::waits());
        }
        let path_on_disk = on_disk(ctx.root, path).to_string_lossy().into_owned();
        let renamed = Listed::Renamed {
            note_id,
            path: &path_on_disk,
        };
        self.notices.remove(ctx.root, renamed);
        Ok(match writer.file_removed(note_id, path)? {
            Removed::Deleted => Removal::Deleted,
            // A file that is truly gone leaves a note the user deleted outside the app: listed,
            // and again by every open's walk while the row has no file.
            Removed::Undecided => {
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    "a removed file's note is kept: its row does not say the file held the whole \
                     note (the removal may be a move, or the note has text the file never had)"
                );
                self.kept(ctx.root, note_id, path);
                Removal::Kept
            }
        })
    }

    /// The file's frontmatter `tags` and property values reach the record ([`tags::edited`],
    /// [`properties::edited`]).
    fn on_changed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        previous: &str,
        file: &NoteFile,
    ) -> Result<(), IdentityError> {
        let writer = self.writer(ctx)?;
        tags::edited(&writer, ctx.search, note_id, previous, file)?;
        properties::edited(&writer, ctx, self.store.clone(), note_id, previous, file)
    }

    /// A move that keeps what the file is reaches the record (`renameKeepsJournalDate`). One
    /// that changes it, a note into a day, a day out of the journal or to another day, deletes
    /// the record for the consumer to make the file anew, as Electron does; one whose removal
    /// may not delete it is owed the move, and so is a move while the journal days are
    /// unknown, and so is a day the whole journal folder carried ([`held`]): crossed, a folder
    /// renamed in Finder would delete every day. Neither pushes anything; the row follows the file.
    fn on_renamed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<Rename, IdentityError> {
        let writer = self.writer(ctx)?;
        if moving::is_moving_from(&writer, note_id, old_path)? {
            return Err(moving::waits());
        }
        let Some(journal) = self.journal(ctx.root) else {
            tracing::info!(
                scope = SCOPE,
                note_id,
                "a move while the journal days are unknown leaves the record as it was, owed"
            );
            writer.owe_place(note_id, old_path)?;
            self.unsettle(ctx.root);
            return Ok(Rename::Followed);
        };
        let notices = Some(&*self.notices);
        if held(
            ctx.root,
            &journal,
            &writer,
            notices,
            (note_id, old_path, new_path),
        )? {
            tracing::info!(
                scope = SCOPE,
                note_id,
                "a day the journal folder carried is held, owed"
            );
            self.unsettle(ctx.root);
            return Ok(Rename::Followed);
        }
        if !keeps_kind(&journal, &writer, note_id, new_path)? {
            return match owed_moves::cross(
                self, ctx, &writer, &journal, note_id, old_path, new_path,
            )? {
                Some(Removed::Deleted) => Ok(Rename::Crossed),
                Some(Removed::Undecided) | None => {
                    tracing::warn!(
                        scope = SCOPE,
                        note_id,
                        "a move between note and journal day leaves the record as it was, owed: \
                         the note has text its file does not, or the day is here already"
                    );
                    self.unsettle(ctx.root);
                    Ok(Rename::Followed)
                }
            };
        }
        self.settle_owed(ctx.root, &writer, &journal, Some(note_id));
        let (folder_path, title) = place(new_path);
        let moved = Moved {
            old_path,
            new_path,
            title,
            folder_path,
        };
        writer.file_moved(note_id, moved)?;
        Ok(Rename::Followed)
    }

    /// [`owed_moves::cross_renamed`].
    fn cross_renamed_day(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        path: &str,
    ) -> Result<bool, IdentityError> {
        let Some(journal) = self.journal(ctx.root) else {
            return Err(IdentityError::Other("the journal days are unknown".into()));
        };
        let writer = self.writer(ctx)?;
        owed_moves::cross_renamed(self, ctx, &journal, &writer, (note_id, path))
    }

    /// [`owed_moves::follow_held`].
    fn follow_held(&self, ctx: &IdentityCtx<'_>) -> bool {
        owed_moves::follow_held(self, ctx)
    }

    /// The owed moves that change what their file is, now that the journal days are known
    /// ([`owed_moves::crossings`]).
    fn settle_crossings(&self, ctx: &IdentityCtx<'_>) -> Settled {
        let Some(journal) = self.journal(ctx.root) else {
            return Settled::default();
        };
        match self.writer(ctx) {
            Ok(writer) => owed_moves::crossings(self, ctx, &journal, &writer),
            Err(error) => {
                tracing::error!(scope = SCOPE, "the owed moves could not be read: {error}");
                Settled::default()
            }
        }
    }

    /// The rule [`Self::on_renamed`] follows, for the app's own move: the journal days unknown
    /// keep nothing.
    fn keeps_kind(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        new_path: &str,
    ) -> Result<bool, IdentityError> {
        match self.journal(ctx.root) {
            Some(journal) => keeps_kind(&journal, &*self.writer(ctx)?, note_id, new_path),
            None => Ok(false),
        }
    }
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
