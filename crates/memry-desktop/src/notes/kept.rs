//! A note kept when its file was deleted outside the app (`Removed::Undecided` of
//! `notes::identity`, listed by the vault's `keptRemovals` notice, #4140). Its row names a file
//! that is gone and no text, so the note's document holds the only copy of its text. The two
//! ways out the user takes from the notice:
//!
//! - **Restore** ([`restore`]): the document's body goes to a new file at the row's path, with
//!   the frontmatter a create writes (a day's `date` first; the header `tags`: a note's record's,
//!   which hold a tag edited in the app, joined with the ones the index last read in its file,
//!   since a found file's are in no record, and a day's from that read alone; the record's
//!   properties and other names) and the body's `writing` data. The file is created, never
//!   written over one that stands there, told to the own-write record first; then the row names
//!   it as the document's, stamped before the body was read, so the note reads, saves, writes
//!   back and syncs as before. The record is not touched: a restore is a local file, nothing
//!   syncs.
//! - **Delete** ([`delete`]): the app's delete of the note or day, which tombstones the record
//!   for every device. Its text goes to the OS trash first ([`NotesService::copy_kept`], called
//!   by every app delete of a kept row, the sidebar's, the journal's and a folder delete's
//!   included), so the
//!   deleted text can be taken back from the trash, as a deleted note's unread file can. A
//!   folder that copy's write made is removed again once the copy went.
//!
//! **Fail closed.** A body that is not here yet (its server body not pulled), that owes a file's
//! text the document never took, or that a file would not hold whole is not written: a restore
//! fails and the note stays kept and listed. A delete then fails as one the trash refuses
//! (`note_trash_unavailable`), so the user is asked first, and only a delete the user confirmed
//! as permanent goes on without the copy (#3813).
//!
//! Either way the note leaves the notice once its state passed, here and not at the next open.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use memry_core::domain::journal::valid_date;
use memry_core::domain::note_files::{NoteFile as Row, StampMark};
use memry_core::domain::tags::dedupe;
use memry_core::domain::write_back::BodyRead;
use memry_core::markdown::convert::note_body::NoteBody;
use memry_core::markdown::frontmatter::{YamlValue, write_markdown_note};
use memry_core::markdown::shared::writing_tools::merge_writing_yaml;
use serde_json::{Map, Value};

use super::create::remove_file;
use super::delete::unlink;
use super::error::{NotesError, SCOPE};
use super::frontmatter::new_file_frontmatter;
use super::service::NotesService;
use crate::journal::is_reserved_day_key;
use crate::journal::write::{day_file, day_frontmatter, order_key};
use crate::locks::Locks;
use crate::session::OpenVault;
use crate::vault::app_edit::Kept;
use crate::vault::consumer::rows::{Lane, RowStat, now_ms};
use crate::vault::consumer::{Applied, ChangeSource, converter_for};
use crate::vault::embeds::Resolved;
use crate::vault::file_types::FileType;
use crate::vault::hash::content_hash;
use crate::vault::note_file::{
    NoteFileError, hash_file, large_file_class, record_large_file, write_new_text_checked,
};
use crate::vault::notices::{Listed, VaultNotices};
use crate::vault::watch::EchoGuard;

/// The names a kept note's copy tries ([`NotesService::write_kept_copy`]), as a create's.
const MAX_CANDIDATES: usize = 10_000;

/// Restores the kept note's file from its document, and takes the note off the notice. A note
/// that is gone leaves the notice too.
pub fn restore(
    notes: &NotesService,
    notices: &VaultNotices,
    open: &OpenVault,
    note_id: &str,
) -> Result<(), NotesError> {
    let restored = notes.restore_kept(open, note_id);
    if matches!(restored, Ok(()) | Err(NotesError::NotFound(_))) {
        notices.remove(&open.path, Listed::Kept { note_id, path: "" });
    }
    restored
}

