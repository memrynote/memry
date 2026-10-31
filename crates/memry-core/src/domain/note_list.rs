//! The desktop's note list (`listNotes`, `vault/notes-queries.ts`): the live note records that
//! have a vault file, with the file's row and the note's tags, in one read. No file is opened;
//! the list is what the records and the rows say.
//!
//! A note is listed only once a `note_files` row names its file, as Electron lists only what
//! its file cache holds: a synced note whose file is not written yet has no path to show. The
//! tags are the frontmatter's and the body's together, spelled as stored, in the order
//! Electron's `getNoteTags` gives (`setNoteTags`): the frontmatter's by position, then each
//! body tag the frontmatter lacks by tag fold, in body order.
//!
//! Every tag read here is keyed by the listed note's id, so it searches the tag tables'
//! `(note_id, tag)` keys instead of scanning every tag in the vault per listed note.

use rusqlite::{Connection, Row, params_from_iter, types::Value as SqlValue};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::notes::names::parse_stored;

/// One listed note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedNote {
    pub id: String,
    /// Vault-relative, `/`-separated.
    pub path: String,
    pub title: String,
    pub emoji: Option<String>,
    /// Epoch milliseconds; `None` when the record carries no such instant.
    pub created_at: Option<i64>,
    pub modified_at: Option<i64>,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    /// The record's properties; empty when it holds none or a value that does not parse.
    pub properties: serde_json::Map<String, serde_json::Value>,
    pub file_type: String,
    pub mime_type: Option<String>,
    pub file_size: Option<i64>,
    pub local_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NoteSort {
    #[default]
    Modified,
    Created,
    Title,
}

/// What to list. A note is in `folder` when its path is under it at any depth.
#[derive(Debug, Clone, Default)]
pub struct NoteListQuery {
    pub folder: Option<String>,
    /// Every one of these, by tag fold.
    pub tags: Vec<String>,
    pub sort: NoteSort,
    pub ascending: bool,
    pub limit: u32,
    pub offset: u32,
}

/// One page, and how many notes the query matches in all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteListPage {
    pub notes: Vec<ListedNote>,
    pub total: u32,
    pub has_more: bool,
}

const COLUMNS: &str = "n.id, f.path, n.title, n.emoji, n.created_at, n.modified_at, n.aliases, \
     f.file_type, f.mime_type, f.file_size, f.local_only, n.properties";

/// The listed note's tags as a JSON array. `note_body_tags`' rowid is its insertion order,
/// which `body_tags::write` keeps as the body's.
const TAGS_COLUMN: &str = "(SELECT json_group_array(tag) FROM (\
     SELECT h.tag AS tag, 0 AS half, h.position AS rank FROM note_tags h \
     WHERE h.note_id = n.id AND h.deleted_at IS NULL \
     UNION ALL \
     SELECT b.tag, 1, b.rowid FROM note_body_tags b WHERE b.note_id = n.id \
     AND NOT EXISTS (SELECT 1 FROM note_tags h WHERE h.note_id = n.id \
     AND h.deleted_at IS NULL AND tag_fold(h.tag) = tag_fold(b.tag)) \
     ORDER BY half, rank))";

/// The two statements a list runs, the match count and the page, and their shared arguments.
fn statements(query: &NoteListQuery) -> (String, String, Vec<SqlValue>) {
    let mut filters = vec!["n.deleted_at IS NULL".to_owned()];
    let mut args: Vec<SqlValue> = Vec::new();
    if let Some(folder) = query.folder.as_deref().filter(|f| !f.is_empty()) {
        // An exact prefix, so `_` and `%` in a folder name match only themselves.
        args.push(SqlValue::Text(format!("{folder}/")));
        filters.push(format!(
            "substr(f.path, 1, length(?{0})) = ?{0}",
            args.len()
        ));
    }
    for tag in &query.tags {
        args.push(SqlValue::Text(tag.clone()));
        filters.push(format!(
            "(EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id \
             AND t.deleted_at IS NULL AND tag_fold(t.tag) = tag_fold(?{0})) \
             OR EXISTS (SELECT 1 FROM note_body_tags t WHERE t.note_id = n.id \
             AND tag_fold(t.tag) = tag_fold(?{0})))",
            args.len()
        ));
    }
    let from = format!(
        "FROM notes n JOIN note_files f ON f.note_id = n.id WHERE {}",
        filters.join(" AND ")
    );
    let order = match query.sort {
        NoteSort::Modified => "n.modified_at",
        NoteSort::Created => "n.created_at",
        NoteSort::Title => "n.title",
    };
    let direction = if query.ascending { "ASC" } else { "DESC" };
    // One past the page tells whether more follow.
    let fetch = i64::from(query.limit) + 1;
    let page = format!(
        "SELECT {COLUMNS}, {TAGS_COLUMN} {from} ORDER BY {order} {direction}, n.id \
         LIMIT {fetch} OFFSET {}",
        query.offset
    );
    (format!("SELECT COUNT(*) {from}"), page, args)
}

