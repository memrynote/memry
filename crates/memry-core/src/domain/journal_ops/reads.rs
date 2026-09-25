//! Journal reads for the shells (spec 005-journal JP023): one day, a month, a
//! year, the heatmap, the streak and the days with an entry in a range.
//!
//! Nothing here writes. Browsing never creates a day (D2), and a read never
//! refreshes a cache row either: the read path must be safe on a vault that
//! has never been pushed.
//!
//! **Tombstoned days never count.** Every query reads `journal_entries` under
//! `deleted_at IS NULL`, the same predicate [`journal::live_entry`] uses.
//!
//! ## Where the counts come from (D6)
//!
//! Counts, levels and previews are taken from the body's `extract_text`
//! output, never from markdown. `note_bodies.text` holds that output, but only
//! [`crate::domain::search::reindex`] refreshes it; a local edit or a pulled
//! update leaves it stale until the next reindex. The row carries a freshness
//! token, `source_seq`, the sum of the two namespaces' high-water sequences
//! (`search/maintenance.rs` `body_high_water`). So each day costs:
//!
//! - a small indexed read of the update log's high water, and
//! - when `source_seq` matches it, the cached text (cheap), or
//! - otherwise one replay of that day's update log plus `extract_text`, the
//!   same cost as opening the note. A month read after a fresh reindex does no
//!   replay; a year read on a stale index replays every live day of the year.
//!
//! ## A day whose body is not pulled
//!
//! First sync pulls only recent bodies (§5 h). A live day with no update-log
//! state at all reads [`JournalBodyState::NotPulled`]: it has an entry, it
//! counts toward the streak and `days_with_entries`, but it carries 0
//! characters, level 0 and no preview, so it adds nothing to character totals
//! or to the Year cards' `entry_count` (days with characters, as desktop's
//! `getMonthStats`). The shell shows "not on this phone" instead of "empty",
//! the distinction [`crate::domain::reads::NoteBody::present`] draws for notes.

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::{DocumentRegistry, UpdateSink};
use crate::crdt::text_extract::extract_text;
use crate::crdt::update_log::{self, LOCAL_NAMESPACE_PREFIX};
use crate::domain::journal::{self, ITEM_TYPE};
use crate::domain::journal_rules::{
    ActivityLevel, JOURNAL_PREVIEW_LENGTH, JournalHeatmapDay, JournalMonthActivity, JournalStreak,
    calculate_activity_level, compute_journal_streak, count_words, extract_journal_preview,
    heatmap_day, month_activity, month_days, utf16_len,
};
use crate::domain::note_meta::NoteProperty;
use crate::domain::{properties, tags};

/// The device id bodies are rebuilt under. A read never authors an update.
const READER_DEVICE_ID: &str = "memry-core-journal-reader";

/// The payload's reserved property that carries the day itself (D5).
const DATE_PROPERTY: &str = "date";

/// What this device holds of a day's body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JournalBodyState {
    /// The update log holds the body and it has text.
    Present,
    /// The update log holds nothing for the day: the body lives on the server
    /// (or another device) and has not been pulled here.
    NotPulled,
    /// The update log holds the body and it extracts to no text.
    Empty,
}

/// One live day.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalDay {
    /// The record id, which is also the body's document id.
    pub id: String,
    /// `YYYY-MM-DD`
    pub date: String,
    pub tags: Vec<String>,
    /// Sorted by name, the reserved `date` property left out.
    pub properties: Vec<NoteProperty>,
    /// Epoch milliseconds; `None` when the payload carries no instant.
    pub created_at: Option<i64>,
    pub modified_at: Option<i64>,
    pub word_count: u64,
    /// UTF-16 code units of the extracted text (D6). 0 when not pulled.
    pub character_count: u64,
    pub body_state: JournalBodyState,
}

/// One day of the Month view.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalMonthEntry {
    /// `YYYY-MM-DD`
    pub date: String,
    pub is_today: bool,
    pub is_future: bool,
    /// A live entry exists, pulled or not.
    pub has_entry: bool,
    pub level: ActivityLevel,
    /// [`extract_journal_preview`] over the extracted text, empty without a body.
    pub preview: String,
    pub character_count: u64,
    /// `None` when the day has no entry.
    pub body_state: Option<JournalBodyState>,
}

/// The Month view: every day of the month, newest first (desktop's
/// `JournalMonthView` reverses the days).
#[derive(Debug, Clone, PartialEq)]
pub struct JournalMonth {
    pub year: i64,
    /// 1-12
    pub month: u32,
    pub days: Vec<JournalMonthEntry>,
    /// Days of the month with a live entry, pulled or not (desktop's
    /// `getJournalMonthEntries` row count).
    pub entry_count: u32,
    pub streak: JournalStreak,
}