/// Deletes the kept note or day, its text to the OS trash first (the module docs), and takes it
/// off the notice. One already gone is deleted.
pub fn delete(
    notes: &NotesService,
    notices: &VaultNotices,
    open: &OpenVault,
    note_id: &str,
    permanent: bool,
) -> Result<(), NotesError> {
    let deleted = match notes.recorded(open, note_id)? {
        Some(Recorded {
            date: Some(date), ..
        }) => notes.delete_day(open, &date, permanent).map(drop),
        Some(_) => notes.delete(open, note_id, permanent),
        None => Err(NotesError::NotFound(note_id.to_owned())),
    };
    match deleted {
        Ok(()) | Err(NotesError::NotFound(_)) => {
            notices.remove(&open.path, Listed::Kept { note_id, path: "" });
            Ok(())
        }
        Err(error) => Err(error),
    }
}

impl NotesService {
    /// Writes the kept note's file from its document (the module docs): a note whose row names
    /// text, or a file at its path, is not kept, and nothing is written.
    pub fn restore_kept(&self, open: &OpenVault, note_id: &str) -> Result<(), NotesError> {
        self.restore_kept_checked(open, note_id, &mut || {})
    }

    /// [`Self::restore_kept`] with a hook that runs after the new file's text is staged and
    /// before it is put in place, so a test can create a file there in the window a
    /// check-then-write would lose.
    #[doc(hidden)]
    pub fn restore_kept_checked(
        &self,
        open: &OpenVault,
        note_id: &str,
        between: &mut dyn FnMut(),
    ) -> Result<(), NotesError> {
        let recorded = self
            .recorded(open, note_id)?
            .ok_or_else(|| NotesError::NotFound(note_id.to_owned()))?;
        // A day is written in its date's order, as its create and delete are.
        let key = match &recorded.date {
            Some(date) => order_key(date),
            None => note_id.to_owned(),
        };
        self.order
            .run(&key, |_| self.restore_kept_now(open, note_id, between))
    }

