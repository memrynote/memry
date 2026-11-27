//! The live days the desktop calendar lists, each measured by its file row or its record.

use rusqlite::{Connection, params};

use crate::crdt::errors::CrdtError;
use crate::domain::journal;
use crate::domain::journal_rules::{is_same_day_in_other_year, same_day_month_days};

use super::{day_body, failed};

/// A live day as desktop's calendar reads it (Step 13m-4, #3530).
#[derive(Debug, Clone, PartialEq)]
pub struct CalendarDay {
    pub id: String,
    /// `YYYY-MM-DD`
    pub date: String,
    pub held: DayHeld,
}

/// Where the calendar measures a day: the desktop measures a day's file in its note index, and
/// a day no file row names yet (its file is written on its first open) by its record here.
#[derive(Debug, Clone, PartialEq)]
pub enum DayHeld {
    /// The vault-relative path of the day's file row.
    File(String),
    /// No file row: the extracted text (D6), empty for a body not pulled.
    Record { text: String },
}

/// Every live day whose date falls in `from..=to` (compared as strings), oldest first, as
/// [`CalendarDay`]. A tombstoned day is never listed, whatever file is on disk.
pub fn calendar_days(
    conn: &Connection,
    from: &str,
    to: &str,
) -> Result<Vec<CalendarDay>, CrdtError> {
    let mut statement = conn
        .prepare(
            "SELECT j.id, j.date, f.path FROM journal_entries j
               LEFT JOIN note_files f ON f.note_id = j.id
              WHERE j.deleted_at IS NULL AND j.date >= ?1 AND j.date <= ?2
              ORDER BY j.date",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![from, to], calendar_row)
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    held_days(conn, rows)
}

/// The live days of other years that show as the same day as `date` (`getJournalSameDayEntries`),
/// newest first, as [`CalendarDay`]. One query over every year: Feb 29 and Feb 28 are both read
/// where [`same_day_month_days`] names them, then held to [`is_same_day_in_other_year`].
pub fn same_day_calendar_days(
    conn: &Connection,
    date: &str,
) -> Result<Vec<CalendarDay>, CrdtError> {
    let date = journal::valid_date(date)?;
    let month_days = same_day_month_days(date);
    let mut statement = conn
        .prepare(
            "SELECT j.id, j.date, f.path FROM journal_entries j
               LEFT JOIN note_files f ON f.note_id = j.id
              WHERE j.deleted_at IS NULL AND substr(j.date, 6) IN (?1, ?2)
              ORDER BY j.date DESC",
        )
        .map_err(failed)?;
    // One or two month-days: the first is bound twice when there is one.
    let (first, last) = (month_days[0], month_days[month_days.len() - 1]);
    let rows = statement
        .query_map(params![first, last], calendar_row)
        .map_err(failed)?
        .filter(|row| {
            row.as_ref()
                .map_or(true, |(_, other, _)| is_same_day_in_other_year(date, other))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    held_days(conn, rows)
}

type CalendarRow = (String, String, Option<String>);

fn calendar_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CalendarRow> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
}

/// Each row as a [`CalendarDay`]; a day no file row names reads its record's text.
fn held_days(conn: &Connection, rows: Vec<CalendarRow>) -> Result<Vec<CalendarDay>, CrdtError> {
    rows.into_iter()
        .map(|(id, date, path)| {
            let held = match path {
                Some(path) => DayHeld::File(path),
                None => DayHeld::Record {
                    text: day_body(conn, &id)?.text,
                },
            };
            Ok(CalendarDay { id, date, held })
        })
        .collect()
}
