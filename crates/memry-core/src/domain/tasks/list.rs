//! Desktop's task list reads: `tasks:list` (`listTasks` and `countTasks`,
//! `apps/desktop/src/main/database/queries/tasks.ts:97-231`, wrapped by
//! `createTasksQueries().listTasks`, `packages/domain-tasks/src/queries.ts:55`),
//! `tasks:get`, `tasks:get-subtasks` and `tasks:get-tags`.
//!
//! Filters and sorts run on the `tasks` projection columns, as desktop's run
//! on its table; the rows come back from the stored payload through
//! [`task_records::by_ids`]. Subtask counts for a whole page come from one
//! grouped query, never one per row (desktop's `enrichTask` counts per row).
//!
//! Kept from desktop on purpose:
//! - `total` counts with `projectId`, `includeCompleted` and
//!   `includeArchived` only (`countTasks`), so a page filtered by status,
//!   parent, due date or tags can report `hasMore` past its last match.
//! - `search` is accepted by `TaskListSchema` and read by nothing.
//! - "Completed" is a `completedAt` value, not the status type.
//!
//! Rows that tie on the sort key are ordered by id, so offset paging is stable;
//! desktop leaves the order of ties to SQLite.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params, params_from_iter};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::tags;
use crate::domain::task_records::{self, TaskRecord};

/// The live task rows: a projection row whose stored payload is not a
/// tombstone. Every query here filters this set.
pub(super) const LIVE: &str = "FROM tasks t
       JOIN sync_items s ON s.item_type = 'task' AND s.item_id = t.id
      WHERE t.deleted_at IS NULL
        AND s.deleted_at IS NULL
        AND s.payload IS NOT NULL";

/// `TaskListSchema.sortBy`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SortBy {
    #[default]
    Position,
    DueDate,
    Priority,
    Created,
    Modified,
}

impl SortBy {
    fn column(self) -> &'static str {
        match self {
            Self::Position => "t.position",
            Self::DueDate => "t.due_date",
            Self::Priority => "t.priority",
            Self::Created => "t.created_at",
            Self::Modified => "t.modified_at",
        }
    }
}

/// `statusId` and `parentId` of `TaskListSchema`: absent matches any value,
/// `null` matches no value.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Match {
    #[default]
    Any,
    Null,
    Is(String),
}

/// `TaskListSchema` after its defaults. The caller validates `limit`
/// (1 to 1000) and `offset`; `search` has no field because desktop reads none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListQuery {
    /// An empty id filters nothing, as desktop's `if (projectId)`.
    pub project_id: Option<String>,
    pub status_id: Match,
    pub parent_id: Match,
    pub include_completed: bool,
    pub include_archived: bool,
    /// Inclusive `YYYY-MM-DD` bounds on `dueDate`; empty filters nothing.
    pub due_before: Option<String>,
    pub due_after: Option<String>,
    /// A task matches when it carries every tag, by tag fold.
    pub tags: Vec<String>,
    pub sort_by: SortBy,
    pub descending: bool,
    pub limit: u32,
    pub offset: u32,
}

impl Default for ListQuery {
    fn default() -> Self {
        Self {
            project_id: None,
            status_id: Match::Any,
            parent_id: Match::Any,
            include_completed: false,
            include_archived: false,
            due_before: None,
            due_after: None,
            tags: Vec::new(),
            sort_by: SortBy::Position,
            descending: false,
            limit: 100,
            offset: 0,
        }
    }
}

/// Desktop's `TaskListItem`: the task and its direct subtasks' counts.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskListItem {
    pub task: TaskRecord,
    /// Live direct subtasks, archived and completed ones included.
    pub subtask_count: i64,
    /// Those with a `completedAt`.
    pub completed_subtask_count: i64,
}

impl TaskListItem {
    pub fn has_subtasks(&self) -> bool {
        self.subtask_count > 0
    }
}

/// `TaskListResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskPage {
    pub tasks: Vec<TaskListItem>,
    pub total: i64,
    pub has_more: bool,
}

/// One tag across every live task, `getAllTaskTags`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagCount {
    /// The smallest spelling by code unit among the tag's spellings
    /// (SQLite's `min`).
    pub tag: String,
    pub count: i64,
}

