//! The record of a journal setting change that moves the days (desktop Step 13m-7b-2b, #3530):
//! a new journal folder or date format in Settings. A day is a day only while its file is at the
//! path the saved setting names, so the vault tier moves each day first and saves the setting
//! last. A crash between leaves days at paths the saved setting does not read, and each one's
//! next move would delete it as a day. The tier records the change ([`begin`]) before its first
//! move and forgets it ([`abandon`]) once the setting is saved or every day went back. The next
//! open finds a record left behind ([`pending`]) and puts the days back, or forgets it when the
//! setting was saved.
//!
//! The record is the one `meta` row [`KEY`], JSON
//! `{"version": 1, "from": {"folder", "format"}, "to": {"folder", "format"}, "made": [..]}`, a
//! format that crosses builds as [`super::app_move::Recorded`]'s does: a build before this one
//! does not know the key; every later build reads a version 1 record as this build writes it,
//! and a field a later build adds to version 1 is ignored here. A record of another version, or
//! one that does not parse, is [`JournalChangeRecorded::Unreadable`]: nothing here replaces or
//! deletes it, and no other change is recorded while it is there.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::app_move::{BeginError, write_synced};
use super::failed;
use crate::api::errors::StorageError;

/// The `meta` key of the record.
pub const KEY: &str = "notes.journal_change.v1";

/// The `version` of the record this build writes and acts on.
const RECORD_VERSION: u64 = 1;

/// Where a vault's days are: its journal folder and date format, as the config holds them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalSetting {
    pub folder: String,
    pub format: String,
}

/// A journal setting change that [`begin`] recorded and that was not forgotten.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingJournalChange {
    /// The setting the days moved from, saved until the change is.
    pub from: JournalSetting,
    /// The setting the days moved to.
    pub to: JournalSetting,
    /// The folders the change made for the days, deepest first, which go again with them.
    #[serde(default)]
    pub made: Vec<String>,
}

/// What [`KEY`] holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalChangeRecorded {
    /// A version 1 record, which this build finishes.
    Change(PendingJournalChange),
    /// A record this build cannot act on, left for the build that wrote it; says why.
    Unreadable(String),
}

#[derive(Serialize)]
struct Record<'a> {
    version: u64,
    #[serde(flatten)]
    change: &'a PendingJournalChange,
}

/// Records `change` before the first day moves, on disk before it returns (`synchronous =
/// FULL` for this one write). Refused while any record is there. Runs on its own, never inside
/// a transaction ([`super::app_move::begin`] says why).
pub fn begin(conn: &Connection, change: &PendingJournalChange) -> Result<(), BeginError> {
    match pending(conn)? {
        Some(JournalChangeRecorded::Change(_)) => return Err(BeginError::Unsettled),
        Some(JournalChangeRecorded::Unreadable(why)) => return Err(BeginError::Unreadable(why)),
        None => {}
    }
    let record = Record {
        version: RECORD_VERSION,
        change,
    };
    let value = serde_json::to_string(&record).map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })?;
    Ok(write_synced(conn, &[(KEY.to_owned(), value)])?)
}

/// The record, if there is one.
pub fn pending(conn: &Connection) -> Result<Option<JournalChangeRecorded>, StorageError> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(value.as_deref().map(parse))
}

fn parse(value: &str) -> JournalChangeRecorded {
    let version = match serde_json::from_str::<serde_json::Value>(value) {
        Ok(json) => json.get("version").and_then(serde_json::Value::as_u64),
        Err(error) => {
            return JournalChangeRecorded::Unreadable(format!(
                "a record that does not parse: {error}"
            ));
        }
    };
    match version {
        Some(RECORD_VERSION) => match serde_json::from_str::<PendingJournalChange>(value) {
            Ok(change) => JournalChangeRecorded::Change(change),
            Err(error) => JournalChangeRecorded::Unreadable(format!(
                "a version 1 record that does not parse: {error}"
            )),
        },
        Some(version) => JournalChangeRecorded::Unreadable(format!("a version {version} record")),
        None => JournalChangeRecorded::Unreadable("a record with no version".to_owned()),
    }
}

/// Forgets the record of `change`: its setting was saved, or every day went back. A record of
/// any other change stays, and so does one this build cannot read. True when it was forgotten.
pub fn abandon(conn: &Connection, change: &PendingJournalChange) -> Result<bool, StorageError> {
    let names_it = matches!(pending(conn)?, Some(JournalChangeRecorded::Change(recorded)) if recorded == *change);
    if names_it {
        conn.execute("DELETE FROM meta WHERE key = ?1", params![KEY])
            .map_err(failed)?;
    }
    Ok(names_it)
}
