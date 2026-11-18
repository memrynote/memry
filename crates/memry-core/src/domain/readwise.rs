//! Readwise's device-local state in `data.db` (migration 0038): the link from a Readwise book
//! or Reader document to its note (`links-repository.ts`), and the run state desktop kept as
//! `readwise.<name>` settings (`sync-state.ts`). Neither syncs: a note's `readwise_url` is the
//! identity that travels, and the links are rebuilt from it.

use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::api::errors::StorageError;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// `ReadwiseLinkState`. A state this build does not know reads as [`LinkState::Linked`]'s
/// opposite: [`LinkState::Other`] keeps the row out of every write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    Linked,
    /// The user deleted the note: the book never makes a new one (D9).
    NoteDeleted,
    /// The book was deleted in Readwise: the note stays, the book stops syncing (D9).
    SourceDeleted,
    Other(String),
}

impl LinkState {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Linked => "linked",
            Self::NoteDeleted => "note-deleted",
            Self::SourceDeleted => "source-deleted",
            Self::Other(state) => state,
        }
    }

    fn parse(state: String) -> Self {
        match state.as_str() {
            "linked" => Self::Linked,
            "note-deleted" => Self::NoteDeleted,
            "source-deleted" => Self::SourceDeleted,
            _ => Self::Other(state),
        }
    }
}

/// A `readwise_links` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub id: i64,
    pub readwise_book_id: Option<i64>,
    pub reader_document_id: Option<String>,
    pub note_id: String,
    pub state: LinkState,
    pub updated_at: i64,
}

/// Which row a state change names (`LinkKey`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkKey {
    Book(i64),
    ReaderDocument(String),
    Note(String),
}

const COLUMNS: &str = "id, readwise_book_id, reader_document_id, note_id, state, updated_at";

fn link_of(row: &Row<'_>) -> rusqlite::Result<Link> {
    Ok(Link {
        id: row.get(0)?,
        readwise_book_id: row.get(1)?,
        reader_document_id: row.get(2)?,
        note_id: row.get(3)?,
        state: LinkState::parse(row.get(4)?),
        updated_at: row.get(5)?,
    })
}

fn one(
    conn: &Connection,
    filter: &str,
    value: &dyn rusqlite::ToSql,
) -> Result<Option<Link>, StorageError> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM readwise_links WHERE {filter} ORDER BY id LIMIT 1"),
        [value],
        link_of,
    )
    .optional()
    .map_err(failed)
}

pub fn link_by_book(conn: &Connection, book_id: i64) -> Result<Option<Link>, StorageError> {
    one(conn, "readwise_book_id = ?1", &book_id)
}

pub fn link_by_reader_document(
    conn: &Connection,
    document_id: &str,
) -> Result<Option<Link>, StorageError> {
    one(conn, "reader_document_id = ?1", &document_id)
}

/// `getLinkByNoteId`: the lowest row naming the note.
pub fn link_by_note(conn: &Connection, note_id: &str) -> Result<Option<Link>, StorageError> {
    one(conn, "note_id = ?1", &note_id)
}

/// `getLinkForBook`: the book's own row, or the row of its Reader document (`external_id`,
/// D11), so a Reader note made before the book's highlights arrived takes the book.
pub fn link_for_book(
    conn: &Connection,
    book_id: i64,
    external_id: Option<&str>,
) -> Result<Option<Link>, StorageError> {
    if let Some(link) = link_by_book(conn, book_id)? {
        return Ok(Some(link));
    }
    match external_id.filter(|id| !id.is_empty()) {
        Some(id) => link_by_reader_document(conn, id),
        None => Ok(None),
    }
}

/// `listLinks`, by row id.
pub fn links(conn: &Connection, state: Option<&LinkState>) -> Result<Vec<Link>, StorageError> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM readwise_links WHERE ?1 IS NULL OR state = ?1 ORDER BY id"
        ))
        .map_err(failed)?;
    let rows = statement
        .query_map([state.map(LinkState::as_str)], link_of)
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