/// `tasks:list`.
pub fn page(conn: &Connection, query: &ListQuery) -> Result<TaskPage, StorageError> {
    let mut filter = Filter::default();
    filter.counted(query);
    match &query.status_id {
        Match::Any => {}
        Match::Null => filter.and("t.status_id IS NULL", None),
        Match::Is(id) => filter.and("t.status_id = ?", Some(id.clone())),
    }
    match &query.parent_id {
        Match::Any => {}
        Match::Null => filter.and("t.parent_id IS NULL", None),
        Match::Is(id) => filter.and("t.parent_id = ?", Some(id.clone())),
    }
    if let Some(day) = non_empty(&query.due_before) {
        filter.and("t.due_date <= ?", Some(day));
    }
    if let Some(day) = non_empty(&query.due_after) {
        filter.and("t.due_date >= ?", Some(day));
    }
    let direction = if query.descending { "DESC" } else { "ASC" };
    let order = format!("{} {direction}, t.id", query.sort_by.column());
    let limit = query.limit as usize;
    let offset = query.offset as usize;
    let ids = if query.tags.is_empty() {
        filter.args.push(SqlValue::from(i64::from(query.limit)));
        filter.args.push(SqlValue::from(i64::from(query.offset)));
        ids_where(
            conn,
            &filter.sql,
            filter.args,
            &format!("{order} LIMIT ? OFFSET ?"),
        )?
    } else {
        let wanted: HashSet<String> = query.tags.iter().map(|tag| tags::fold(tag)).collect();
        tagged_where(conn, &filter.sql, filter.args, &order)?
            .into_iter()
            .filter(|(_, folds)| wanted.is_subset(folds))
            .map(|(id, _)| id)
            .skip(offset)
            .take(limit)
            .collect()
    };
    let tasks = items(conn, &ids)?;
    let total = count(conn, query)?;
    let has_more = i64::try_from(offset + tasks.len()).unwrap_or(i64::MAX) < total;
    Ok(TaskPage {
        tasks,
        total,
        has_more,
    })
}

/// `tasks:get`: the live task with its subtask counts, or `None`.
pub fn get(conn: &Connection, id: &str) -> Result<Option<TaskListItem>, StorageError> {
    Ok(items(conn, &[id.to_owned()])?.into_iter().next())
}

/// `tasks:get-subtasks` (`getSubtasks`): every live direct subtask, completed
/// and archived ones included, by position.
pub fn subtasks(conn: &Connection, parent_id: &str) -> Result<Vec<TaskListItem>, StorageError> {
    let ids = ids_where(
        conn,
        "AND t.parent_id = ?",
        vec![SqlValue::from(parent_id.to_owned())],
        "t.position, t.id",
    )?;
    items(conn, &ids)
}

/// `tasks:get-tags` (`getAllTaskTags`): one row per tag fold over every live
/// task, archived and completed ones included, most used first; ties by tag.
pub fn tag_counts(conn: &Connection) -> Result<Vec<TagCount>, StorageError> {
    let mut statement = conn
        .prepare(&format!("SELECT t.tags {LIVE} AND t.tags IS NOT NULL"))
        .map_err(failed)?;
    let rows = statement
        .query_map(params![], |row| row.get::<_, String>(0))
        .map_err(failed)?;
    let mut by_fold: BTreeMap<String, TagCount> = BTreeMap::new();
    for row in rows {
        for tag in tag_list(&row.map_err(failed)?) {
            let entry = by_fold.entry(tags::fold(&tag)).or_insert_with(|| TagCount {
                tag: tag.clone(),
                count: 0,
            });
            entry.count += 1;
            if tag < entry.tag {
                entry.tag = tag;
            }
        }
    }
    let mut counts: Vec<TagCount> = by_fold.into_values().collect();
    counts.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
    Ok(counts)
}

