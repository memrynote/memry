//! `NoteFiles`: path identity and file state of the vault's files, for the
//! desktop vault tier (Step 12). Reached from
//! [`crate::api::vault::Vault::note_files`]. Not exported over UniFFI: iOS keeps
//! no files of its own to track.
//!
//! The rules (path format, no case folding, hash ownership) are in
//! [`crate::domain::note_files`]. Every method blocks; the shell runs them in
//! `spawn_blocking`.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::inbox::queries::FiledVoice;
use crate::domain::note_files::{self, FiledTextFile, NoteFile, NoteFileStat, StampMark};
use crate::domain::note_list::{self, ListedNote, NoteListPage, NoteListQuery};
use crate::domain::notes::local_only::{self, LocalOnlyChange};
use crate::domain::properties;
use crate::domain::{owed_file_aliases, owed_file_body};
use crate::storage::Db;

pub struct NoteFiles {
    db: Db,
}

impl NoteFiles {
    pub(crate) fn over(db: Db) -> Self {
        Self { db }
    }

    pub fn by_path(&self, path: &str) -> Result<Option<NoteFile>, StorageError> {
        let path = path.to_owned();
        self.db
            .read_blocking(move |conn| note_files::by_path(conn, &path))
    }

    /// The voice capture filed to `path`, when one was.
    pub fn filed_voice(&self, path: &str) -> Result<Option<FiledVoice>, StorageError> {
        let path = path.to_owned();
        self.db
            .read_blocking(move |conn| crate::domain::inbox::queries::filed_voice(conn, &path))
    }

