//! [`NotesWriter`]'s answers to the desktop vault tier about the note or journal
//! day a vault file is (Steps 13d, 13m): [`crate::domain::notes::identity`] and
//! [`crate::domain::notes::journal_day`], and the desktop app's own create of a
//! note it writes a file for (Step 13f). Not exported over UniFFI: iOS keeps no
//! vault files. Every method blocks; the shell runs them on the tier's consumer
//! thread or in `spawn_blocking`.

use super::{NotesWriter, now_ms};
use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::domain::notes::app_move::{self, AppMoved, BeginError, FolderRecorded, Recorded};
use crate::domain::notes::file_tags;
use crate::domain::notes::folder_delete::{self, FolderDeleteRecorded};
use crate::domain::notes::identity::{
    self, Adopted, Crossing, FileNote, Moved, OwedPlace, Removed,
};
use crate::domain::notes::journal_day::{self, FileDay};
use crate::domain::notes::new_files::{self, NewFileNote};
use crate::domain::notes::{self, NewNote};
use crate::domain::properties;
use crate::domain::{folders, journal};
use crate::markdown::convert::EmbedResolver;
use crate::markdown::convert::api::Converter;
use crate::storage::repositories::schema::Object;

impl NotesWriter {
    /// Creates a note the app is about to write a file for, with the file's frontmatter tags,
    /// its user properties and its icon, in one transaction with its one outbox row (desktop
    /// `createNote`). The body is not written here: the file's text seeds the document once
    /// the file is on disk, as [`Self::create`] says why.
    pub fn create_with(
        &self,
        title: &str,
        folder_path: Option<&str>,
        tags: &[String],
        properties: Option<&Object>,
        emoji: Option<&str>,
    ) -> Result<String, StorageError> {
        let id = Self::new_id();
        let device_id = self.device_id.clone();
        let note = NewNote {
            id: &id,
            title,
            folder_path,
            content: "",
            tags,
            properties,
            emoji,
        };
        self.db.call_blocking(|conn| {
            let _payload = notes::create(conn, &note, &device_id, now_ms())?.acknowledge();
            Ok(())
        })?;
        Ok(id)
    }

    /// Whether a note may be the file of this title and folder: [`Self::adopt_file`]
    /// then needs a converter to read its body with.
    pub fn may_be_a_note(
        &self,
        title: &str,
        folder_path: Option<&str>,
    ) -> Result<bool, StorageError> {
        self.db
            .call_blocking(move |conn| identity::has_unfiled_note(conn, title, folder_path))
    }

    /// Whether a file beside Electron's database may get a new note id
    /// ([`identity::mints_beside_electron`]).
    pub fn mints_beside_electron(&self) -> Result<bool, StorageError> {
        self.db
            .call_blocking(|conn| identity::mints_beside_electron(conn))
    }

