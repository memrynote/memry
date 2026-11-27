//! `mapRows` (`packages/importers/src/ticktick/map-rows.ts`): TickTick's rows as projects with
//! statuses and tasks with parents, statuses, positions, dates, repeats and reminders.

use std::collections::{HashMap, HashSet};

use jiff::tz::TimeZone;
use memry_core::markdown::frontmatter::{js_trim, number_to_string};

use super::ITEM_COST;
use super::dates::{duration_ms, parse_instant, split_date_time};
use super::order::{OrderKey, key_bytes, order_key};
use super::rrule::rrule_to_repeat;
use crate::import::csv_lex::step;
use crate::import::messages::{ImportMessage, codes};
use crate::import::todoist::json_number;
use crate::import::{Budget, ImportedRepeat, ImportedStatus, StatusKind, WARNING_COST};
use crate::web::extract::utils::date::iso_string;

const INBOX: &str = "Inbox";
/// The `RangeError` `toISOString` threw for a reminder past the Date range, failing the file.
const INVALID_TIME: &str = "Invalid time value";

/// `TickTickRow`, with only the columns `mapRows` reads.
#[derive(Default)]
pub(super) struct Row {
    pub folder: bool,
    pub list: String,
    pub title: String,
    pub tags: Vec<String>,
    pub content: String,
    pub start: String,
    pub due: String,
    pub reminder: String,
    pub repeat: String,
    pub priority: f64,
    pub status: f64,
    pub completed: String,
    pub order: String,
    pub timezone: String,
    pub all_day: bool,
    pub column: String,
    pub column_order: String,
    pub task_id: String,
    pub parent_id: String,
}

pub(super) struct Project {
    pub name: String,
    pub inbox: bool,
    pub statuses: Vec<ImportedStatus>,
    /// Each status's temp id, an index into the plan's statuses.
    pub status_ids: Vec<usize>,
}

pub(super) struct Reminder {
    pub at: String,
    pub ms: f64,
}

/// `TaskPlan`, its temp id its index.
pub(super) struct Task {
    pub project: usize,
    pub parent: Option<usize>,
    pub status: Option<usize>,
    pub title: String,
    pub description: Option<String>,
    pub priority: u8,
    pub position: usize,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub completed_at: Option<String>,
    pub archived: bool,
    pub tags: Vec<String>,
    pub repeat: Option<ImportedRepeat>,
    pub reminders: Vec<Reminder>,
}

pub(super) struct Plan {
    pub projects: Vec<Project>,
    pub tasks: Vec<Task>,
    pub warnings: Vec<ImportMessage>,
    pub subtasks: usize,
    pub reminders: usize,
}

const DEFAULT_STATUSES: [(&str, &str, StatusKind); 3] = [
    ("To Do", "#6b7280", StatusKind::Todo),
    ("In Progress", "#F59E0B", StatusKind::InProgress),
    ("Done", "#10b981", StatusKind::Done),
];

/// `/done|complete/i`, ASCII case-insensitive as a non-Unicode JS regex is.
fn is_done_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("done") || lower.contains("complete")
}

/// `mapPriority`: TickTick's 0, 1, 3 and 5 as Memry's 0 to 3.
fn map_priority(n: f64) -> Option<u8> {
    match n {
        0.0 => Some(0),
        1.0 => Some(1),
        3.0 => Some(2),
        5.0 => Some(3),
        _ => None,
    }
}

