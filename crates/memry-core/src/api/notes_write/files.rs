//! [`NotesWriter`]'s answers to the desktop vault tier about the note or journal
//! day a vault file is (Steps 13d, 13m): [`crate::domain::notes::identity`] and
//! [`crate::domain::notes::journal_day`]. Not exported over UniFFI: iOS keeps no
//! vault files. Every method blocks; the shell runs them on the tier's consumer
//! thread.

use super::{NotesWriter, now_ms};
use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::domain::journal;
use crate::domain::notes::app_move::{self, AppMoved};
use crate::domain::notes::identity::{self, Adopted, FileNote, Moved, OwedPlace, Removed};
use crate::domain::notes::journal_day::{self, FileDay};
use crate::markdown::convert::EmbedResolver;
use crate::markdown::convert::api::Converter;

impl NotesWriter {
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

    /// The note's file at `path` is gone ([`identity::removed`]).
    pub fn file_removed(&self, note_id: &str, path: &str) -> Result<Removed, StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| identity::removed(conn, note_id, path, &device_id, now_ms()))
    }
}
