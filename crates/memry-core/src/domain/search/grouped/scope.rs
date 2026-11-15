//! Which items of one type the project, folder and note file type filters keep
//! (`applyPostFilters`, `search.ts:500-513`, and `noteFileTypeFilter`,
//! `search.ts:93-101`). Read once from `data.db`, so the index query and the
//! semantic leg narrow by one rule.

use std::collections::HashSet;

use rusqlite::{Connection, ToSql};

use crate::api::errors::StorageError;

use super::super::{SearchType, failed};
use super::GroupedQuery;

/// What the filters leave of one type.
pub(super) enum Scope {
    /// No filter narrows this type.
    Every,
    /// These ids.
    Only(HashSet<String>),
    /// The filters exclude the whole type: a project keeps tasks only, a folder
    /// notes and journal days only.
    Nothing,
}

impl Scope {
    pub(super) fn keeps(&self, id: &str) -> bool {
        match self {
            Self::Every => true,
            Self::Only(ids) => ids.contains(id),
            Self::Nothing => false,
        }
    }
}

pub(super) fn scope(
    data: &Connection,
    query: &GroupedQuery,
    kind: SearchType,
) -> Result<Scope, StorageError> {
    let project = query.project_id.as_deref();
    let folder = query.folder_path.as_deref();
    let file_types = (kind == SearchType::Note && !query.note_file_types.is_empty())
        .then(|| serde_json::to_string(&query.note_file_types))
        .transpose()
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?;
    if (project.is_some() && kind != SearchType::Task)
        || (folder.is_some() && matches!(kind, SearchType::Task | SearchType::Inbox))
    {
        return Ok(Scope::Nothing);
    }
    let (sql, parameters): (&str, Vec<&dyn ToSql>) = match kind {
        SearchType::Task => match &project {
            Some(project) => ("SELECT id FROM tasks WHERE project_id = ?1", vec![project]),
            None => return Ok(Scope::Every),
        },
        SearchType::Inbox => return Ok(Scope::Every),
        SearchType::Journal => match &folder {
            Some(folder) => (
                "SELECT j.id FROM journal_entries j JOIN note_files f ON f.note_id = j.id
                 WHERE substr(f.path, 1, length(?1)) = ?1",
                vec![folder],
            ),
            None => return Ok(Scope::Every),
        },
        SearchType::Note if folder.is_none() && file_types.is_none() => return Ok(Scope::Every),
        // A NULL file type predates filed files and is markdown (`search.ts:88-90`).
        SearchType::Note => (
            "SELECT n.id FROM notes n LEFT JOIN note_files f ON f.note_id = n.id
             WHERE (?1 IS NULL OR COALESCE(n.file_type, 'markdown')
                                  IN (SELECT value FROM json_each(?1)))
               AND (?2 IS NULL OR substr(f.path, 1, length(?2)) = ?2)",
            vec![&file_types, &folder],
        ),
    };
    let mut statement = data.prepare(sql).map_err(failed)?;
    let rows = statement
        .query_map(parameters.as_slice(), |row| row.get::<_, String>(0))
        .map_err(failed)?;
    rows.map(|row| row.map_err(failed))
        .collect::<Result<_, _>>()
        .map(Scope::Only)
}

/// Whether the filters keep any markdown note, the only notes that lead filed
/// files (`search.ts:142`).
pub(super) fn keeps_markdown(query: &GroupedQuery) -> bool {
    query.note_file_types.is_empty() || query.note_file_types.iter().any(|t| t == "markdown")
}