/// `mapRows(rows, { now })`. `Err` is the text of the `RangeError` that failed the file.
pub(super) fn map_rows(
    mut rows: Vec<Row>,
    now: &str,
    local: &TimeZone,
    budget: &mut Budget,
) -> Result<Plan, String> {
    let mut warnings = Vec::new();
    let mut warn = |budget: &mut Budget, warning: ImportMessage| -> Result<(), String> {
        budget.charge(WARNING_COST + 2 * warning.message.len())?;
        warnings.push(warning);
        Ok(())
    };

    // 1. Lists in first-seen order (blank is the Inbox).
    let list_name = |row: &Row| match js_trim(&row.list) {
        "" => INBOX.to_owned(),
        list => list.to_owned(),
    };
    let mut lists: Vec<String> = Vec::new();
    let mut list_index: HashMap<String, usize> = HashMap::new();
    let mut row_list = Vec::with_capacity(rows.len());
    let mut rows_of_list: Vec<Vec<usize>> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let name = list_name(row);
        let at = *list_index.entry(name.clone()).or_insert_with(|| {
            lists.push(name);
            rows_of_list.push(Vec::new());
            lists.len() - 1
        });
        rows_of_list[at].push(index);
        row_list.push(at);
    }
    if rows.iter().any(|row| row.folder) {
        warn(
            budget,
            ImportMessage::coded(
                codes::TICKTICK_FOLDERS_DROPPED,
                "TickTick folders have no Memry equivalent and were dropped",
            ),
        )?;
    }

    // 2. Projects and statuses. The `list column` key is Electron's, collisions included.
    let mut projects = Vec::with_capacity(lists.len());
    let mut status_by_column: HashMap<String, usize> = HashMap::new();
    let mut default_status: Vec<Option<(usize, usize)>> = vec![None; lists.len()];
    let mut next_status = 0;
    for (at, list) in lists.iter().enumerate() {
        let mut columns: Vec<(&str, &str)> = Vec::new();
        let mut seen = HashSet::new();
        for row in rows_of_list[at].iter().map(|&index| &rows[index]) {
            step();
            let column = js_trim(&row.column);
            if !column.is_empty() && seen.insert(column) {
                columns.push((column, &row.column_order));
            }
        }
        let mut statuses = Vec::new();
        let mut status_ids = Vec::new();
        if columns.len() >= 2 {
            let mut keyed: Vec<(OrderKey, &str)> = Vec::with_capacity(columns.len());
            for (name, order) in columns {
                let key = order_key(order);
                budget.charge(ITEM_COST + key_bytes(&key))?;
                keyed.push((key, name));
            }
            keyed.sort_by(|a, b| {
                step();
                a.0.cmp(&b.0)
            });
            for (order, (_, name)) in keyed.into_iter().enumerate() {
                let done = is_done_name(name);
                statuses.push(ImportedStatus {
                    name: name.to_owned(),
                    color: if done { "#10b981" } else { "#6b7280" }.to_owned(),
                    kind: match (done, order) {
                        (true, _) => StatusKind::Done,
                        (false, 0) => StatusKind::Todo,
                        (false, _) => StatusKind::InProgress,
                    },
                    order,
                });
                status_by_column.insert(format!("{list} {name}"), next_status);
                status_ids.push(next_status);
                next_status += 1;
            }
        } else {
            for (order, (name, color, kind)) in DEFAULT_STATUSES.into_iter().enumerate() {
                statuses.push(ImportedStatus {
                    name: name.to_owned(),
                    color: color.to_owned(),
                    kind,
                    order,
                });
                status_ids.push(next_status);
                next_status += 1;
            }
            default_status[at] = Some((status_ids[0], status_ids[2]));
        }
        projects.push(Project {
            name: list.clone(),
            inbox: list == INBOX,
            statuses,
            status_ids,
        });
    }

    // 3. taskId to temp id; a later row with the same id wins.
    let mut by_task_id: HashMap<String, usize> = HashMap::new();
    for (at, row) in rows.iter_mut().enumerate() {
        let id = std::mem::take(&mut row.task_id);
        if !js_trim(&id).is_empty() {
            by_task_id.insert(js_trim(&id).to_owned(), at);
        }
    }

    // 4. Tasks.
    let mut tasks = Vec::with_capacity(rows.len());
    let mut orders = Vec::with_capacity(rows.len());
    let (mut subtasks, mut reminder_count) = (0, 0);
    for (at, row) in rows.iter_mut().enumerate() {
        let list = row_list[at];
        let mut parent = None;
        let parent_id = js_trim(&row.parent_id);
        if !parent_id.is_empty() {
            parent = by_task_id.get(parent_id).copied();
            if parent.is_some() {
                subtasks += 1;
            } else {
                let title = &row.title;
                warn(
                    budget,
                    ImportMessage::coded(
                        codes::TICKTICK_SUBTASK_PARENT_MISSING,
                        format!("Subtask \"{title}\" parent not found; imported top-level"),
                    )
                    .with_param("title", title.as_str()),
                )?;
            }
        }

        let column = js_trim(&row.column);
        let completed = row.status == 2.0 || !js_trim(&row.completed).is_empty();
        let status = match status_by_column.get(&format!("{} {column}", lists[list])) {
            Some(&id) if !column.is_empty() => Some(id),
            _ => default_status[list].map(|(todo, done)| if completed { done } else { todo }),
        };

        let priority = map_priority(row.priority).unwrap_or(0);
        if map_priority(row.priority).is_none() {
            warn(
                budget,
                ImportMessage::coded(
                    codes::TICKTICK_UNKNOWN_PRIORITY,
                    format!(
                        "Unknown TickTick priority {} \u{2192} none",
                        number_to_string(row.priority)
                    ),
                )
                .with_param("priority", json_number(row.priority)),
            )?;
        }

        let (due_date, due_time) = split_date_time(&row.due, &row.timezone, row.all_day, local);
        let (start_date, _) = split_date_time(&row.start, &row.timezone, true, local);
        let completed_at = completed.then(|| match js_trim(&row.completed) {
            "" => now.to_owned(),
            at => at.to_owned(),
        });

        let has_repeat = !js_trim(&row.repeat).is_empty();
        let repeat = has_repeat
            .then(|| rrule_to_repeat(&row.repeat, now))
            .flatten();
        if let Some(repeat) = &repeat {
            budget.charge(repeat.days_of_week.as_ref().map_or(0, Vec::len))?;
        } else if has_repeat {
            let rule = &row.repeat;
            warn(
                budget,
                ImportMessage::coded(
                    codes::TICKTICK_UNSUPPORTED_REPEAT,
                    format!("Unsupported repeat rule \"{rule}\" skipped"),
                )
                .with_param("rule", rule.as_str()),
            )?;
        }

        let anchor = match js_trim(&row.due) {
            "" => js_trim(&row.start),
            due => due,
        };
        let mut reminders = Vec::new();
        let tokens = row
            .reminder
            .split(';')
            .map(js_trim)
            .filter(|t| !t.is_empty());
        for token in tokens {
            let Some(offset) = duration_ms(token).filter(|_| !anchor.is_empty()) else {
                warn(
                    budget,
                    ImportMessage::coded(
                        codes::TICKTICK_REMINDER_NO_ANCHOR,
                        format!("Reminder \"{token}\" skipped (no date anchor)"),
                    )
                    .with_param("reminder", token),
                )?;
                continue;
            };
            let ms = parse_instant(anchor, local).map(|anchor| anchor + offset);
            let at = iso_string(ms).map_err(|_| INVALID_TIME.to_owned())?;
            budget.charge(64)?;
            reminders.push(Reminder {
                at,
                ms: ms.expect("iso_string refuses NaN"),
            });
            reminder_count += 1;
        }

        let order = order_key(&row.order);
        budget.charge(key_bytes(&order))?;
        orders.push(order);
        tasks.push(Task {
            project: list,
            parent,
            status,
            title: match std::mem::take(&mut row.title) {
                title if title.is_empty() => "Untitled".to_owned(),
                title => title,
            },
            description: (!js_trim(&row.content).is_empty())
                .then(|| std::mem::take(&mut row.content)),
            priority,
            position: 0,
            start_date,
            due_date,
            due_time,
            completed_at,
            archived: row.status == -1.0,
            tags: std::mem::take(&mut row.tags),
            repeat,
            reminders,
        });
    }

    // 5. Positions: by `Order` within each (project, status), stable.
    let mut groups: HashMap<(usize, Option<usize>), Vec<usize>> = HashMap::new();
    for (at, task) in tasks.iter().enumerate() {
        groups
            .entry((task.project, task.status))
            .or_default()
            .push(at);
    }
    for group in groups.values_mut() {
        group.sort_by(|a, b| {
            step();
            orders[*a].cmp(&orders[*b])
        });
        for (position, at) in group.iter().enumerate() {
            tasks[*at].position = position;
        }
    }

    Ok(Plan {
        projects,
        tasks,
        warnings,
        subtasks,
        reminders: reminder_count,
    })
}