    /// The note of a file no row names: a note that is that file already, or a
    /// new one ([`identity::adopt`]).
    pub fn adopt_file(
        &self,
        file: FileNote<'_>,
        converter: Option<&Converter>,
        embeds: Option<&dyn EmbedResolver>,
    ) -> Result<Adopted, CrdtError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| {
                Ok(identity::adopt(
                    conn,
                    converter,
                    embeds,
                    &file,
                    &Self::new_id(),
                    &device_id,
                    now_ms(),
                ))
            })
            .map_err(CrdtError::from)?
    }

    /// The id a note created by [`Self::adopt_new_files`] is to get, minted before its body is
    /// authored for it ([`crate::api::external_feed::ExternalFeed::first_body`]).
    pub fn new_note_id() -> String {
        Self::new_id()
    }

    /// Notes for many files no row names, each with the body authored for its id, in one
    /// transaction ([`new_files::adopt_new`]): `true` for each created, `false` for each to
    /// be asked about alone through [`Self::adopt_file`].
    pub fn adopt_new_files(&self, files: &[NewFileNote<'_>]) -> Result<Vec<bool>, CrdtError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| Ok(new_files::adopt_new(conn, files, &device_id, now_ms())))
            .map_err(CrdtError::from)?
    }

    /// Whether an entry for `date` may be the day file of that date: [`Self::adopt_day`] then
    /// needs a converter to read its body with.
    pub fn may_be_a_day(&self, date: &str) -> Result<bool, StorageError> {
        self.db
            .read_blocking(move |conn| journal_day::has_day_entry(conn, date))
    }

    /// The journal day of a file no row names ([`journal_day::adopt_day`]).
    pub fn adopt_day(
        &self,
        file: FileDay<'_>,
        converter: Option<&Converter>,
        embeds: Option<&dyn EmbedResolver>,
    ) -> Result<Adopted, CrdtError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| {
                Ok(journal_day::adopt_day(
                    conn,
                    converter,
                    embeds,
                    &file,
                    &device_id,
                    now_ms(),
                ))
            })
            .map_err(CrdtError::from)?
    }

    /// The day of the journal record `id`, live or deleted; `None` for a note: what the record
    /// is, wherever its file is, which a move compares with the day of the new path. The
    /// write-back reads [`journal_day::file_date`] instead
    /// (`WriteBackReader::file_date`), the day the record's file is: `None` also for a deleted
    /// day and for a day owed a move of its file.
    pub fn journal_date(&self, id: &str) -> Result<Option<String>, StorageError> {
        self.db
            .read_blocking(move |conn| journal::date_of(conn, id))
    }

    /// An edit outside the app gave the file of the note or day `id` the header tags `after`;
    /// `indexed` is the index's measure of the file it replaced, when it measured that file
    /// ([`file_tags::taken`]).
    pub fn file_tags_edited(
        &self,
        id: &str,
        indexed: Option<&[String]>,
        after: &[String],
    ) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            file_tags::taken(conn, id, indexed, after, &device_id, now_ms())
        })
    }

    /// The file of the note or day `id` says `tags`, as this device found or wrote it
    /// ([`file_tags::seen`]).
    pub fn file_tags_seen(&self, id: &str, tags: &[String]) -> Result<(), StorageError> {
        self.db
            .call_blocking(move |conn| file_tags::seen(conn, id, tags))
    }

    /// The note's file moved ([`identity::renamed`]).
    pub fn file_moved(&self, note_id: &str, moved: Moved<'_>) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            identity::renamed(conn, note_id, &moved, &device_id, now_ms())
        })
    }

    /// The app moved the note's file: record, row and slot follow in one transaction
    /// ([`app_move::moved_by_app`]). Writes `note_files`, so only the vault tier's rows' lane
    /// calls it.
    pub fn moved_by_app(&self, note_id: &str, moved: AppMoved<'_>) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            app_move::moved_by_app(conn, note_id, &moved, &device_id, now_ms())
        })
    }

    /// Records a note's app move before its file moves ([`app_move::begin`]). Only the vault
    /// tier's rows' lane calls it, which runs one move at a time.
    pub fn begin_app_move(&self, note_id: &str, moved: AppMoved<'_>) -> Result<(), BeginError> {
        self.db
            .call_blocking(move |conn| Ok(app_move::begin(conn, note_id, &moved)))?
    }

    /// Records the move of a folder the app moves and of every note in it, all or none
    /// ([`app_move::begin_folder`]). Only the vault tier's rows' lane calls it.
    pub fn begin_folder_move(
        &self,
        from: &str,
        to: &str,
        moves: &[(&str, AppMoved<'_>)],
    ) -> Result<(), BeginError> {
        self.db
            .call_blocking(move |conn| Ok(app_move::begin_folder(conn, from, to, moves)))?
    }

    /// Records the delete of the folder at `path` before it leaves the disk
    /// ([`folder_delete::begin`]). Only the vault tier's rows' lane calls it.
    pub fn begin_folder_delete(&self, path: &str, note_ids: &[&str]) -> Result<(), BeginError> {
        self.db
            .call_blocking(move |conn| Ok(folder_delete::begin(conn, path, note_ids)))?
    }

    /// The folder at `path` left the disk with the notes `note_ids`: tombstones, rows, folder
    /// records and order in one transaction ([`folder_delete::deleted_by_app`]).
    pub fn folder_deleted_by_app(&self, path: &str, note_ids: &[&str]) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            folder_delete::deleted_by_app(conn, path, note_ids, &device_id, now_ms())
        })
    }

    /// Every folder's record of a delete never finished or forgotten
    /// ([`folder_delete::pending`]).
    pub fn pending_folder_deletes(&self) -> Result<Vec<FolderDeleteRecorded>, StorageError> {
        self.db.read_blocking(folder_delete::pending)
    }

    /// Whether the folder at `path` was deleted here or on another device
    /// ([`folders::deleted`]).
    pub fn folder_deleted(&self, path: &str) -> Result<bool, StorageError> {
        self.db
            .read_blocking(move |conn| folders::deleted(conn, path))
    }

    /// Forgets the record of the folder's delete ([`folder_delete::abandon`]).
    pub fn abandon_folder_delete(&self, path: &str) -> Result<bool, StorageError> {
        self.db
            .call_blocking(move |conn| folder_delete::abandon(conn, path))
    }

    /// Every folder's record of an app move never finished or forgotten
    /// ([`app_move::pending_folders`]).
    pub fn pending_folder_moves(&self) -> Result<Vec<FolderRecorded>, StorageError> {
        self.db.read_blocking(app_move::pending_folders)
    }

    /// Forgets the folder's record of the move from `from` to `to`
    /// ([`app_move::abandon_folder`]). Only the vault tier's rows' lane calls it.
    pub fn abandon_folder_move(&self, from: &str, to: &str) -> Result<bool, StorageError> {
        self.db
            .call_blocking(move |conn| app_move::abandon_folder(conn, from, to))
    }

    /// The folder `from` moved to `to` with its notes: records, rows, folder records and
    /// manual order follow in one transaction ([`app_move::folder_moved_by_app`]).
    pub fn folder_moved_by_app(
        &self,
        from: &str,
        to: &str,
        moves: &[(&str, AppMoved<'_>)],
    ) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            app_move::folder_moved_by_app(conn, from, to, moves, &device_id, now_ms())
        })
    }

    /// Every note's record of an app move never finished or forgotten
    /// ([`app_move::pending`]).
    pub fn pending_app_moves(&self) -> Result<Vec<(String, Recorded)>, StorageError> {
        self.db.read_blocking(app_move::pending)
    }

    /// Forgets the note's record of the move from `old_path` to `new_path`
    /// ([`app_move::abandon`]). Only the vault tier's rows' lane calls it.
    pub fn abandon_app_move(
        &self,
        note_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<bool, StorageError> {
        self.db
            .call_blocking(move |conn| app_move::abandon(conn, note_id, old_path, new_path))
    }

    /// The note's file moved from `from_path` and its record was left as it was
    /// ([`identity::owe_place`]).
    pub fn owe_place(&self, note_id: &str, from_path: &str) -> Result<(), StorageError> {
        self.db
            .call_blocking(move |conn| identity::owe_place(conn, note_id, from_path, now_ms()))
    }

    /// The moves the records are owed ([`identity::owed_places`]).
    pub fn owed_places(&self) -> Result<Vec<OwedPlace>, StorageError> {
        self.db.call_blocking(|conn| identity::owed_places(conn))
    }

    /// An edit of the note's or journal day's file set `changed` and dropped `removed`: the
    /// record takes those keys and keeps every other ([`properties::mirror_file`]). `false` when
    /// no note or day has that id.
    pub fn file_properties(
        &self,
        id: &str,
        changed: Object,
        removed: Vec<String>,
    ) -> Result<bool, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            properties::mirror_file(conn, id, changed, &removed, &device_id, now_ms())
        })
    }

    /// An in-app edit wrote these aliases into the note's or journal day's file: the record
    /// takes them ([`notes::take_file_aliases`]). `false` when no live note or day has that id.
    pub fn file_aliases(&self, id: &str, aliases: &[String]) -> Result<bool, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            notes::take_file_aliases(conn, id, aliases, &device_id, now_ms())
        })
    }

    /// An in-app edit wrote this cover into the note's file, `None` for none: the record's
    /// `cover` takes it ([`notes::take_file_cover`]). `false` when no live note has that id.
    pub fn file_cover(&self, id: &str, cover: Option<Object>) -> Result<bool, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            notes::take_file_cover(conn, id, cover, &device_id, now_ms())
        })
    }

    /// The note's file at `path` is gone ([`identity::removed`]).
    pub fn file_removed(&self, note_id: &str, path: &str) -> Result<Removed, StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| identity::removed(conn, note_id, path, &device_id, now_ms()))
    }

    /// The note's or day's file moved to where it is the other kind ([`identity::crossed`]).
    pub fn file_crossed(
        &self,
        note_id: &str,
        to: Crossing<'_>,
        converter: Option<&Converter>,
        embeds: Option<&dyn EmbedResolver>,
    ) -> Result<Removed, CrdtError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            Ok(identity::crossed(
                conn,
                converter,
                embeds,
                note_id,
                &to,
                &device_id,
                now_ms(),
            ))
        })?
    }
}
