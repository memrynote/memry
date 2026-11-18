//! The filing patterns behind the history fallbacks of `suggest`: Electron's
//! `getFilingPatterns` and `getRecentFilingDestinations`
//! (`apps/desktop/src/main/inbox/suggestions.ts:430-487`), read from filed
//! captures because the `filing_history` table is not recreated.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

use super::suggest::folder_of;

/// A filing-history pattern: captures of one type filed to one place.
#[derive(Debug, Clone, PartialEq)]
pub struct FilingPattern {
    pub destination: String,
    pub action: String,
    pub count: i64,
    pub tags: Vec<String>,
}

/// `getFilingPatterns`: the ten most used (`filed_to`, `filed_action`) pairs
/// of live filed captures of `item_type`, each with the tags of the latest
/// capture filed there. Ties break on the pair, ascending.
pub fn filing_patterns(
    conn: &Connection,
    item_type: &str,
) -> Result<Vec<FilingPattern>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT filed_to, filed_action, count(*),
                    (SELECT l.id FROM inbox_items l
                      WHERE l.deleted_at IS NULL AND l.type = ?1 AND l.filed_at IS NOT NULL
                        AND l.filed_to = i.filed_to AND l.filed_action = i.filed_action
                      ORDER BY l.filed_at DESC, l.id DESC LIMIT 1)
               FROM inbox_items i
              WHERE deleted_at IS NULL AND type = ?1 AND filed_at IS NOT NULL
                AND filed_to IS NOT NULL AND filed_action IS NOT NULL
              GROUP BY filed_to, filed_action
              ORDER BY count(*) DESC, filed_to, filed_action
              LIMIT 10",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![item_type], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    rows.into_iter()
        .map(|(filed_to, action, count, latest)| {
            Ok(FilingPattern {
                destination: folder_of(&filed_to).to_owned(),
                action,
                count,
                tags: super::tags_of(conn, &latest)?,
            })
        })
        .collect()
}

/// `getRecentFilingDestinations(5)`: the five most used `filed_to` of live
/// folder filings, as folders, with their counts.
pub fn recent_destinations(conn: &Connection) -> Result<Vec<(String, i64)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT filed_to, count(*) FROM inbox_items
              WHERE deleted_at IS NULL AND filed_at IS NOT NULL
                AND filed_action = 'folder' AND filed_to IS NOT NULL
              GROUP BY filed_to
              ORDER BY count(*) DESC, filed_to
              LIMIT 5",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))
        .map_err(failed)?
        .collect::<Result<Vec<(String, i64)>, _>>()
        .map_err(failed)?;
    Ok(rows
        .into_iter()
        .map(|(path, count)| (folder_of(&path).to_owned(), count))
        .collect())
}

/// What [`assemble`] reads from `data.db`.
#[derive(Debug, Clone, Default)]
pub struct FilingHistory {
    pub patterns: Vec<FilingPattern>,
    pub recent: Vec<(String, i64)>,
}
