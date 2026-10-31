//! Which journal day a vault file is (desktop Step 13m, #3530): the journal half of
//! [`super::identity`]. The tier asks here about a file no row names whose path names a day:
//! it is under the vault's journal folder and its name parses in the journal date format
//! (Electron's `isJournalEntry`, `database/queries/notes/journal-queries.ts`). The path rules
//! are the shell's; nothing here reads or writes a file or a row.
//!
//! A day has one id on every device, `j<YYYY-MM-DD>` (chapter 01 §1.9.1), so a day file never
//! gets a note id, and never a second day id. As for a note, a file gets its day only on
//! evidence; otherwise the answer is [`Adopted::Deferred`], and the next open asks again:
//!
//! - an entry for the day that no row names is the file's when its body is empty or already
//!   the file's text: a day pulled before its file was written, or one a crash left between
//!   its create and its row. One whose body says something else, is owed a pull, or is not one
//!   this build writes out whole defers, as a note does. A deleted entry is revived on the same
//!   evidence: a deleted day whose file comes back is the day again, as a deleted note whose
//!   file comes back is a note again; its document still holds the body it was deleted with,
//!   and a revive over another text would show that body, not the file's;
//! - an entry a row names is another file's day (a file a format rename could not move), and a
//!   day held by a foreign id (§1.9.1, the day-merge drain's to settle) is not decided here:
//!   both defer;
//! - otherwise the day is created, with the file's dates. Beside an Electron database the core
//!   did not import, nothing is created or revived ([`Deferral::ElectronNotImported`]): the
//!   import brings Electron's days, as it brings its notes.
//!
//! A date the record cannot hold (`2025-02-31`, which Electron's file names allow) defers.
//!
//! A new day does not take the file's frontmatter `tags` onto its record, as a new note does
//! not; Electron does (`declaredTags`, `vault/ingest-backfill.ts`). That port is the journal
//! service's (Step 13m part 2), with the notes'.
//!
//! Notes and days share one body feed (chapter 07 §7.1): [`body_owner`] is how the feed and the
//! write-back tell a note's body from a day's. A day's kept versions are titled by its date;
//! Electron titles them by the file name, which differs for a format like `YYYY-MM-DD dddd`.

use rusqlite::{Connection, OptionalExtension as _, params};

use super::identity::{Adopted, Deferral, Evidence, body_says, mints_beside_electron};
use super::{failed, iso};
use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::domain::{journal, note_files};
use crate::markdown::convert::EmbedResolver;
use crate::markdown::convert::api::Converter;

const UNDECIDED: Adopted = Adopted::Deferred(Deferral::Undecided);

/// What a file under the journal folder says about the day it is.
#[derive(Debug, Clone, Copy)]
pub struct FileDay<'a> {
    /// Vault-relative, `/`-separated.
    pub path: &'a str,
    /// The day the path names, `YYYY-MM-DD`.
    pub date: &'a str,
    /// The file's markdown below its frontmatter block.
    pub body: &'a str,
    /// When the file was created, for a new entry's `createdAt`.
    pub created_ms: i64,
    /// When the file was last modified, for a new entry's `modifiedAt`.
    pub modified_ms: i64,
    /// `<vault>/.memry/data.db` of Electron is beside the core's database.
    pub electron_db_beside: bool,
}

/// Whether an entry for `date` is there, live or deleted: [`adopt_day`] then needs a converter
/// to read its body with.
pub fn has_day_entry(conn: &Connection, date: &str) -> Result<bool, StorageError> {
    Ok(journal::valid_date(date).is_ok() && journal::entry_for(conn, date)?.is_some())
}

/// The day of a file no row names. One transaction, so a second file naming the same day,
/// asked right after, sees the entry this one created. `converter` reads the body of an entry
/// already there; without one such an entry defers. `embeds` must not read this database.
pub fn adopt_day(
    conn: &Connection,
    converter: Option<&Converter>,
    embeds: Option<&dyn EmbedResolver>,
    file: &FileDay<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Adopted, CrdtError> {
    let Ok(date) = journal::valid_date(file.date) else {
        return Ok(UNDECIDED);
    };
    let id = journal::document_id_for(date)?;
    let tx = conn.unchecked_transaction().map_err(failed)?;
    match journal::entry_for(&tx, date)? {
        None => {}
        Some((held, _)) if held != id => return Ok(UNDECIDED),
        Some((_, deleted)) => {
            if note_files::by_id(&tx, &id)?.is_some() {
                return Ok(UNDECIDED);
            }
            let Some(converter) = converter else {
                return Ok(UNDECIDED);
            };
            let evidence = body_says(
                &tx,
                converter,
                embeds,
                journal::ITEM_TYPE,
                &id,
                (file.path, file.body),
                device_id,
            )?;
            if !matches!(evidence, Evidence::Same) {
                return Ok(UNDECIDED);
            }
            if !deleted {
                return Ok(Adopted::Existing(id));
            }
        }
    }
    if file.electron_db_beside && !mints_beside_electron(&tx)? {
        return Ok(Adopted::Deferred(Deferral::ElectronNotImported));
    }
    // A date no record can carry (a corrupt far-future time) is the creation's, as for a note.
    let carried = |ms: i64| if iso(ms).is_ok() { ms } else { now_ms };
    let dates = (carried(file.created_ms), carried(file.modified_ms));
    let opened = journal::open_day_dated_in(&tx, date, device_id, now_ms, dates)?;
    tx.commit().map_err(failed)?;
    Ok(Adopted::Created(opened.id))
}

/// The live record a body belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyOwner {
    /// `note` or `journal`: the item type its body's outbox rows are queued under.
    pub item_type: &'static str,
    /// A note's title, or a day's date: the title a kept version of its file carries.
    pub title: String,
}

/// The live note or journal day whose body is the document `id`; `None` for neither.
pub fn body_owner(conn: &Connection, id: &str) -> Result<Option<BodyOwner>, StorageError> {
    conn.query_row(
        "SELECT 1, title FROM notes WHERE id = ?1 AND deleted_at IS NULL
         UNION ALL
         SELECT 0, date FROM journal_entries WHERE id = ?1 AND deleted_at IS NULL
         LIMIT 1",
        params![id],
        |row| {
            Ok(BodyOwner {
                item_type: if row.get(0)? {
                    super::ITEM_TYPE
                } else {
                    journal::ITEM_TYPE
                },
                title: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(failed)
}
