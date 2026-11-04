//! Every live day's property values, for desktop's journal charts (`journal:getPropertyRows`,
//! Step 13m-4b, #3530). Not on the FFI surface: the phone draws no charts.
//!
//! The values are the record's, as sync carries them (`properties::values`). The day's own
//! `date` (D5) is left out: a chart row is on its day already.

use rusqlite::{Connection, params};
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::journal::ITEM_TYPE;
use crate::domain::notes::failed;
use crate::domain::properties;

/// One live day and its property values.
#[derive(Debug, Clone, PartialEq)]
pub struct DayValues {
    pub id: String,
    /// `YYYY-MM-DD`
    pub date: String,
    /// The vault-relative path of the day's file row; `None` for a day with no file yet.
    pub path: Option<String>,
    pub values: Map<String, Value>,
}

/// Every live day, oldest first, with its property values. A tombstoned day is never listed.
pub fn day_values(conn: &Connection) -> Result<Vec<DayValues>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT j.id, j.date, f.path FROM journal_entries j
               LEFT JOIN note_files f ON f.note_id = j.id
              WHERE j.deleted_at IS NULL
              ORDER BY j.date",
        )
        .map_err(failed)?;
    let days = statement
        .query_map(params![], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    days.into_iter()
        .map(|(id, date, path)| {
            let mut values = properties::values(conn, ITEM_TYPE, &id)?;
            values.remove("date");
            Ok(DayValues {
                id,
                date,
                path,
                values,
            })
        })
        .collect()
}
