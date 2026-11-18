//! The journal side of a Readwise run (`journal-sync.ts`, `highlights-index.ts`, #3476 D17).
//! [`record_highlights`] keeps the device-local highlight index current and notes which journal
//! days owe a write; [`flush_journal`] writes them through the journal owner (`update_day`).

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{Duration, NaiveDate};
use chrono_tz::Tz;
use memry_core::api::errors::StorageError;
use memry_core::domain::readwise::LinkState;
use memry_core::domain::readwise_highlights::{IndexRow, Record};

use super::journal::{
    JournalBook, JournalWrite, highlight_day, highlight_instant, plan_journal_write,
};
use super::library::{BUSY_WINDOW, Library};
use super::run_state::{
    HIGHLIGHT_INDEX, JOURNAL_PENDING, JournalPending, RunState, journal_pending_text,
    parse_journal_pending,
};
use super::types::ReadwiseBook;
use crate::journal::update::DayUpdate;
use crate::journal::{JournalEntryView, entry};
use crate::notes::read;
use crate::web::extract::utils::js::{is_js_whitespace, trim as js_trim};

const SCOPE: &str = "ReadwiseJournal";

/// `journalHighlightsOn`: the Readwise switch and the journal feature are both on. A features
/// group that cannot be read counts as off: nothing is written.
pub fn journal_highlights_on(library: &Library, switch_on: bool) -> bool {
    if !switch_on {
        return false;
    }
    let store = library.notes.store.clone();
    let features = library
        .open
        .vault
        .app_settings(store)
        .map_err(|error| error.to_string())
        .and_then(|settings| (settings.get_group("features")).map_err(|error| error.to_string()));
    match features {
        Ok(read) => read.value.get("journal").and_then(|on| on.as_bool()) != Some(false),
        Err(error) => {
            tracing::warn!(scope = SCOPE, "could not read the journal feature: {error}");
            false
        }
    }
}

/// `recordHighlights`'s options.
pub struct RecordOptions {
    /// The books came from a full export: the index is rebuilt from them.
    pub rebuild: bool,
    /// Highlights new to the index are new arrivals. False for the first import, a takeover's
    /// first run and a category full pass, which only fill the index (D17, no backfill).
    pub count_arrivals: bool,
    /// The switch and the journal feature are on. Off clears what was pending.
    pub enabled: bool,
    pub time_zone: Tz,
}

/// `toIndexRows`, later books winning: a full fetch overrides the export's partial payload.
fn index_rows(books: &[&ReadwiseBook]) -> Vec<IndexRow> {
    let mut rows: Vec<IndexRow> = Vec::new();
    let mut at: HashMap<i64, usize> = HashMap::new();
    for book in books {
        for highlight in book.highlights.iter().flatten() {
            let row = IndexRow {
                highlight_id: highlight.id,
                book_id: book.user_book_id,
                highlighted_at: highlight_instant(highlight.highlighted_at.as_deref(), None),
                created_at: highlight_instant(None, highlight.created_at.as_deref()),
                deleted: book.is_deleted == Some(true)
                    || highlight.is_deleted == Some(true)
                    || highlight.is_discard == Some(true),
            };
            match at.get(&highlight.id) {
                Some(index) => rows[*index] = row,
                None => {
                    at.insert(highlight.id, rows.len());
                    rows.push(row);
                }
            }
        }
    }
    rows
}