/// The page `query` asks for.
pub fn list(conn: &Connection, query: &NoteListQuery) -> Result<NoteListPage, StorageError> {
    let (count, page, args) = statements(query);
    let total: i64 = conn
        .query_row(&count, params_from_iter(args.iter()), |row| row.get(0))
        .map_err(failed)?;
    let mut statement = conn.prepare(&page).map_err(failed)?;
    let mut notes = statement
        .query_map(params_from_iter(args.iter()), read)
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    let has_more = notes.len() > query.limit as usize;
    notes.truncate(query.limit as usize);
    Ok(NoteListPage {
        notes,
        total: u32::try_from(total).unwrap_or(u32::MAX),
        has_more,
    })
}

/// The live note `id`, when it has a file.
pub fn by_id(conn: &Connection, id: &str) -> Result<Option<ListedNote>, StorageError> {
    one(conn, "n.id = ?1", id)
}

/// The live note whose file is at `path` (exactly as stored).
pub fn by_path(conn: &Connection, path: &str) -> Result<Option<ListedNote>, StorageError> {
    one(conn, "f.path = ?1", path)
}

fn one(conn: &Connection, filter: &str, value: &str) -> Result<Option<ListedNote>, StorageError> {
    let sql = format!(
        "SELECT {COLUMNS}, {TAGS_COLUMN} FROM notes n JOIN note_files f ON f.note_id = n.id \
         WHERE n.deleted_at IS NULL AND {filter}"
    );
    let mut statement = conn.prepare(&sql).map_err(failed)?;
    let mut rows = statement.query_map([value], read).map_err(failed)?;
    rows.next().transpose().map_err(failed)
}

fn read(row: &Row<'_>) -> rusqlite::Result<ListedNote> {
    let aliases: Option<String> = row.get(6)?;
    let properties: Option<String> = row.get(11)?;
    let tags: Option<String> = row.get(12)?;
    Ok(ListedNote {
        id: row.get(0)?,
        path: row.get(1)?,
        title: row.get(2)?,
        emoji: row.get(3)?,
        created_at: row.get(4)?,
        modified_at: row.get(5)?,
        // A stored list that does not parse lists no aliases rather than failing the list.
        aliases: parse_stored(aliases).unwrap_or_default(),
        tags: tags
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default(),
        properties: properties
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default(),
        file_type: row.get(7)?,
        mime_type: row.get(8)?,
        file_size: row.get(9)?,
        local_only: row.get::<_, i64>(10)? != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Db;
    use crate::storage::migrations::{DATA_MIGRATIONS, run};

    fn plan(db: &Db, sql: &str, args: &[SqlValue]) -> Vec<String> {
        db.call_blocking(|conn| {
            let mut statement = conn
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .map_err(failed)?;
            statement
                .query_map(params_from_iter(args.iter()), |row| row.get::<_, String>(3))
                .map_err(failed)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(failed)
        })
        .expect("plan")
    }

    // A tag read that is not keyed by the listed note scans every tag in the vault once per
    // listed note. The plan proves each one searches the `(note_id, tag)` keys.
    #[test]
    fn reads_tags_by_the_listed_note_key() {
        let db = Db::open_in_memory().expect("open");
        db.call_blocking(|conn| run(conn, DATA_MIGRATIONS))
            .expect("migrate");
        let query = NoteListQuery {
            tags: vec!["Work".to_owned()],
            limit: 10,
            ..NoteListQuery::default()
        };
        let (count, page, args) = statements(&query);
        let steps = [plan(&db, &count, &args), plan(&db, &page, &args)].concat();

        let tag_tables = ["note_tags", "note_body_tags", " h", " b", " t"];
        let scans: Vec<&String> = steps
            .iter()
            .filter(|step| step.starts_with("SCAN") && tag_tables.iter().any(|t| step.contains(t)))
            .collect();
        assert!(scans.is_empty(), "{steps:#?}");
        let searches = steps
            .iter()
            .filter(|step| step.starts_with("SEARCH") && step.contains("sqlite_autoindex_note_"))
            .count();
        assert!(searches >= 5, "{steps:#?}");
    }
}