    fn restore_kept_now(
        &self,
        open: &OpenVault,
        note_id: &str,
        between: &mut dyn FnMut(),
    ) -> Result<(), NotesError> {
        let root = open.path.as_path();
        let rows = self.tier.rows();
        let session = rows.session_for(&open.vault)?;
        let mut lane = rows.lane_of(session)?;
        let Some(row) = lane.files().by_id(note_id)? else {
            return Err(NotesError::NotFound(note_id.to_owned()));
        };
        if row.file_type != FileType::Markdown.as_str() {
            return Err(NotesError::NotMarkdown);
        }
        if hash_file(root, &row.path)?.is_some() {
            // The file is back: it is the note's or the user's, never written over.
            return Err(NotesError::NameConflict);
        }
        if row.content_hash.is_some() {
            // The removal is not the identity's yet; the watcher's report of it decides.
            return Err(NotesError::EditKept(Kept::FileChanged));
        }
        Locks::of(open).refuse_note(note_id, &row.path)?;
        Locks::of(open).refuse_path(&row.path)?;
        // Taken before the body is read, as the write-back's: an edit after the read leaves
        // the note behind its body, and the next pass writes it.
        let read_at = now_ms();
        let read_mark = StampMark::At(open.vault.write_back().body_mark(note_id)?);
        let (output, tags) = self.kept_text(open, &row)?;
        self.create_kept_file(root, &row.path, &output, between)?;
        let hash = content_hash(&output);
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: output.len() as u64,
            content_hash: Some(hash.clone()),
            file_hash: Some(hash.clone()),
        };
        if let Err(error) = lane.put_as_of(note_id, &row.path, stat, (read_at, read_mark)) {
            // The file holds the document's text only: taken back, the note is kept as before.
            remove_file(&self.tier.echo(), root, &row.path);
            return Err(error.into());
        }
        // The watcher skips this write's echo, so no read of it records the class.
        record_large_file(lane.files(), note_id, large_file_class(&output).is_some());
        // The tags the new file says: what an outside edit of it is read against (#3825).
        let seen = open
            .vault
            .notes_writer(self.store.clone())
            .map_err(|error| error.to_string())
            .and_then(|writer| {
                writer
                    .file_tags_seen(note_id, &tags)
                    .map_err(|error| error.to_string())
            });
        if let Err(error) = seen {
            tracing::warn!(
                scope = SCOPE,
                note_id,
                "a restored file's tags were not kept: {error}"
            );
        }
        // The note's next save replaces this file with no version of it: the document holds it.
        self.own_files
            .wrote(note_id, &hash, ChangeSource::App, None);
        lane.publish(Applied::Changed {
            note_id: note_id.to_owned(),
            path: row.path,
            content_hash: Some(hash),
            source: ChangeSource::App,
        });
        Ok(())
    }

    /// The first step of an app delete of `row` (`notes::delete`): a kept row's text is written
    /// for the delete to move to the trash ([`Self::write_kept_copy`]). `Some` when it was;
    /// `None` for a row that is not kept, or, with `permanent` (the user confirmed the delete as
    /// one for good), one whose text cannot be written. Without `permanent` that text refuses the
    /// delete as the trash would, so the user is asked.
    pub(crate) fn copy_kept(
        &self,
        lane: &Lane<'_>,
        open: &OpenVault,
        row: &Row,
        permanent: bool,
    ) -> Result<Option<KeptCopy>, NotesError> {
        match self.write_kept_copy(lane, open, row) {
            Ok(copy) => Ok(copy),
            Err(error) if permanent => {
                tracing::warn!(
                    scope = SCOPE,
                    note_id = row.note_id,
                    "a kept note deleted for good left no copy in the trash: {error}"
                );
                Ok(None)
            }
            Err(error) => Err(NotesError::TrashUnavailable(format!(
                "the kept note's text could not be written for the trash: {error}"
            ))),
        }
    }

    /// Writes the text of the kept row `row` (a markdown note's row that names no text) from its
    /// document, for a delete to move to the trash; `None` for a row that is not kept. The copy
    /// goes at the row's path, or beside it as `<name> 1.md` (as a create names a note) when
    /// anything stands there: a file the watcher has not taken yet, or one another case of the
    /// name reaches on a case-blind disk, which the delete then trashes without the note's text.
    /// A file there that the document owes its text to (`FileAhead`) is the note's own: no copy.
    pub(crate) fn write_kept_copy(
        &self,
        lane: &Lane<'_>,
        open: &OpenVault,
        row: &Row,
    ) -> Result<Option<KeptCopy>, NotesError> {
        if row.file_type != FileType::Markdown.as_str() || row.content_hash.is_some() {
            return Ok(None);
        }
        let root = open.path.as_path();
        // Another note's name, or anything on disk at it, in any case the disk folds.
        let taken = |rel: &str| {
            lane.check(&row.note_id, rel).is_err() || fs::symlink_metadata(root.join(rel)).is_ok()
        };
        let output = match self.kept_text(open, row) {
            Ok((output, _)) => output,
            Err(NotesError::EditKept(Kept::FileAhead)) if taken(&row.path) => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut copy = KeptCopy {
            at: row.path.clone(),
            made: first_missing_folder(root, &row.path)?,
        };
        for at in beside(&row.path).take(MAX_CANDIDATES) {
            if taken(&at) {
                continue;
            }
            match self.create_kept_file(root, &at, &output, &mut || {}) {
                Ok(()) => {
                    copy.at = at;
                    return Ok(Some(copy));
                }
                // Taken since the look: the next name.
                Err(NotesError::File(NoteFileError::AlreadyExists)) => {}
                Err(error) => {
                    copy.remove_made_folders(&self.tier.echo(), root);
                    return Err(error);
                }
            }
        }
        Err(NotesError::NameConflict)
    }

    /// Creates the file `at` holding `output`, told to the own-write record first; a file there
    /// is never replaced. `between`: [`Self::restore_kept_checked`]'s.
    fn create_kept_file(
        &self,
        root: &Path,
        at: &str,
        output: &str,
        between: &mut dyn FnMut(),
    ) -> Result<(), NotesError> {
        let echo = self.tier.echo();
        echo.will_write(at, &content_hash(output));
        write_new_text_checked(root, at, output, between).map_err(|error| {
            echo.cancel_write(at);
            error.into()
        })
    }

    /// The file text of the kept note `row` from its document, and the tags it says.
    fn kept_text(&self, open: &OpenVault, row: &Row) -> Result<(String, Vec<String>), NotesError> {
        let note_id = row.note_id.as_str();
        let recorded = self
            .recorded(open, note_id)?
            .ok_or_else(|| NotesError::NotFound(note_id.to_owned()))?;
        let settings = open.vault.app_settings(self.store.clone()).ok();
        // No file is read, so no author's spelling is restored and no embed of it resolved,
        // as a day's held body is written (`journal::write`).
        let embeds = Resolved::of_markdown(&open.path, &open.vault.note_files(), "", &row.path);
        let read = open.vault.write_back().body(
            &converter_for(settings.as_ref()),
            note_id,
            &row.path,
            "",
            &embeds,
        )?;
        let body = match read {
            BodyRead::Body(body) => body,
            BodyRead::NoNote => return Err(NotesError::NotFound(note_id.to_owned())),
            BodyRead::FileAhead => return Err(NotesError::EditKept(Kept::FileAhead)),
            BodyRead::BodyNotPulled => return Err(NotesError::EditKept(Kept::BodyNotPulled)),
            BodyRead::NotRepresentable(_) | BodyRead::Failed(_) => {
                return Err(NotesError::EditKept(Kept::NotRepresentable));
            }
        };
        // A note's, by the tag list's rule for a note whose file the index has not measured
        // (`memry_core::domain::tag_reads`): the record's first, which an edit in the app writes
        // before the file, then the ones the last file said, as the index measured them (a found
        // file's are in no record, `identity::tags`; none when it never read that header). A
        // day's record owns its tags, so a day's are the record's only.
        let header_tags = if recorded.date.is_some() {
            recorded.tags.clone()
        } else {
            let measured = open
                .vault
                .search()?
                .note_stats(note_id)?
                .filter(|stored| stored.stats.header_read)
                .map(|stored| stored.stats.header_tags)
                .unwrap_or_default();
            dedupe(recorded.tags.iter().chain(&measured).cloned())
        };
        let output = file_text(&recorded, &header_tags, &body)?;
        Ok((output, header_tags))
    }
}

