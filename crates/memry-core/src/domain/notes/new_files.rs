//! New vault files made notes many at a time (#3530 13q-7): the first open of a vault the app
//! has never seen finds every file without a note. One at a time, each costs three commits
//! (the record, its body, its row) and a markdown conversion on the one thread that holds the
//! writer. Here the bodies are authored beforehand, off the writer
//! ([`crate::domain::external_feed::first_body`]), and the records with their bodies go in one
//! transaction for the whole batch; the vault tier then records the rows in one more.
//!
//! The rules are [`super::identity::adopt`]'s, asked in the same transaction: a file a live
//! note no row names may be (same folder and title) is not created here, nor one beside
//! Electron's database in a vault that mints no id there. Such a file is answered `false`,
//! and the tier asks [`super::identity::adopt`] about it alone, which compares bodies.
//!
//! Crash safety is the one-file path's. The transaction holds each note's record, body and
//! outbox rows, so a crash leaves all of a batch's notes or none. A crash after it and before
//! the rows leaves notes no row names whose bodies are their files' text: the next open asks
//! [`super::identity::adopt`] about those files, which finds each note and answers `Existing`,
//! as it does for a crash between a create and its seed.

use rusqlite::Connection;

use super::identity::{FileNote, mints_beside_electron, unfiled_notes};
use super::{ITEM_TYPE, NewNote, create_dated_in, failed, iso};
use crate::crdt::epoch;
use crate::crdt::errors::CrdtError;
use crate::domain::body_write::append_in;
use crate::domain::external_feed::FirstBody;
use crate::sync::outbox;

/// A file no row names, the id its note is to get, and the body authored for that id.
pub struct NewFileNote<'a> {
    pub file: FileNote<'a>,
    pub id: &'a str,
    pub body: &'a FirstBody,
}

/// Creates a note for each file, with its body, in one transaction; `true` for each one
/// created, `false` for each to be asked about alone (the module header). An error writes
/// nothing. The transaction holds the writer for the whole batch, so the caller bounds the
/// batch.
pub fn adopt_new(
    conn: &Connection,
    files: &[NewFileNote<'_>],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<bool>, CrdtError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let mut mints = None;
    let mut created = Vec::with_capacity(files.len());
    for new in files {
        let file = &new.file;
        let mut alone = !unfiled_notes(&tx, file.title, file.folder_path)?.is_empty();
        if !alone && file.electron_db_beside {
            if mints.is_none() {
                mints = Some(mints_beside_electron(&tx)?);
            }
            alone = mints == Some(false);
        }
        // A body authored for another note is not this one's; and its updates carry the
        // client id they were authored under, so one this device would not author this
        // document under now is not stored.
        if alone
            || new.body.note_id != new.id
            || epoch::client_id(&tx, device_id, new.id)? != new.body.client_id
        {
            created.push(false);
            continue;
        }
        create_new(&tx, file, new.id, device_id, now_ms)?;
        for update in &new.body.updates {
            append_in(&tx, ITEM_TYPE, new.id, update, now_ms)?;
        }
        created.push(true);
    }
    tx.commit().map_err(failed)?;
    Ok(created)
}

/// The record of a new note for `file`, with the file's dates and no body, and its outbox row.
pub(super) fn create_new(
    tx: &Connection,
    file: &FileNote<'_>,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), CrdtError> {
    create_unqueued(tx, file, id, device_id, now_ms)?;
    outbox::enqueue(tx, &outbox::Change::upsert(ITEM_TYPE, id), now_ms)?;
    Ok(())
}

/// [`create_new`] without the outbox row.
pub(super) fn create_unqueued(
    tx: &Connection,
    file: &FileNote<'_>,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), CrdtError> {
    let note = NewNote {
        id,
        title: file.title,
        folder_path: file.folder_path,
        content: "",
        tags: &[],
        properties: None,
        emoji: None,
    };
    // A date no record can carry (a corrupt far-future time) is the creation's: refused, the
    // file would be asked about at every open, and never named.
    let carried = |ms: i64| if iso(ms).is_ok() { ms } else { now_ms };
    create_dated_in(
        tx,
        &note,
        device_id,
        now_ms,
        (carried(file.created_ms), carried(file.modified_ms)),
    )?;
    Ok(())
}