    pub fn by_id(&self, note_id: &str) -> Result<Option<NoteFile>, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .read_blocking(move |conn| note_files::by_id(conn, &note_id))
    }

    pub fn upsert_stat(&self, stat: NoteFileStat) -> Result<(), StorageError> {
        self.upsert_stats(std::slice::from_ref(&stat))
    }

    /// [`note_files::upsert_stats`]: every row or none, in one transaction.
    pub fn upsert_stats(&self, stats: &[NoteFileStat]) -> Result<(), StorageError> {
        self.db
            .call_blocking(move |conn| note_files::upsert_stats(conn, stats))
    }

    /// [`note_files::upsert_stats_as`] of one row.
    pub fn upsert_stat_as(&self, stat: NoteFileStat, mark: StampMark) -> Result<(), StorageError> {
        self.db.call_blocking(move |conn| {
            note_files::upsert_stats_as(conn, std::slice::from_ref(&stat), mark)
        })
    }

    /// [`note_files::refresh_stat`].
    pub fn refresh_stat(&self, stat: NoteFileStat) -> Result<(), StorageError> {
        self.db
            .call_blocking(move |conn| note_files::refresh_stat(conn, &stat))
    }

    /// [`note_files::set_hash`].
    pub fn set_hash(&self, note_id: &str, content_hash: Option<&str>) -> Result<(), StorageError> {
        let (note_id, hash) = (note_id.to_owned(), content_hash.map(str::to_owned));
        self.db
            .call_blocking(move |conn| note_files::set_hash(conn, &note_id, hash.as_deref()))
    }

    /// [`note_files::set_file_hash`].
    pub fn set_file_hash(
        &self,
        note_id: &str,
        file_hash: Option<&str>,
    ) -> Result<(), StorageError> {
        let (note_id, hash) = (note_id.to_owned(), file_hash.map(str::to_owned));
        self.db
            .call_blocking(move |conn| note_files::set_file_hash(conn, &note_id, hash.as_deref()))
    }

    pub fn rename_path(&self, note_id: &str, new_path: &str) -> Result<(), StorageError> {
        let (note_id, new_path) = (note_id.to_owned(), new_path.to_owned());
        self.db
            .call_blocking(move |conn| note_files::rename_path(conn, &note_id, &new_path))
    }

    pub fn rename_prefix(&self, old_dir: &str, new_dir: &str) -> Result<usize, StorageError> {
        let (old_dir, new_dir) = (old_dir.to_owned(), new_dir.to_owned());
        self.db
            .call_blocking(move |conn| note_files::rename_prefix(conn, &old_dir, &new_dir))
    }

    pub fn remove(&self, note_id: &str) -> Result<bool, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .call_blocking(move |conn| note_files::remove(conn, &note_id))
    }

    /// Whether the note's file holds a body its document has not taken
    /// ([`crate::domain::owed_file_body`]).
    pub fn owes_file_body(&self, note_id: &str) -> Result<bool, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .read_blocking(move |conn| owed_file_body::owes(conn, &note_id))
    }

    /// Whether the note's server body is still to be pulled ([`crate::sync::body_debt`]): a file
    /// it owes cannot be taken before.
    pub fn server_body_owed(&self, note_id: &str) -> Result<bool, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .read_blocking(move |conn| crate::sync::body_debt::is_owed(conn, &note_id))
    }

    /// Which of `note_ids` still owe their server body ([`Self::server_body_owed`]), in one read.
    pub fn server_bodies_owed(&self, note_ids: &[String]) -> Result<HashSet<String>, StorageError> {
        let note_ids = note_ids.to_vec();
        self.db.read_blocking(move |conn| {
            let mut owed = HashSet::new();
            for note_id in note_ids {
                if crate::sync::body_debt::is_owed(conn, &note_id)? {
                    owed.insert(note_id);
                }
            }
            Ok(owed)
        })
    }

    /// Every live note that owes its file body, in id order.
    pub fn owed_file_bodies(&self) -> Result<Vec<String>, StorageError> {
        self.db.read_blocking(owed_file_body::list)
    }

    /// The document took the file (or the file no longer matters): the note no
    /// longer owes it. True when there was a marker.
    pub fn clear_owed_file_body(&self, note_id: &str) -> Result<bool, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .call_blocking(move |conn| owed_file_body::clear(conn, &note_id))
    }

    /// Whether the note's file owes its record's aliases ([`owed_file_aliases`]).
    pub fn owes_file_aliases(&self, note_id: &str) -> Result<bool, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .read_blocking(move |conn| owed_file_aliases::owes(conn, &note_id))
    }

    /// Every note whose file owes its record's aliases, in id order.
    pub fn owed_file_aliases(&self) -> Result<Vec<String>, StorageError> {
        self.db.read_blocking(owed_file_aliases::list)
    }

    /// The file holds its record's aliases: the debt is paid. True when there was one.
    pub fn clear_owed_file_aliases(&self, note_id: &str) -> Result<bool, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .call_blocking(move |conn| owed_file_aliases::clear(conn, &note_id))
    }

    /// Whether the last read of the note's file found it large-file class
    /// ([`note_files::is_large_file`]).
    pub fn is_large_file(&self, note_id: &str) -> Result<bool, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .read_blocking(move |conn| note_files::is_large_file(conn, &note_id))
    }

    /// Records the class a read of the note's file just measured; the editor opens a
    /// large-file note read-only from it. Takes the writer only when the class changed, so a
    /// read that records the class it found costs no write.
    pub fn record_large_file(&self, note_id: &str, large: bool) -> Result<(), StorageError> {
        if self.is_large_file(note_id)? == large {
            return Ok(());
        }
        let note_id = note_id.to_owned();
        self.db
            .call_blocking(move |conn| note_files::set_large_file(conn, &note_id, large))
    }

    pub fn list_missing_candidates(&self) -> Result<Vec<NoteFile>, StorageError> {
        self.db.read_blocking(note_files::list_missing_candidates)
    }

    /// Every note whose file may be behind its body ([`note_files::behind_bodies`]).
    pub fn behind_bodies(&self) -> Result<Vec<String>, StorageError> {
        self.db.read_blocking(note_files::behind_bodies)
    }

    /// Every live note and day no row names ([`note_files::unfiled_bodies`]).
    pub fn unfiled_bodies(&self) -> Result<Vec<String>, StorageError> {
        self.db.read_blocking(note_files::unfiled_bodies)
    }

    /// The record `id` when no row names it ([`note_files::unfiled`]).
    pub fn unfiled(&self, id: &str) -> Result<Option<note_files::Unfiled>, StorageError> {
        let id = id.to_owned();
        self.db
            .read_blocking(move |conn| note_files::unfiled(conn, &id))
    }

    /// The live markdown note or journal day `id` as its record reads now
    /// ([`note_files::placed`]).
    pub fn placed(&self, id: &str) -> Result<Option<note_files::Unfiled>, StorageError> {
        let id = id.to_owned();
        self.db
            .read_blocking(move |conn| note_files::placed(conn, &id))
    }

    /// The write-back wrote the record's property `values` into the note's file
    /// ([`properties::file_written`]).
    pub fn file_properties_written(
        &self,
        id: &str,
        values: Map<String, Value>,
    ) -> Result<(), StorageError> {
        let id = id.to_owned();
        self.db
            .call_blocking(move |conn| properties::file_written(conn, &id, values))
    }

    /// Whether a day's file must wait to be named ([`note_files::days_wait`]).
    #[cfg(feature = "markdown")]
    pub fn days_wait(&self) -> Result<bool, StorageError> {
        self.db.read_blocking(note_files::days_wait)
    }

    /// [`note_files::mark_unmarked`], once the vault opened.
    pub fn mark_unmarked(&self) -> Result<usize, StorageError> {
        self.db
            .call_blocking(|conn| note_files::mark_unmarked(conn))
    }

    /// Whether the note's body moved after its row's stamp ([`note_files::behind_body`]).
    pub fn behind_body(&self, note_id: &str) -> Result<bool, StorageError> {
        self.db
            .read_blocking(move |conn| note_files::behind_body(conn, note_id))
    }

    /// The markdown rows of tombstoned notes, each with whether its note is owed a move
    /// ([`note_files::rows_of_deleted_notes`]).
    pub fn rows_of_deleted_notes(&self) -> Result<Vec<(NoteFile, bool)>, StorageError> {
        self.db.read_blocking(note_files::rows_of_deleted_notes)
    }

    pub fn list_paths(&self) -> Result<Vec<(String, String)>, StorageError> {
        self.db.read_blocking(note_files::list_paths)
    }

    /// [`note_files::by_filename_lower`].
    pub fn by_filename_lower(
        &self,
        file_type: &str,
        names: &BTreeSet<String>,
    ) -> Result<BTreeMap<String, Vec<String>>, StorageError> {
        self.db
            .read_blocking(|conn| note_files::by_filename_lower(conn, file_type, names))
    }

    /// Sets or clears the note's local-only flag and settles its outbox rows
    /// in the same transaction (see [`local_only::set`]).
    pub fn set_local_only(
        &self,
        note_id: &str,
        local_only: bool,
    ) -> Result<LocalOnlyChange, StorageError> {
        let note_id = note_id.to_owned();
        self.db.call_blocking(move |conn| {
            local_only::set(
                conn,
                &note_id,
                local_only,
                crate::api::tasks_write::now_ms(),
            )
        })
    }

    pub fn local_only_count(&self) -> Result<i64, StorageError> {
        self.db.read_blocking(note_files::local_only_count)
    }

    /// The live notes with a file, one page ([`note_list::list`]).
    pub fn list_notes(&self, query: NoteListQuery) -> Result<NoteListPage, StorageError> {
        self.db
            .read_blocking(move |conn| note_list::list(conn, &query))
    }

    /// The live note `note_id`, when it has a file ([`note_list::by_id`]).
    pub fn listed_by_id(&self, note_id: &str) -> Result<Option<ListedNote>, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .read_blocking(move |conn| note_list::by_id(conn, &note_id))
    }

    /// The live note whose file is at `path` ([`note_list::by_path`]).
    pub fn listed_by_path(&self, path: &str) -> Result<Option<ListedNote>, StorageError> {
        let path = path.to_owned();
        self.db
            .read_blocking(move |conn| note_list::by_path(conn, &path))
    }

    /// The filed PDFs and images among `ids`, or every one ([`note_files::filed_text_files`]).
    pub fn filed_text_files(
        &self,
        ids: Option<Vec<String>>,
    ) -> Result<Vec<FiledTextFile>, StorageError> {
        self.db
            .read_blocking(move |conn| note_files::filed_text_files(conn, ids.as_deref()))
    }

    /// The markdown notes among `ids`, as `(note_id, path)` ([`note_files::markdown_notes`]).
    pub fn markdown_notes(&self, ids: Vec<String>) -> Result<Vec<(String, String)>, StorageError> {
        self.db
            .read_blocking(move |conn| note_files::markdown_notes(conn, &ids))
    }

    /// The ids among `ids` that name no note any more ([`note_files::gone_notes`]).
    pub fn gone_notes(&self, ids: Vec<String>) -> Result<Vec<String>, StorageError> {
        self.db
            .read_blocking(move |conn| note_files::gone_notes(conn, &ids))
    }
}
