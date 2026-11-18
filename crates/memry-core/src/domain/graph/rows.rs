//! The rows the graph reads, each a single statement over the owner's table: `notes`,
//! `journal_entries`, `note_tags`, `tasks` and `projects` in data.db, `note_stats`,
//! `note_links`, `property_refs` and `portal_refs` in index.db. A read takes [`Among::All`]
//! for the whole-vault graph or a JSON id list for the local traversal, which `json_each`
//! expands, so a frontier of any size is one statement and no bound-parameter ceiling applies.

use std::collections::HashMap;

use rusqlite::{Connection, Row, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

/// Which rows a read returns: all of them, or those whose filter column is in a JSON id list.
#[derive(Clone, Copy)]
pub(super) enum Among<'a> {
    All,
    Ids(&'a str),
}

/// A markdown note, or a journal day titled by its date.
pub(super) struct NoteRow {
    pub id: String,
    pub title: String,
    pub journal: bool,
    pub emoji: Option<String>,
}

pub(super) struct TaskRow {
    pub id: String,
    pub title: String,
    pub project_id: String,
}

pub(super) struct ProjectRow {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
}

/// One `note_links` row; `target_id` is `None` for a link to a title no note has.
pub(super) struct LinkRow {
    pub source_id: String,
    pub target_id: Option<String>,
    pub target_title: String,
}

/// `AND <column> IN (...)` for [`Among::Ids`], nothing for [`Among::All`].
fn filter(column: &str, among: Among<'_>) -> String {
    match among {
        Among::All => String::new(),
        Among::Ids(_) => format!(" AND {column} IN (SELECT value FROM json_each(?1))"),
    }
}

fn collect<T>(
    conn: &Connection,
    sql: &str,
    among: Among<'_>,
    map: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, StorageError> {
    let mut statement = conn.prepare(sql).map_err(failed)?;
    let rows = match among {
        Among::All => statement.query_map([], map),
        Among::Ids(ids) => statement.query_map(params![ids], map),
    }
    .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

/// Live markdown notes, then live journal days (Electron's `note_cache` rows with
/// `file_type = 'markdown'`, where a day's `date` is set and its title is the date). A note
/// wins an id it shares with a day, as `journal_ops::links::live_items` answers it.
pub(super) fn notes(data: &Connection, among: Among<'_>) -> Result<Vec<NoteRow>, StorageError> {
    let sql = format!(
        "SELECT id, title, emoji, 0 FROM notes \
         WHERE deleted_at IS NULL AND file_type = 'markdown'{} \
         UNION ALL \
         SELECT id, date, NULL, 1 FROM journal_entries WHERE deleted_at IS NULL{}",
        filter("id", among),
        filter("id", among)
    );
    let mut rows = collect(data, &sql, among, |row| {
        Ok(NoteRow {
            id: row.get(0)?,
            title: row.get(1)?,
            emoji: row.get(2)?,
            journal: row.get(3)?,
        })
    })?;
    let mut seen = std::collections::HashSet::new();
    rows.retain(|row| seen.insert(row.id.clone()));
    Ok(rows)
}

/// The words the vault file of each note holds (`note_stats`, Electron's `note_cache`
/// `word_count`). A note the index has not measured is absent.
pub(super) fn word_counts(
    index: &Connection,
    among: Among<'_>,
) -> Result<HashMap<String, i64>, StorageError> {
    let sql = format!(
        "SELECT note_id, word_count FROM note_stats WHERE 1{}",
        filter("note_id", among)
    );
    Ok(
        collect(index, &sql, among, |row| Ok((row.get(0)?, row.get(1)?)))?
            .into_iter()
            .collect(),
    )
}

/// Each note's live tags, in the order the note lists them.
pub(super) fn tags(
    data: &Connection,
    among: Among<'_>,
) -> Result<HashMap<String, Vec<String>>, StorageError> {
    let sql = format!(
        "SELECT note_id, tag FROM note_tags WHERE deleted_at IS NULL{} \
         ORDER BY note_id, position, tag",
        filter("note_id", among)
    );
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for (note_id, tag) in collect(data, &sql, among, |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        out.entry(note_id).or_default().push(tag);
    }
    Ok(out)
}

/// Live, unarchived tasks whose `column` is among the ids.
pub(super) fn tasks(
    data: &Connection,
    column: &str,
    among: Among<'_>,
) -> Result<Vec<TaskRow>, StorageError> {
    let sql = format!(
        "SELECT id, title, project_id FROM tasks \
         WHERE deleted_at IS NULL AND archived_at IS NULL{}",
        filter(column, among)
    );
    collect(data, &sql, among, |row| {
        Ok(TaskRow {
            id: row.get(0)?,
            title: row.get(1)?,
            project_id: row.get(2)?,
        })
    })
}

/// Live, unarchived projects.
pub(super) fn projects(
    data: &Connection,
    among: Among<'_>,
) -> Result<Vec<ProjectRow>, StorageError> {
    let sql = format!(
        "SELECT id, name, icon FROM projects \
         WHERE deleted_at IS NULL AND archived_at IS NULL{}",
        filter("id", among)
    );
    collect(data, &sql, among, |row| {
        Ok(ProjectRow {
            id: row.get(0)?,
            name: row.get(1)?,
            icon: row.get(2)?,
        })
    })
}

/// `(task id, note id)` for each note a live task links (`tasks.linked_note_ids`, Electron's
/// `task_notes`), once per pair. `column` is `t.id` or `j.value` (the note id). A list that
/// is not a JSON array links nothing.
pub(super) fn task_notes(
    data: &Connection,
    column: &str,
    among: Among<'_>,
) -> Result<Vec<(String, String)>, StorageError> {
    let sql = format!(
        "SELECT DISTINCT t.id, j.value FROM tasks t, json_each(\
           CASE WHEN json_valid(t.linked_note_ids) AND json_type(t.linked_note_ids) = 'array' \
           THEN t.linked_note_ids ELSE '[]' END) j \
         WHERE t.deleted_at IS NULL AND j.type = 'text'{}",
        filter(column, among)
    );
    collect(data, &sql, among, |row| Ok((row.get(0)?, row.get(1)?)))
}

/// `note_links` rows whose `column` is among the ids.
pub(super) fn links(
    index: &Connection,
    column: &str,
    among: Among<'_>,
) -> Result<Vec<LinkRow>, StorageError> {
    let ghost = if column == "target_title" {
        " AND target_id IS NULL"
    } else {
        ""
    };
    let sql = format!(
        "SELECT source_id, target_id, target_title FROM note_links WHERE 1{ghost}{}",
        filter(column, among)
    );
    collect(index, &sql, among, |row| {
        Ok(LinkRow {
            source_id: row.get(0)?,
            target_id: row.get(1)?,
            target_title: row.get(2)?,
        })
    })
}

/// `(source, property, target)` for each relation property that names a note.
pub(super) fn relations(
    index: &Connection,
    column: &str,
    among: Among<'_>,
) -> Result<Vec<(String, String, String)>, StorageError> {
    let sql = format!(
        "SELECT source_id, name, target_id FROM property_refs WHERE target_type = 'note'{}",
        filter(column, among)
    );
    collect(index, &sql, among, |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })
}

/// `(host, source)` once per note a portal fence of the host shows (`listPortalEdges`).
pub(super) fn portals(
    index: &Connection,
    column: &str,
    among: Among<'_>,
) -> Result<Vec<(String, String)>, StorageError> {
    let sql = format!(
        "SELECT DISTINCT host_note_id, source_note_id FROM portal_refs \
         WHERE source_note_id IS NOT NULL{}",
        filter(column, among)
    );
    collect(index, &sql, among, |row| Ok((row.get(0)?, row.get(1)?)))
}
