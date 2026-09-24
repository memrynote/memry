//! The conformance seam for the task classes (spec 004 TP080).
//!
//! `task-parsing` and `task-filtering` pin logic that the shell reaches through
//! an opened vault (`Tasks.view`, `Tasks.parseQuickAdd`). Their fixtures carry
//! rows no FFI write can mint — a status id that resolves nowhere, a task in a
//! project that does not exist, fixed `createdAt` instants — so, as
//! [`crate::api::conformance`] does for note blocks, these functions take a
//! vector's own JSON and run it through the **same** production functions the
//! vault path calls, answering JSON the Swift harness compares with the file.
//!
//! **Reads only.** No database, no vault, no clock.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::domain::calendar::{CivilDate, LocalDateTime};
use crate::domain::task_filter::{
    self, CompletionFilter, DueDateFilter, FilterProject, FilterStatus, FilterTask, HasTimeFilter,
    Priority, RepeatFilter, SortDirection, SortField, StatusType, TaskFilters, TaskNoteInfo,
    TaskSort,
};
use crate::domain::task_views::{self, DueWindow, Selection, ViewTask};

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

fn optional(value: &Value, key: &str) -> Option<String> {
    value[key].as_str().map(str::to_owned)
}

fn instant(value: &Value) -> Option<LocalDateTime> {
    value.as_str().and_then(LocalDateTime::parse)
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn parse(json: &str) -> Value {
    serde_json::from_str(json).unwrap_or(Value::Null)
}

/// The `dueWindows` section of `task-parsing.json` evaluated at every `at`
/// entry's `now`, in the file's own shape.
#[uniffi::export]
pub fn task_due_windows_conformance(section_json: String) -> String {
    let section = parse(&section_json);
    let mut types: HashMap<(String, String), String> = HashMap::new();
    for project in array(&section["projects"]) {
        for status in array(&project["statuses"]) {
            types.insert(
                (text(project, "id"), text(status, "id")),
                text(status, "type"),
            );
        }
    }
    let tasks: Vec<ViewTask> = array(&section["tasks"])
        .iter()
        .enumerate()
        .map(|(position, task)| {
            let project_id = text(task, "projectId");
            let status_id = optional(task, "statusId");
            let done = status_id.as_ref().is_some_and(|status| {
                types
                    .get(&(project_id.clone(), status.clone()))
                    .map(String::as_str)
                    == Some("done")
            });
            ViewTask {
                id: text(task, "id"),
                project_id,
                status_id,
                parent_id: optional(task, "parentId"),
                position: i64::try_from(position).unwrap_or(0),
                due: task_views::stored_date(task["dueDate"].as_str()),
                start: task_views::stored_date(task["startDate"].as_str()),
                completed_at: instant(&task["completedAt"]),
                archived_at: instant(&task["archivedAt"]),
                done,
            }
        })
        .collect();
    let ids = |list: Vec<&ViewTask>| json!(list.iter().map(|t| t.id.as_str()).collect::<Vec<_>>());
    let windows = [
        ("today", DueWindow::Today),
        ("tomorrow", DueWindow::Tomorrow),
        ("next7", DueWindow::Next7),
    ];

    let at: Vec<Value> = array(&section["at"])
        .iter()
        .filter_map(|entry| {
            let now = instant(&entry["now"])?;
            let window_map: serde_json::Map<String, Value> = windows
                .iter()
                .map(|(name, window)| {
                    (
                        (*name).to_owned(),
                        ids(task_views::in_due_window(&tasks, *window, now)),
                    )
                })
                .collect();
            let done_map: serde_json::Map<String, Value> = windows
                .iter()
                .map(|(name, window)| {
                    (
                        (*name).to_owned(),
                        ids(task_views::completed_in_due_window(&tasks, *window, now)),
                    )
                })
                .collect();
            let views: serde_json::Map<String, Value> = entry["views"]
                .as_object()
                .map(|views| {
                    views
                        .keys()
                        .map(|view| {
                            let selection = Selection::View(view.clone());
                            (
                                view.clone(),
                                ids(task_views::filtered(&tasks, &selection, now)),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let projects: serde_json::Map<String, Value> = entry["projects"]
                .as_object()
                .map(|projects| {
                    projects
                        .keys()
                        .map(|project| {
                            let selection = Selection::Project(project.clone());
                            (
                                project.clone(),
                                ids(task_views::filtered(&tasks, &selection, now)),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let counts: serde_json::Map<String, Value> = entry["tabCounts"]
                .as_object()
                .map(|scopes| {
                    scopes
                        .keys()
                        .map(|scope| {
                            let scope_id = (scope != "*").then_some(scope.as_str());
                            let counts = task_views::tab_counts(&tasks, scope_id, now);
                            (
                                scope.clone(),
                                json!({"all": counts.all, "archived": counts.archived,
                                       "today": counts.today, "tomorrow": counts.tomorrow,
                                       "next7": counts.next7}),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(json!({
                "now": entry["now"],
                "windows": window_map,
                "completedInWindow": done_map,
                "completedToday": ids(task_views::completed_today(&tasks, now)),
                "completedAll": ids(task_views::completed_all(&tasks)),
                "views": views,
                "projects": projects,
                "tabCounts": counts,
            }))
        })
        .collect();
    Value::Array(at).to_string()
}

fn filter_task(value: &Value) -> FilterTask {
    FilterTask {
        id: text(value, "id"),
        title: text(value, "title"),
        description: optional(value, "description"),
        project_id: text(value, "projectId"),
        status_id: text(value, "statusId"),
        parent_id: optional(value, "parentId"),
        priority: Priority::from_name(&text(value, "priority")).unwrap_or(Priority::None),
        due_date: value["dueDate"]
            .as_str()
            .and_then(CivilDate::parse_key)
            .map(LocalDateTime::at_start_of),
        due_time: optional(value, "dueTime"),
        created_at: instant(&value["createdAt"]).unwrap_or(LocalDateTime::from_ms(0)),
        completed_at: instant(&value["completedAt"]),
        archived_at: instant(&value["archivedAt"]),
        is_repeating: value["isRepeating"].as_bool().unwrap_or(false),
        tags: strings(&value["tags"]),
        source_note_id: optional(value, "sourceNoteId"),
        linked_note_ids: strings(&value["linkedNoteIds"]),
    }
}

fn filter_project(value: &Value) -> FilterProject {
    FilterProject {
        id: text(value, "id"),
        name: text(value, "name"),
        color: text(value, "color"),
        statuses: array(&value["statuses"])
            .iter()
            .map(|status| FilterStatus {
                id: text(status, "id"),
                status_type: StatusType::from_name(&text(status, "type"))
                    .unwrap_or(StatusType::InProgress),
                color: text(status, "color"),
                order: status["order"].as_i64().unwrap_or(0),
            })
            .collect(),
    }
}

/// Every section of `task-filtering.json` recomputed: `{dimensions, sorts,
/// groups, applied}` in the file's own shape (each case's `expected`).
#[uniffi::export]
pub fn task_filtering_conformance(file_json: String) -> String {
    let file = parse(&file_json);
    let tasks: Vec<FilterTask> = array(&file["tasks"]).iter().map(filter_task).collect();
    let refs: Vec<&FilterTask> = tasks.iter().collect();
    let projects: Vec<FilterProject> = array(&file["projects"])
        .iter()
        .map(filter_project)
        .collect();
    let notes: HashMap<String, TaskNoteInfo> = array(&file["notes"])
        .iter()
        .map(|note| {
            let info = TaskNoteInfo {
                id: text(note, "id"),
                title: text(note, "title"),
                folder_path: text(note, "folderPath"),
            };
            (info.id.clone(), info)
        })
        .collect();
    let ids = |list: &[&FilterTask]| json!(list.iter().map(|t| t.id.as_str()).collect::<Vec<_>>());
    let dimension = |name: &str, run: &dyn Fn(&Value) -> Value| -> Value {
        Value::Array(array(&file["dimensions"][name]).iter().map(run).collect())
    };

    let dimensions = json!({
        "search": dimension("search", &|c| ids(&task_filter::filter_by_search(&refs, c["query"].as_str().unwrap_or_default()))),
        "projects": dimension("projects", &|c| ids(&task_filter::filter_by_projects(&refs, &strings(&c["projectIds"])))),
        "priorities": dimension("priorities", &|c| ids(&task_filter::filter_by_priorities(&refs, &strings(&c["priorities"])))),
        "tags": dimension("tags", &|c| ids(&task_filter::filter_by_tags(&refs, &strings(&c["tags"])))),
        "statuses": dimension("statuses", &|c| ids(&task_filter::filter_by_statuses(&refs, &strings(&c["statusIds"])))),
        "completion": dimension("completion", &|c| ids(&task_filter::filter_by_completion(&refs, &CompletionFilter::from_name(&text(c, "completion")), &projects))),
        "repeatType": dimension("repeatType", &|c| ids(&task_filter::filter_by_repeat_type(&refs, &RepeatFilter::from_name(&text(c, "repeatType"))))),
        "hasTime": dimension("hasTime", &|c| ids(&task_filter::filter_by_has_time(&refs, &HasTimeFilter::from_name(&text(c, "hasTime"))))),
        "dueDate": dimension("dueDate", &|c| {
            let now = instant(&c["now"]).unwrap_or(LocalDateTime::from_ms(0));
            let week = u32::try_from(c["weekStartsOn"].as_u64().unwrap_or(1)).unwrap_or(1);
            ids(&task_filter::filter_by_due_date_range(&refs, &DueDateFilter::from_json(&c["filter"]), now, week))
        }),
    });
    let sorts: Vec<Value> = array(&file["sorts"])
        .iter()
        .map(|c| {
            let sort = TaskSort {
                field: SortField::from_name(&text(c, "field")),
                direction: SortDirection::from_name(&text(c, "direction")),
            };
            ids(&task_filter::sort_tasks_advanced(&refs, &sort, &projects))
        })
        .collect();
    let top: Vec<&FilterTask> = tasks.iter().filter(|t| t.parent_id.is_none()).collect();
    let groups: Vec<Value> = array(&file["groups"])
        .iter()
        .map(|c| {
            let now = instant(&c["now"]).unwrap_or(LocalDateTime::from_ms(0));
            let with_notes = c["withNotes"].as_bool().unwrap_or(false);
            let result = task_filter::group_tasks_for_sort(
                &top,
                &SortField::from_name(&text(c, "field")),
                &SortDirection::from_name(&text(c, "direction")),
                &projects,
                now,
                with_notes.then_some(&notes),
            );
            Value::Array(
                result
                    .into_iter()
                    .map(|group| {
                        json!({"key": group.key, "labelKey": group.label_key, "name": group.name,
                               "color": group.color, "variant": group.variant, "taskIds": group.task_ids})
                    })
                    .collect(),
            )
        })
        .collect();
    let applied: Vec<Value> = array(&file["applied"])
        .iter()
        .map(|c| {
            let filters = TaskFilters::from_json(&c["filters"]);
            let sort = TaskSort::from_json(&c["sort"]).unwrap_or(TaskSort {
                field: SortField::DueDate,
                direction: SortDirection::Asc,
            });
            let now = instant(&file["nows"][text(c, "now")]).unwrap_or(LocalDateTime::from_ms(0));
            let week = u32::try_from(c["weekStartsOn"].as_u64().unwrap_or(1)).unwrap_or(1);
            let result =
                task_filter::apply_filters_and_sort(&tasks, &filters, &sort, &projects, now, week);
            json!({
                "taskIds": ids(&result),
                "hasActiveFilters": task_filter::has_active_filters(&filters),
                "countActiveFilters": task_filter::count_active_filters(&filters),
            })
        })
        .collect();
    json!({"dimensions": dimensions, "sorts": sorts, "groups": groups, "applied": applied})
        .to_string()
}