/// `recordHighlights`: the index from the books a run saw, and the pending days with the
/// arrivals, in one transaction. A crash re-reads the same window, and the arrivals it held are
/// already owed to the journal.
pub fn record_highlights(
    state: &RunState,
    books: &[&ReadwiseBook],
    options: &RecordOptions,
) -> Result<(), StorageError> {
    let rows = index_rows(books);
    let deleted_books: Vec<i64> = books
        .iter()
        .filter(|book| book.is_deleted == Some(true))
        .map(|book| book.user_book_id)
        .collect();
    let record = Record {
        rows: &rows,
        rebuild: options.rebuild,
        deleted_books: &deleted_books,
        ready_key: HIGHLIGHT_INDEX,
        pending_key: JOURNAL_PENDING,
    };
    state.store().record_highlights(&record, |known, stored| {
        if !options.enabled {
            return None;
        }
        let mut pending = parse_journal_pending(stored.as_deref());
        if options.count_arrivals {
            for row in rows.iter().filter(|row| !row.deleted) {
                if known.contains(&row.highlight_id) {
                    continue;
                }
                let day = highlight_day(
                    row.highlighted_at.as_deref(),
                    row.created_at.as_deref(),
                    options.time_zone,
                );
                let Some(day) = day else { continue };
                let count = pending
                    .entry(day)
                    .or_default()
                    .entry(row.book_id.to_string())
                    .or_insert(0);
                *count = count.saturating_add(1);
            }
        }
        journal_pending_text(&pending)
    })
}

/// How one day's write went (`DayWrite`, plus `failed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DayWrite {
    Written,
    Unchanged,
    Busy,
}

/// The day's entry id (`resolveJournalEntryId`): the stored record's, else `j<date>`.
fn entry_id(library: &Library, date: &str) -> Result<String, String> {
    let journal = (library.open.vault)
        .journal(library.notes.store.clone())
        .map_err(|error| error.to_string())?;
    let stamp = journal.stamp(date).map_err(|error| error.to_string())?;
    Ok(stamp.map_or_else(|| format!("j{date}"), |stamp| stamp.id))
}

/// `readJournalEntry`.
fn read_entry(library: &Library, date: &str) -> Result<Option<JournalEntryView>, String> {
    let journal = (library.open.vault)
        .journal(library.notes.store.clone())
        .map_err(|error| error.to_string())?;
    entry(&library.open, &journal, date).map_err(|error| error.to_string())
}

/// The entry is open in an editor or took a network update moments ago (D6).
fn is_busy(library: &Library, date: &str) -> Result<bool, String> {
    let id = entry_id(library, date)?;
    Ok(library.editor.is_busy(&library.open.path, &id, BUSY_WINDOW))
}