/// `completeLink`: gives `link` the id it lacks, so the book and its Reader document share one
/// note (D11). Another row that already holds the id keeps it: the lowest id wins.
pub fn complete_link(
    conn: &Connection,
    link: &Link,
    book_id: i64,
    document_id: Option<&str>,
    now_ms: i64,
) -> Result<(), StorageError> {
    let book = link.readwise_book_id.unwrap_or(book_id);
    let document = link
        .reader_document_id
        .clone()
        .or_else(|| document_id.map(str::to_owned));
    if Some(book) == link.readwise_book_id && document == link.reader_document_id {
        return Ok(());
    }
    let taken = (link.readwise_book_id.is_none() && link_by_book(conn, book)?.is_some())
        || match (&link.reader_document_id, &document) {
            (None, Some(document)) => link_by_reader_document(conn, document)?.is_some(),
            _ => false,
        };
    if taken {
        return Ok(());
    }
    conn.execute(
        "UPDATE readwise_links SET readwise_book_id = ?1, reader_document_id = ?2, \
         updated_at = ?3 WHERE id = ?4",
        params![book, document, now_ms, link.id],
    )
    .map_err(failed)?;
    Ok(())
}

/// What [`upsert_link`] writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpsertLink<'a> {
    pub book_id: Option<i64>,
    pub document_id: Option<&'a str>,
    pub note_id: &'a str,
    pub state: LinkState,
}

/// `upsertLink`: inserts or updates the row that holds this book or Reader document. A row
/// found by either id keeps its identity and gains the other id, unless another row already
/// holds that document (a takeover can bring two notes for one document, D11). In one
/// transaction. `Err` when neither id is given.
pub fn upsert_link(
    conn: &mut Connection,
    input: &UpsertLink<'_>,
    now_ms: i64,
) -> Result<Link, StorageError> {
    let tx = conn.transaction().map_err(failed)?;
    let link = upsert_in(&tx, input, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(link)
}

/// [`upsert_link`] inside the caller's transaction.
fn upsert_in(tx: &Connection, input: &UpsertLink<'_>, now_ms: i64) -> Result<Link, StorageError> {
    if input.book_id.is_none() && input.document_id.is_none() {
        return Err(StorageError::Failed {
            what: "upsertLink needs a readwiseBookId or a readerDocumentId".to_owned(),
        });
    }
    let existing = match input.book_id {
        Some(book) => link_by_book(tx, book)?,
        None => None,
    };
    let existing = match (existing, input.document_id) {
        (Some(link), _) => Some(link),
        (None, Some(document)) => link_by_reader_document(tx, document)?,
        (None, None) => None,
    };
    let id = match existing {
        None => {
            tx.execute(
                "INSERT INTO readwise_links \
                 (readwise_book_id, reader_document_id, note_id, state, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    input.book_id,
                    input.document_id,
                    input.note_id,
                    input.state.as_str(),
                    now_ms
                ],
            )
            .map_err(failed)?;
            tx.last_insert_rowid()
        }
        Some(link) => {
            let held_elsewhere = match input.document_id {
                Some(document) if link.reader_document_id.as_deref() != Some(document) => {
                    link_by_reader_document(tx, document)?.is_some()
                }
                _ => false,
            };
            let document = match (held_elsewhere, input.document_id) {
                (false, Some(document)) => Some(document.to_owned()),
                _ => link.reader_document_id.clone(),
            };
            tx.execute(
                "UPDATE readwise_links SET readwise_book_id = ?1, reader_document_id = ?2, \
                 note_id = ?3, state = ?4, updated_at = ?5 WHERE id = ?6",
                params![
                    input.book_id.or(link.readwise_book_id),
                    document,
                    input.note_id,
                    input.state.as_str(),
                    now_ms,
                    link.id
                ],
            )
            .map_err(failed)?;
            link.id
        }
    };
    one(tx, "id = ?1", &id)?.ok_or_else(|| StorageError::Failed {
        what: "the upserted Readwise link is gone".to_owned(),
    })
}