/// What a kept note's or day's record gives its file besides the body.
struct Recorded {
    /// The day's date; `None` for a note.
    date: Option<String>,
    /// The tags the note's or day's record holds.
    tags: Vec<String>,
    aliases: Vec<String>,
    properties: Map<String, Value>,
}

impl NotesService {
    /// The live note or day `note_id`'s [`Recorded`]; `None` when there is neither.
    fn recorded(&self, open: &OpenVault, note_id: &str) -> Result<Option<Recorded>, NotesError> {
        if let Some(note) = open.vault.note_files().listed_by_id(note_id)? {
            // The listed tags add the body's: the record's own are its payload's.
            let tags = open
                .vault
                .notes()
                .metadata(note_id.to_owned())?
                .map(|meta| meta.tags)
                .unwrap_or_default();
            return Ok(Some(Recorded {
                date: note.journal_date,
                tags,
                aliases: note.aliases,
                properties: note.properties,
            }));
        }
        // A day's record is no note's (`j<YYYY-MM-DD>`, `domain::journal`).
        let Some(date) = note_id
            .strip_prefix('j')
            .filter(|date| valid_date(date).is_ok())
        else {
            return Ok(None);
        };
        let journal = open.vault.journal(self.store.clone())?;
        let Some(day) = journal
            .day(date.to_owned())?
            .filter(|day| day.id == note_id)
        else {
            return Ok(None);
        };
        let properties = day
            .properties
            .into_iter()
            .filter(|property| !is_reserved_day_key(&property.name))
            .filter_map(|property| {
                let value = serde_json::from_str(&property.value_json).ok()?;
                Some((property.name, value))
            })
            .collect();
        Ok(Some(Recorded {
            date: Some(day.date),
            tags: day.tags,
            aliases: day.aliases,
            properties,
        }))
    }
}