/// The Year view.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalYear {
    pub year: i64,
    /// Twelve cards, January first ([`month_activity`]).
    pub months: Vec<JournalMonthActivity>,
    /// Sum of the cards' `entry_count` (days with characters), as desktop's
    /// Year view totals them.
    pub days_with_entries: u32,
    /// Sum of the cards' `total_chars`.
    pub total_characters: u64,
    pub streak: JournalStreak,
}

/// A day's extracted text and what the log held for it.
struct DayBody {
    text: String,
    state: JournalBodyState,
}

impl DayBody {
    fn character_count(&self) -> u64 {
        u64::try_from(utf16_len(&self.text)).unwrap_or(u64::MAX)
    }
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// The live day for `date`, or `None` when it has no entry or only a
/// tombstoned one.
pub fn day(conn: &Connection, date: &str) -> Result<Option<JournalDay>, CrdtError> {
    let date = journal::valid_date(date)?;
    let row = conn
        .query_row(
            "SELECT id, created_at, modified_at FROM journal_entries
             WHERE date = ?1 AND deleted_at IS NULL",
            params![date],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?;
    let Some((id, created_at, modified_at)) = row else {
        return Ok(None);
    };

    let body = day_body(conn, &id)?;
    Ok(Some(JournalDay {
        tags: tags::list(conn, ITEM_TYPE, &id)?,
        properties: day_properties(conn, &id)?,
        created_at,
        modified_at,
        word_count: u64::try_from(count_words(&body.text)).unwrap_or(u64::MAX),
        character_count: body.character_count(),
        body_state: body.state,
        date: date.to_owned(),
        id,
    }))
}

/// Every day of `month` (1-12) of `year`, newest first, flagged against
/// `today`, with the month's entry count and the streak.
pub fn month(
    conn: &Connection,
    year: i64,
    month: u32,
    today: &str,
) -> Result<JournalMonth, CrdtError> {
    let (year, month) = (valid_year(year)?, valid_month(month)?);
    let today = journal::valid_date(today)?;
    let prefix = format!("{year:04}-{month:02}");
    let entries = live_entries(conn, &format!("{prefix}-01"), &format!("{prefix}-31"))?;

    let mut days = Vec::new();
    for calendar_day in month_days(year, month - 1, today).into_iter().rev() {
        let entry = entries
            .iter()
            .find(|(_, date)| *date == calendar_day.date)
            .map(|(id, _)| id);
        let body = entry.map(|id| day_body(conn, id)).transpose()?;
        let character_count = body.as_ref().map_or(0, DayBody::character_count);
        days.push(JournalMonthEntry {
            has_entry: entry.is_some(),
            level: calculate_activity_level(character_count),
            preview: body.as_ref().map_or_else(String::new, |body| {
                extract_journal_preview(&body.text, JOURNAL_PREVIEW_LENGTH)
            }),
            character_count,
            body_state: body.map(|body| body.state),
            date: calendar_day.date,
            is_today: calendar_day.is_today,
            is_future: calendar_day.is_future,
        });
    }

    Ok(JournalMonth {
        year,
        month,
        days,
        entry_count: u32::try_from(entries.len()).unwrap_or(u32::MAX),
        streak: streak(conn, today)?,
    })
}

/// The Year view for `year`: twelve month cards, totals and the streak.
pub fn year(conn: &Connection, year: i64, today: &str) -> Result<JournalYear, CrdtError> {
    let today = journal::valid_date(today)?;
    let heatmap = heatmap(conn, year)?;
    let months = month_activity(year, &heatmap);
    Ok(JournalYear {
        year,
        days_with_entries: months.iter().map(|card| card.entry_count).sum(),
        total_characters: months.iter().map(|card| card.total_chars).sum(),
        months,
        streak: streak(conn, today)?,
    })
}

/// One heatmap entry per live day of `year`, oldest first (desktop's
/// `getHeatmapData`). A day whose body is not pulled reads 0 characters.
pub fn heatmap(conn: &Connection, year: i64) -> Result<Vec<JournalHeatmapDay>, CrdtError> {
    let year = valid_year(year)?;
    live_entries(
        conn,
        &format!("{year:04}-01-01"),
        &format!("{year:04}-12-31"),
    )?
    .into_iter()
    .map(|(id, date)| {
        let body = day_body(conn, &id)?;
        Ok(heatmap_day(&date, body.character_count()))
    })
    .collect()
}

/// The current and longest runs of consecutive live days, counted from the
/// caller's `today` (D3). Every live entry counts, pulled or not, as desktop
/// counts every cached entry.
pub fn streak(conn: &Connection, today: &str) -> Result<JournalStreak, StorageError> {
    let today = journal::valid_date(today)?;
    let dates: Vec<String> = live_entries(conn, "0000-00-00", "9999-99-99")?
        .into_iter()
        .map(|(_, date)| date)
        .collect();
    Ok(compute_journal_streak(&dates, today))
}

/// The dates in `from..=to` with a live entry, oldest first.
pub fn days_with_entries(
    conn: &Connection,
    from: &str,
    to: &str,
) -> Result<Vec<String>, StorageError> {
    let (from, to) = (journal::valid_date(from)?, journal::valid_date(to)?);
    Ok(live_entries(conn, from, to)?
        .into_iter()
        .map(|(_, date)| date)
        .collect())
}

/// `(id, date)` of every live entry whose date falls in `from..=to`, oldest
/// first. The bounds compare as strings, which orders `YYYY-MM-DD` keys.
fn live_entries(
    conn: &Connection,
    from: &str,
    to: &str,
) -> Result<Vec<(String, String)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, date FROM journal_entries
             WHERE deleted_at IS NULL AND date >= ?1 AND date <= ?2
             ORDER BY date",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![from, to], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

/// The day's properties, typed as a note's are (`note_meta::metadata`),
/// without the reserved `date`.
fn day_properties(conn: &Connection, id: &str) -> Result<Vec<NoteProperty>, StorageError> {
    let definitions = properties::definitions(conn)?;
    let mut list: Vec<NoteProperty> = properties::values(conn, ITEM_TYPE, id)?
        .into_iter()
        .filter(|(name, _)| name != DATE_PROPERTY)
        .map(|(name, value)| {
            let definition = definitions.iter().find(|it| it.name == name);
            NoteProperty {
                value_json: value.to_string(),
                type_name: definition.map(|it| it.type_name.clone()),
                options_json: definition.and_then(|it| it.options.clone()),
                color: definition.and_then(|it| it.color.clone()),
                name,
            }
        })
        .collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}

/// The day's extracted text: `note_bodies.text` when its `source_seq` matches
/// the log's high water, otherwise rebuilt from the log (module doc).
fn day_body(conn: &Connection, id: &str) -> Result<DayBody, CrdtError> {
    let local = format!("{LOCAL_NAMESPACE_PREFIX}{id}");
    let mut present = false;
    let mut high = 0;
    for row_id in [id, local.as_str()] {
        let (rows, namespace_high) = log_high_water(conn, row_id)?;
        present |= rows > 0;
        high += namespace_high;
    }
    if !present {
        return Ok(DayBody {
            text: String::new(),
            state: JournalBodyState::NotPulled,
        });
    }

    let cached: Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT text, source_seq FROM note_bodies WHERE note_id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(failed)?;
    let text = match cached {
        Some((text, Some(source_seq))) if source_seq == high => text,
        _ => rebuilt_text(conn, id)?,
    };
    let state = if text.is_empty() {
        JournalBodyState::Empty
    } else {
        JournalBodyState::Present
    };
    Ok(DayBody { text, state })
}

/// Rows held for one namespace's row id, and its high-water sequence: the
/// larger of the newest update and the snapshot's fold point, as
/// `search/maintenance.rs` `body_high_water` computes it for `source_seq`.
fn log_high_water(conn: &Connection, row_id: &str) -> Result<(i64, i64), StorageError> {
    conn.query_row(
        "SELECT
             (SELECT COUNT(*) FROM yjs_updates WHERE doc_id = ?1)
               + (SELECT COUNT(*) FROM yjs_snapshots WHERE doc_id = ?1),
             MAX(
               (SELECT COALESCE(MAX(seq), 0) FROM yjs_updates WHERE doc_id = ?1),
               (SELECT COALESCE(MAX(last_seq), 0) FROM yjs_snapshots WHERE doc_id = ?1)
             )",
        params![row_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .map_err(failed)
}

/// The body rebuilt from the durable log and extracted, without writing the
/// cache row back.
fn rebuilt_text(conn: &Connection, id: &str) -> Result<String, CrdtError> {
    let plan = update_log::load_plan(conn, id)?;
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new(READER_DEVICE_ID, sink).get_or_open(id)?;
    for blob in plan.blobs() {
        document.apply_durable_update(blob)?;
    }
    extract_text(&document)
}

fn valid_year(year: i64) -> Result<i64, StorageError> {
    if (1000..=9999).contains(&year) {
        Ok(year)
    } else {
        Err(StorageError::Invalid {
            what: format!("journal year {year} is not four digits"),
        })
    }
}

fn valid_month(month: u32) -> Result<u32, StorageError> {
    if (1..=12).contains(&month) {
        Ok(month)
    } else {
        Err(StorageError::Invalid {
            what: format!("journal month {month} is not 1-12"),
        })
    }
}