fn write_content(library: &Library, date: &str, content: String) -> Result<(), String> {
    let update = DayUpdate {
        date: date.to_owned(),
        content: Some(content),
        ..DayUpdate::default()
    };
    library
        .notes
        .update_day(&library.open, update)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// `appendToJournalEntry`: `markdown` after the entry's text, a blank line between.
fn append(library: &Library, date: &str, markdown: &str) -> Result<(), String> {
    let text = js_trim(markdown);
    if text.is_empty() {
        return Err("Nothing to append".to_owned());
    }
    let existing = read_entry(library, date)?;
    let head = existing
        .as_ref()
        .map_or("", |entry| entry.content.trim_end_matches(is_js_whitespace));
    let content = match head {
        "" => text.to_owned(),
        head => format!("{head}\n\n{text}"),
    };
    write_content(library, date, content)
}

fn write_day(
    library: &Library,
    date: &str,
    day: &[JournalBook],
    arrivals: &[JournalBook],
) -> Result<DayWrite, String> {
    if is_busy(library, date)? {
        return Ok(DayWrite::Busy);
    }
    let existing = read_entry(library, date)?;
    let plan = plan_journal_write(existing.as_ref().map(|e| e.content.as_str()), day, arrivals);
    if plan == JournalWrite::Unchanged {
        return Ok(DayWrite::Unchanged);
    }
    // The read above waited on the disk: an editor may have opened since.
    if is_busy(library, date)? {
        return Ok(DayWrite::Busy);
    }
    let written = match &plan {
        JournalWrite::Append { markdown } => append(library, date, markdown),
        JournalWrite::Update { content } => write_content(library, date, content.clone()),
        JournalWrite::Unchanged => Ok(()),
    };
    if let Err(error) = written {
        // The file is written before the index and the editor are told. When the text is on
        // disk, a retry would append the same lines again.
        let now = read_entry(library, date)?.map(|entry| entry.content);
        let on_disk = now.is_some_and(|now| match &plan {
            JournalWrite::Append { markdown } => now.contains(markdown.as_str()),
            JournalWrite::Update { content } => now == *content,
            JournalWrite::Unchanged => true,
        });
        if !on_disk {
            return Err(error);
        }
        tracing::warn!(
            scope = SCOPE,
            date,
            "a Readwise journal day was written, but a later step failed: {error}"
        );
    }
    Ok(DayWrite::Written)
}

/// Every local date that is `date` somewhere on Earth lies in this window (UTC-12 to UTC+14).
fn day_window(date: &str) -> Option<(String, String)> {
    let start = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()?
        .and_hms_opt(0, 0, 0)?
        .and_utc();
    let iso = |at: chrono::DateTime<chrono::Utc>| at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    Some((
        iso(start - Duration::hours(14)),
        iso(start + Duration::hours(36)),
    ))
}

/// The live highlights of `date` in the index, by book: the count and the first instant.
fn books_of_day(
    state: &RunState,
    date: &str,
    time_zone: Tz,
) -> Result<BTreeMap<i64, (u64, String)>, String> {
    let mut books: BTreeMap<i64, (u64, String)> = BTreeMap::new();
    let Some((from, to)) = day_window(date) else {
        return Ok(books);
    };
    let rows = (state.store().highlights_between(&from, &to)).map_err(|e| e.to_string())?;
    for row in rows {
        if highlight_day(Some(&row.at), None, time_zone).as_deref() != Some(date) {
            continue;
        }
        let entry = books.entry(row.book_id).or_insert((0, row.at.clone()));
        entry.0 += 1;
        if row.at < entry.1 {
            entry.1 = row.at;
        }
    }
    Ok(books)
}

/// The book note's current title, `None` when the book has no note to link.
fn book_title(library: &Library, state: &RunState, book_id: i64) -> Result<Option<String>, String> {
    let link = (state.store().link_for_book(book_id, None)).map_err(|e| e.to_string())?;
    let Some(link) = link.filter(|link| link.state == LinkState::Linked) else {
        return Ok(None);
    };
    let note = read::get(&library.open, &link.note_id, None).map_err(|e| e.to_string())?;
    Ok(note.map(|note| note.title))
}

/// `FlushOptions`.
pub struct FlushOptions<'a> {
    pub time_zone: Tz,
    /// Books whose note write is still owed: their journal lines wait for the note.
    pub retry_book_ids: &'a HashSet<i64>,
}

/// `flushJournal`: writes the pending days, oldest first. A day whose entry is open in an
/// editor, or whose write failed, stays pending for the next run (D6). Books without a note
/// are left out, and dropped unless their note is still owed.
pub fn flush_journal(
    library: &Library,
    state: &RunState,
    options: &FlushOptions<'_>,
    stopped: &mut dyn FnMut() -> bool,
) -> Result<(), StorageError> {
    let pending = state.journal_pending()?;
    let mut titles: HashMap<i64, Option<String>> = HashMap::new();
    for (date, owed) in &pending {
        if stopped() {
            return Ok(());
        }
        let outcome = flush_day(library, state, options, &mut titles, date, owed);
        let keep = match outcome {
            Ok(DayWrite::Busy) => true,
            Ok(_) => false,
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    date = date.as_str(),
                    "a Readwise journal day could not be written: {error}"
                );
                true
            }
        };
        if keep {
            // The whole day stays: the next run writes it, or the entry closes first.
            let mut rest = state.journal_pending()?;
            rest.insert(date.clone(), owed.clone());
            state.set_journal_pending(&rest)?;
        }
    }
    Ok(())
}