/// `markLinkState`: the updated row, `None` when no row matches.
pub fn mark_link_state(
    conn: &Connection,
    key: &LinkKey,
    state: &LinkState,
    now_ms: i64,
) -> Result<Option<Link>, StorageError> {
    let (filter, value): (&str, &dyn rusqlite::ToSql) = match key {
        LinkKey::Book(id) => ("readwise_book_id = ?1", id),
        LinkKey::ReaderDocument(id) => ("reader_document_id = ?1", id),
        LinkKey::Note(id) => ("note_id = ?1", id),
    };
    let changed = conn
        .execute(
            &format!("UPDATE readwise_links SET state = ?2, updated_at = ?3 WHERE {filter}"),
            params![value, state.as_str(), now_ms],
        )
        .map_err(failed)?;
    match changed {
        0 => Ok(None),
        _ => one(conn, filter, value),
    }
}

/// A run-state value (`getSetting('readwise.<key>')`), the text as stored.
pub fn run_state(conn: &Connection, key: &str) -> Result<Option<String>, StorageError> {
    conn.query_row(
        "SELECT value FROM readwise_run_state WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(failed)
}

/// `setSetting`, or `deleteSetting` for `None`.
pub fn set_run_state(
    conn: &Connection,
    key: &str,
    value: Option<&str>,
    now_ms: i64,
) -> Result<(), StorageError> {
    match value {
        Some(value) => conn.execute(
            "INSERT INTO readwise_run_state (key, value, modified_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, \
             modified_at = excluded.modified_at",
            params![key, value, now_ms],
        ),
        None => conn.execute("DELETE FROM readwise_run_state WHERE key = ?1", [key]),
    }
    .map_err(failed)?;
    Ok(())
}

/// The Readwise item a `readwise_url` names (D4).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ReadwiseItem {
    Book(i64),
    ReaderDocument(String),
}

/// The longest `readwise_url` read: far over either form, so a hostile value costs one bound.
const MAX_URL_BYTES: usize = 512;

/// `parseReadwiseUrl`: `https?://(www.)?readwise.io/bookreview/<digits>/?` or
/// `https?://read.readwise.io/read/<[A-Za-z0-9_-]+>/?`, after JS `trim`; anything else `None`.
/// A book id past `i64` is `None` (TypeScript's `Number` rounds it to another book).
pub fn parse_readwise_url(url: &str) -> Option<ReadwiseItem> {
    let trimmed = url.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if trimmed.len() > MAX_URL_BYTES {
        return None;
    }
    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let book = rest
        .strip_prefix("www.readwise.io/bookreview/")
        .or_else(|| rest.strip_prefix("readwise.io/bookreview/"));
    if let Some(id) = book {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        return id.parse().ok().map(ReadwiseItem::Book);
    }
    let id = rest.strip_prefix("read.readwise.io/read/")?;
    let valid = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    (!id.is_empty() && id.bytes().all(valid)).then(|| ReadwiseItem::ReaderDocument(id.to_owned()))
}

/// `rebuildLinks`: refills the links from the notes' `readwise_url` values (`(note id, value)`
/// pairs from the index), in one transaction. Lowest note id wins an item two notes name; a
/// `source-deleted` row stays so, every other matched row becomes `linked`. Returns the notes
/// linked.
pub fn rebuild_links(
    conn: &mut Connection,
    mut urls: Vec<(String, String)>,
    now_ms: i64,
) -> Result<usize, StorageError> {
    urls.sort_by(|a, b| a.0.cmp(&b.0));
    let tx = conn.transaction().map_err(failed)?;
    let mut seen = std::collections::HashSet::new();
    let mut linked = 0;
    for (note_id, url) in &urls {
        let Some(item) = parse_readwise_url(url) else {
            continue;
        };
        if !seen.insert(item.clone()) {
            continue;
        }
        let (existing, book_id, document_id) = match &item {
            ReadwiseItem::Book(id) => (link_by_book(&tx, *id)?, Some(*id), None),
            ReadwiseItem::ReaderDocument(id) => {
                (link_by_reader_document(&tx, id)?, None, Some(id.as_str()))
            }
        };
        let state = match existing.map(|link| link.state) {
            Some(LinkState::SourceDeleted) => LinkState::SourceDeleted,
            _ => LinkState::Linked,
        };
        let input = UpsertLink {
            book_id,
            document_id,
            note_id,
            state,
        };
        upsert_in(&tx, &input, now_ms)?;
        linked += 1;
    }
    tx.commit().map_err(failed)?;
    Ok(linked)
}