/// A kept row's text written for the delete's trash step ([`NotesService::write_kept_copy`]).
pub(crate) struct KeptCopy {
    /// Where the copy is: the row's path, or a free name beside it.
    pub(crate) at: String,
    /// The topmost folder the write made; `None` when the file's folder stood.
    made: Option<String>,
}

impl KeptCopy {
    /// Takes the copy back, with the folders it made: the copy holds the document's text only,
    /// so the note stays kept.
    pub(crate) fn take_back(&self, echo: &EchoGuard, root: &Path, note_id: &str) {
        if let Err(error) = unlink(echo, root, &self.at) {
            tracing::error!(scope = SCOPE, note_id, "a kept note's copy stayed: {error}");
        }
        self.remove_made_folders(echo, root);
    }

    /// Removes the folders the copy's write made, deepest first, while each is empty: a delete
    /// brings back no folder the user deleted with the file. The watcher is told of each
    /// removal first.
    pub(crate) fn remove_made_folders(&self, echo: &EchoGuard, root: &Path) {
        let Some(made) = self.made.as_deref() else {
            return;
        };
        for folder in folders_of(&self.at) {
            // `remove_dir` refuses a folder that is not empty, which is the guard wanted here.
            if let Err(error) = echo.removing(folder, || fs::remove_dir(root.join(folder))) {
                tracing::warn!(
                    scope = SCOPE,
                    "a folder made for a kept note's copy stayed: {error}"
                );
                return;
            }
            if folder == made {
                return;
            }
        }
    }
}

/// `rel`, then `<name> 1<ext>`, `<name> 2<ext>`, ... in its folder.
fn beside(rel: &str) -> impl Iterator<Item = String> + '_ {
    let (folder, name) = match rel.rsplit_once('/') {
        Some((folder, name)) => (format!("{folder}/"), name),
        None => (String::new(), rel),
    };
    let dot = name.rfind('.').filter(|&dot| dot > 0).unwrap_or(name.len());
    let (stem, ext) = name.split_at(dot);
    std::iter::once(rel.to_owned())
        .chain((1..).map(move |counter| format!("{folder}{stem} {counter}{ext}")))
}

/// The folders that hold `rel`, deepest first: `a/b`, then `a`, for `a/b/c.md`.
fn folders_of(rel: &str) -> impl Iterator<Item = &str> {
    std::iter::successors(parent_of(rel), |folder| parent_of(folder))
}

fn parent_of(rel: &str) -> Option<&str> {
    rel.rsplit_once('/').map(|(up, _)| up)
}

/// The topmost folder holding `rel` that is not on disk, which a write of `rel` makes.
fn first_missing_folder(root: &Path, rel: &str) -> Result<Option<String>, NotesError> {
    let mut missing = None;
    for folder in folders_of(rel) {
        match fs::symlink_metadata(root.join(folder)) {
            Ok(_) => break,
            Err(error) if error.kind() == ErrorKind::NotFound => missing = Some(folder.to_owned()),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(missing)
}

/// The file of `recorded` holding `body`: the frontmatter a create writes, of `tags` and the
/// record's properties and other names, with the body's `writing` data.
fn file_text(recorded: &Recorded, tags: &[String], body: &NoteBody) -> Result<String, NotesError> {
    let properties = &recorded.properties;
    let mut frontmatter = match &recorded.date {
        Some(date) => day_frontmatter(date, tags, properties),
        None => new_file_frontmatter(tags, properties),
    };
    if !recorded.aliases.is_empty() {
        let items = recorded.aliases.iter().cloned().map(YamlValue::String);
        frontmatter.insert("aliases".to_owned(), YamlValue::seq(items.collect()));
    }
    merge_writing_yaml(&mut frontmatter, &body.writing);
    Ok(match recorded.date {
        Some(_) => day_file(&frontmatter, &body.markdown)?,
        None => write_markdown_note(&frontmatter, &body.markdown)?,
    })
}