fn flush_day(
    library: &Library,
    state: &RunState,
    options: &FlushOptions<'_>,
    titles: &mut HashMap<i64, Option<String>>,
    date: &str,
    owed: &BTreeMap<String, u64>,
) -> Result<DayWrite, String> {
    let mut title_of = |book_id: i64| -> Result<Option<String>, String> {
        if let Some(title) = titles.get(&book_id) {
            return Ok(title.clone());
        }
        let title = book_title(library, state, book_id)?;
        titles.insert(book_id, title.clone());
        Ok(title)
    };
    let mut day: BTreeMap<i64, JournalBook> = BTreeMap::new();
    for (book_id, (count, first)) in books_of_day(state, date, options.time_zone)? {
        if let Some(title) = title_of(book_id)? {
            day.insert(
                book_id,
                JournalBook {
                    title,
                    count,
                    first,
                },
            );
        }
    }
    let mut arrivals = Vec::new();
    let mut stays: BTreeMap<String, u64> = BTreeMap::new();
    for (key, count) in owed {
        // `Number(key)`: a key that is not a book id names no note and no retry.
        let Ok(book_id) = key.parse::<i64>() else {
            continue;
        };
        let title = title_of(book_id)?;
        match (title, day.get(&book_id)) {
            (Some(title), Some(listed)) => arrivals.push(JournalBook {
                title,
                count: *count,
                first: listed.first.clone(),
            }),
            (None, _) if options.retry_book_ids.contains(&book_id) => {
                stays.insert(key.clone(), *count);
            }
            _ => {}
        }
    }
    // Pending goes first: a crash after the write must not append the same lines again. A day
    // that was not written gets its entry back in `flush_journal`.
    let mut rest: JournalPending = state.journal_pending().map_err(|e| e.to_string())?;
    match stays.is_empty() {
        true => rest.remove(date),
        false => rest.insert(date.to_owned(), stays),
    };
    state
        .set_journal_pending(&rest)
        .map_err(|e| e.to_string())?;
    let day: Vec<JournalBook> = day.into_values().collect();
    write_day(library, date, &day, &arrivals)
}

#[cfg(test)]
mod tests {
    use super::super::types::ReadwiseHighlight;
    use super::*;

    fn highlight(id: i64, at: &str) -> ReadwiseHighlight {
        ReadwiseHighlight {
            id,
            highlighted_at: Some(at.to_owned()),
            ..ReadwiseHighlight::default()
        }
    }

    #[test]
    fn a_later_book_overrides_a_highlight_and_a_deleted_book_deletes_all() {
        let partial = ReadwiseBook {
            user_book_id: 1,
            highlights: Some(vec![highlight(5, "2026-01-02T10:00:00Z")]),
            ..ReadwiseBook::default()
        };
        let full = ReadwiseBook {
            user_book_id: 1,
            is_deleted: Some(true),
            highlights: Some(vec![
                highlight(6, "not a date"),
                highlight(5, "2026-01-03T10:00:00Z"),
            ]),
            ..ReadwiseBook::default()
        };
        let rows = index_rows(&[&partial, &full]);
        let ids: Vec<i64> = rows.iter().map(|row| row.highlight_id).collect();
        assert_eq!(ids, [5, 6]);
        assert_eq!(
            rows[0].highlighted_at.as_deref(),
            Some("2026-01-03T10:00:00.000Z")
        );
        assert_eq!(rows[1].highlighted_at, None);
        assert!(rows.iter().all(|row| row.deleted));
    }

    #[test]
    fn a_day_window_spans_every_zone_and_a_bad_date_has_none() {
        let window = day_window("2026-01-02").unwrap();
        assert_eq!(
            window,
            (
                "2026-01-01T10:00:00.000Z".to_owned(),
                "2026-01-03T12:00:00.000Z".to_owned()
            )
        );
        assert_eq!(day_window("2026-02-30"), None);
    }

    #[test]
    fn a_pending_list_with_a_count_below_one_reads_as_empty() {
        let good = r#"{"2026-01-02":{"7":2}}"#;
        assert_eq!(parse_journal_pending(Some(good))["2026-01-02"]["7"], 2);
        for bad in [r#"{"2026-01-02":{"7":0}}"#, r#"{"d":{"7":-1}}"#, "[]", "{"] {
            assert!(parse_journal_pending(Some(bad)).is_empty(), "{bad}");
        }
        assert_eq!(journal_pending_text(&JournalPending::new()), None);
    }
}