/// The tasks among `ids`, in that order, each with its subtask counts: one
/// query for the rows, one for the counts.
pub(super) fn items(conn: &Connection, ids: &[String]) -> Result<Vec<TaskListItem>, StorageError> {
    let records = task_records::by_ids(conn, ids)?;
    if records.is_empty() {
        return Ok(Vec::new());
    }
    let parents: Vec<&str> = records.iter().map(|task| task.id.as_str()).collect();
    let mut statement = conn
        .prepare(&format!(
            "SELECT t.parent_id, COUNT(*), SUM(t.completed_at IS NOT NULL)
             {LIVE} AND t.parent_id IN (SELECT value FROM json_each(?1))
             GROUP BY t.parent_id"
        ))
        .map_err(failed)?;
    let rows = statement
        .query_map(params![json_list(&parents)?], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, i64>(1)?, row.get::<_, i64>(2)?),
            ))
        })
        .map_err(failed)?;
    let mut counts = HashMap::new();
    for row in rows {
        let (parent, pair) = row.map_err(failed)?;
        counts.insert(parent, pair);
    }
    Ok(records
        .into_iter()
        .map(|task| {
            let (subtask_count, completed_subtask_count) =
                counts.get(&task.id).copied().unwrap_or((0, 0));
            TaskListItem {
                task,
                subtask_count,
                completed_subtask_count,
            }
        })
        .collect())
}

/// Ids of the live tasks that match `filter` (SQL starting with `AND`, or
/// empty), in `order`.
pub(super) fn ids_where(
    conn: &Connection,
    filter: &str,
    args: Vec<SqlValue>,
    order: &str,
) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(&format!("SELECT t.id {LIVE} {filter} ORDER BY {order}"))
        .map_err(failed)?;
    let rows = statement
        .query_map(params_from_iter(args), |row| row.get::<_, String>(0))
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

/// [`ids_where`] with each task's tag folds.
fn tagged_where(
    conn: &Connection,
    filter: &str,
    args: Vec<SqlValue>,
    order: &str,
) -> Result<Vec<(String, HashSet<String>)>, StorageError> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT t.id, t.tags {LIVE} {filter} ORDER BY {order}"
        ))
        .map_err(failed)?;
    let rows = statement
        .query_map(params_from_iter(args), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(failed)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, stored) = row.map_err(failed)?;
        let folds = stored
            .map(|text| tag_list(&text).iter().map(|tag| tags::fold(tag)).collect())
            .unwrap_or_default();
        out.push((id, folds));
    }
    Ok(out)
}

/// `countTasks`: the live tasks matching `projectId`, `includeCompleted` and
/// `includeArchived`, and no other filter of the query.
fn count(conn: &Connection, query: &ListQuery) -> Result<i64, StorageError> {
    let mut filter = Filter::default();
    filter.counted(query);
    conn.query_row(
        &format!("SELECT COUNT(*) {LIVE} {}", filter.sql),
        params_from_iter(filter.args),
        |row| row.get(0),
    )
    .map_err(failed)
}

/// An `AND`-joined SQL filter and its positional arguments.
#[derive(Default)]
struct Filter {
    sql: String,
    args: Vec<SqlValue>,
}

impl Filter {
    fn and(&mut self, clause: &str, arg: Option<String>) {
        self.sql.push_str(" AND ");
        self.sql.push_str(clause);
        if let Some(arg) = arg {
            self.args.push(SqlValue::from(arg));
        }
    }

    /// The filters `countTasks` shares with `listTasks`.
    fn counted(&mut self, query: &ListQuery) {
        if let Some(project_id) = non_empty(&query.project_id) {
            self.and("t.project_id = ?", Some(project_id));
        }
        if !query.include_completed {
            self.and("t.completed_at IS NULL", None);
        }
        if !query.include_archived {
            self.and("t.archived_at IS NULL", None);
        }
    }
}

fn non_empty(value: &Option<String>) -> Option<String> {
    value.clone().filter(|text| !text.is_empty())
}

/// The string entries of a stored `tags` JSON array; anything else is none.
fn tag_list(stored: &str) -> Vec<String> {
    match serde_json::from_str::<Value>(stored) {
        Ok(Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| match item {
                Value::String(tag) => Some(tag),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn json_list(ids: &[&str]) -> Result<String, StorageError> {
    serde_json::to_string(ids).map_err(|error| StorageError::Failed {
        what: format!("task ids will not encode: {error}"),
    })
}
