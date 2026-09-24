//! Task list grouping (`packages/domain-tasks/src/filtering/grouping.ts`).
//!
//! A fixed group carries a **label key** (`dueDate.overdue`, `status.todo`, …)
//! rather than display text, so each surface localizes it; a group named by
//! user data (a project, a folder, a note) carries that `name`. Tasks keep
//! their input order inside a group; the caller sorts first.

use std::collections::HashMap;

use super::collation::locale_compare;
use super::config::{SortDirection, SortField};
use super::{FilterProject, FilterTask, Priority, StatusType, TaskNoteInfo};
use crate::domain::calendar::LocalDateTime;

/// One group of the task list, as desktop's `TaskGroup` with task ids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskGroup {
    pub key: String,
    /// Stable key for a fixed label; `None` when `name` is the label.
    pub label_key: Option<String>,
    /// User data naming the group (project name, folder path, note title).
    pub name: Option<String>,
    pub color: Option<String>,
    /// `overdue` for the overdue due-date group, else `None`.
    pub variant: Option<String>,
    pub task_ids: Vec<String>,
}

impl TaskGroup {
    fn fixed(key: &str, label_key: String, tasks: &[&FilterTask], color: Option<&str>) -> Self {
        Self {
            key: key.to_owned(),
            label_key: Some(label_key),
            name: None,
            color: color.map(str::to_owned),
            variant: None,
            task_ids: ids(tasks),
        }
    }

    fn named(key: String, name: String, tasks: &[&FilterTask], color: Option<&str>) -> Self {
        Self {
            key,
            label_key: None,
            name: Some(name),
            color: color.map(str::to_owned),
            variant: None,
            task_ids: ids(tasks),
        }
    }
}

/// `groupTasksForSort`: the groups for a sort field, reversed for `desc`.
///
/// `title`, `completedAt` and an unknown field have no groups. `folder` and
/// `note` need the note index (keyed by note id); without it (the notes list is
/// still loading) they have none, and the caller renders the flat list.
pub fn group_tasks_for_sort(
    tasks: &[&FilterTask],
    field: &SortField,
    direction: &SortDirection,
    projects: &[FilterProject],
    now: LocalDateTime,
    note_index: Option<&HashMap<String, TaskNoteInfo>>,
) -> Vec<TaskGroup> {
    let mut groups = match (field, note_index) {
        (SortField::DueDate, _) => group_by_due_date(tasks, now),
        (SortField::Priority, _) => group_by_priority(tasks),
        (SortField::Status, _) => group_by_status(tasks, projects),
        (SortField::Project, _) => group_by_project(tasks, projects),
        (SortField::CreatedAt, _) => group_by_created_date(tasks, now),
        (SortField::Folder, Some(index)) => group_by_folder(tasks, index),
        (SortField::Note, Some(index)) => group_by_note(tasks, index),
        _ => return Vec::new(),
    };
    if *direction == SortDirection::Desc {
        groups.reverse();
    }
    groups
}

/// `getTaskNoteId`: `sourceNoteId`, else the first linked note, else none.
pub fn task_note_id(task: &FilterTask) -> Option<&str> {
    task.source_note_id
        .as_deref()
        .or_else(|| task.linked_note_ids.first().map(String::as_str))
}

/// Due-date buckets relative to today: `(key, color, variant)`.
const DUE_DATE_GROUPS: [(&str, Option<&str>, Option<&str>); 6] = [
    ("overdue", Some("#ef4444"), Some("overdue")),
    ("today", Some("#E5993E"), None),
    ("tomorrow", Some("#3B82F6"), None),
    ("upcoming", Some("#50505A"), None),
    ("later", None, None),
    ("noDueDate", Some("#50505A"), None),
];

fn group_by_due_date(tasks: &[&FilterTask], now: LocalDateTime) -> Vec<TaskGroup> {
    let today = now.date().days_since_epoch();
    let mut buckets: [Vec<&FilterTask>; 6] = Default::default();
    for &task in tasks {
        let bucket = match task.due_date {
            None => 5,
            Some(due) => match due.date().days_since_epoch() - today {
                ..0 => 0,
                0 => 1,
                1 => 2,
                2..=7 => 3,
                _ => 4,
            },
        };
        buckets[bucket].push(task);
    }
    DUE_DATE_GROUPS
        .iter()
        .zip(buckets)
        .filter(|(_, bucket)| !bucket.is_empty())
        .map(|((key, color, variant), bucket)| TaskGroup {
            variant: variant.map(str::to_owned),
            ..TaskGroup::fixed(key, format!("dueDate.{key}"), &bucket, *color)
        })
        .collect()
}

/// Group order and desktop's `priorityConfig[priority].color`.
const PRIORITY_GROUPS: [(Priority, &str); 5] = [
    (Priority::Urgent, "var(--task-priority-urgent)"),
    (Priority::High, "var(--task-priority-high)"),
    (Priority::Medium, "var(--task-priority-medium)"),
    (Priority::Low, "var(--task-priority-low)"),
    (Priority::None, "var(--task-priority-none)"),
];

fn group_by_priority(tasks: &[&FilterTask]) -> Vec<TaskGroup> {
    PRIORITY_GROUPS
        .iter()
        .filter_map(|&(priority, color)| {
            let bucket: Vec<&FilterTask> = tasks
                .iter()
                .copied()
                .filter(|task| task.priority == priority)
                .collect();
            let name = priority.name();
            (!bucket.is_empty())
                .then(|| TaskGroup::fixed(name, format!("priority.{name}"), &bucket, Some(color)))
        })
        .collect()
}

/// Projects in first-seen order sorted by name; tasks of an empty or unknown
/// project last, under `no-project`.
fn group_by_project(tasks: &[&FilterTask], projects: &[FilterProject]) -> Vec<TaskGroup> {
    // `new Map(projects.map(...))`: a repeated id resolves to the last one.
    let by_id: HashMap<&str, &FilterProject> = projects
        .iter()
        .map(|project| (project.id.as_str(), project))
        .collect();
    let mut buckets: Vec<(&FilterProject, Vec<&FilterTask>)> = Vec::new();
    let mut no_project = Vec::new();
    for &task in tasks {
        if let Some((_, bucket)) = buckets
            .iter_mut()
            .find(|(project, _)| project.id == task.project_id)
        {
            bucket.push(task);
        } else if let Some(project) = by_id
            .get(task.project_id.as_str())
            .filter(|_| !task.project_id.is_empty())
        {
            buckets.push((project, vec![task]));
        } else {
            no_project.push(task);
        }
    }
    buckets.sort_by(|(a, _), (b, _)| locale_compare(&a.name, &b.name));
    let mut groups: Vec<TaskGroup> = buckets
        .into_iter()
        .map(|(project, bucket)| {
            TaskGroup::named(
                project.id.clone(),
                project.name.clone(),
                &bucket,
                Some(&project.color),
            )
        })
        .collect();
    if !no_project.is_empty() {
        groups.push(TaskGroup::fixed(
            "no-project",
            "project.none".to_owned(),
            &no_project,
            None,
        ));
    }
    groups
}

const CREATED_DATE_GROUPS: [(&str, &str); 4] = [
    ("today", "#E5993E"),
    ("yesterday", "#3B82F6"),
    ("thisWeek", "#50505A"),
    ("earlier", "#6b7280"),
];

fn group_by_created_date(tasks: &[&FilterTask], now: LocalDateTime) -> Vec<TaskGroup> {
    let today = now.date().days_since_epoch();
    let mut buckets: [Vec<&FilterTask>; 4] = Default::default();
    for &task in tasks {
        let bucket = match today - task.created_at.date().days_since_epoch() {
            ..=0 => 0,
            1 => 1,
            2..=7 => 2,
            _ => 3,
        };
        buckets[bucket].push(task);
    }
    CREATED_DATE_GROUPS
        .iter()
        .zip(buckets)
        .filter(|(_, bucket)| !bucket.is_empty())
        .map(|((key, color), bucket)| {
            TaskGroup::fixed(key, format!("createdAt.{key}"), &bucket, Some(color))
        })
        .collect()
}

/// `todo` then `in_progress` (done tasks are left out), colored by the first
/// status of that type; tasks whose status resolves in no project last.
fn group_by_status(tasks: &[&FilterTask], projects: &[FilterProject]) -> Vec<TaskGroup> {
    // A status id seen in several projects resolves to the first.
    let mut lookup: HashMap<&str, (StatusType, &str)> = HashMap::new();
    let mut type_colors: Vec<(StatusType, &str)> = Vec::new();
    for status in projects.iter().flat_map(|project| &project.statuses) {
        if lookup.contains_key(status.id.as_str()) {
            continue;
        }
        lookup.insert(&status.id, (status.status_type, &status.color));
        if !type_colors
            .iter()
            .any(|(kind, _)| *kind == status.status_type)
        {
            type_colors.push((status.status_type, &status.color));
        }
    }

    let mut todo = Vec::new();
    let mut in_progress = Vec::new();
    let mut uncategorized = Vec::new();
    for &task in tasks {
        match lookup.get(task.status_id.as_str()) {
            None => uncategorized.push(task),
            Some((StatusType::Todo, _)) => todo.push(task),
            Some((StatusType::InProgress, _)) => in_progress.push(task),
            Some((StatusType::Done, _)) => {}
        }
    }

    let color_of = |kind: StatusType| {
        type_colors
            .iter()
            .find(|(listed, _)| *listed == kind)
            .map(|(_, color)| *color)
    };
    let mut groups = Vec::new();
    for (kind, bucket) in [
        (StatusType::Todo, todo),
        (StatusType::InProgress, in_progress),
    ] {
        if !bucket.is_empty() {
            let name = kind.name();
            groups.push(TaskGroup::fixed(
                name,
                format!("status.{name}"),
                &bucket,
                color_of(kind),
            ));
        }
    }
    if !uncategorized.is_empty() {
        groups.push(TaskGroup::fixed(
            "uncategorized",
            "status.uncategorized".to_owned(),
            &uncategorized,
            None,
        ));
    }
    groups
}

/// Group keys are namespaced because the collapsed-group set is stored per tab
/// and shared by every grouping mode: a folder named `done` must not open
/// collapsed because `done` is a default-collapsed key.
const FOLDER_GROUP_PREFIX: &str = "folder-";
const NOTE_GROUP_PREFIX: &str = "note-";
const ROOT_FOLDER_GROUP_KEY: &str = "folder-vault-root";
const NO_NOTE_GROUP_KEY: &str = "no-source-note";

struct NoteBucket<'a> {
    note: &'a TaskNoteInfo,
    tasks: Vec<&'a FilterTask>,
}

/// Tasks by their resolved note, in first-seen order, and the unfiled rest.
fn bucket_tasks_by_note<'a>(
    tasks: &[&'a FilterTask],
    note_index: &'a HashMap<String, TaskNoteInfo>,
) -> (Vec<NoteBucket<'a>>, Vec<&'a FilterTask>) {
    let mut by_note: Vec<NoteBucket<'a>> = Vec::new();
    let mut unfiled = Vec::new();
    for &task in tasks {
        // An empty id is falsy in the TypeScript and resolves to no note.
        let note = task_note_id(task)
            .filter(|id| !id.is_empty())
            .and_then(|id| note_index.get(id));
        let Some(note) = note else {
            unfiled.push(task);
            continue;
        };
        match by_note.iter_mut().find(|bucket| bucket.note.id == note.id) {
            Some(bucket) => bucket.tasks.push(task),
            None => by_note.push(NoteBucket {
                note,
                tasks: vec![task],
            }),
        }
    }
    (by_note, unfiled)
}

fn group_by_folder(
    tasks: &[&FilterTask],
    note_index: &HashMap<String, TaskNoteInfo>,
) -> Vec<TaskGroup> {
    let (by_note, unfiled) = bucket_tasks_by_note(tasks, note_index);
    let mut by_folder: Vec<(&str, Vec<&FilterTask>)> = Vec::new();
    for bucket in by_note {
        let path = bucket.note.folder_path.as_str();
        match by_folder.iter_mut().find(|(listed, _)| *listed == path) {
            Some((_, folder_tasks)) => folder_tasks.extend(bucket.tasks),
            None => by_folder.push((path, bucket.tasks)),
        }
    }
    let root = by_folder
        .iter()
        .position(|(path, _)| path.is_empty())
        .map(|index| by_folder.remove(index).1);
    by_folder.sort_by(|(a, _), (b, _)| locale_compare(a, b));

    let mut groups: Vec<TaskGroup> = by_folder
        .into_iter()
        .map(|(path, folder_tasks)| {
            TaskGroup::named(
                format!("{FOLDER_GROUP_PREFIX}{path}"),
                path.split('/').collect::<Vec<_>>().join(" / "),
                &folder_tasks,
                None,
            )
        })
        .collect();
    if let Some(root_tasks) = root.filter(|root_tasks| !root_tasks.is_empty()) {
        groups.push(TaskGroup::fixed(
            ROOT_FOLDER_GROUP_KEY,
            "folder.vaultRoot".to_owned(),
            &root_tasks,
            None,
        ));
    }
    push_unfiled(&mut groups, &unfiled);
    groups
}

fn group_by_note(
    tasks: &[&FilterTask],
    note_index: &HashMap<String, TaskNoteInfo>,
) -> Vec<TaskGroup> {
    let (mut by_note, unfiled) = bucket_tasks_by_note(tasks, note_index);
    by_note.sort_by(|a, b| {
        locale_compare(&a.note.folder_path, &b.note.folder_path)
            .then_with(|| locale_compare(&a.note.title, &b.note.title))
    });
    let mut groups: Vec<TaskGroup> = by_note
        .into_iter()
        .map(|bucket| {
            TaskGroup::named(
                format!("{NOTE_GROUP_PREFIX}{}", bucket.note.id),
                bucket.note.title.clone(),
                &bucket.tasks,
                None,
            )
        })
        .collect();
    push_unfiled(&mut groups, &unfiled);
    groups
}

fn push_unfiled(groups: &mut Vec<TaskGroup>, unfiled: &[&FilterTask]) {
    if !unfiled.is_empty() {
        groups.push(TaskGroup::fixed(
            NO_NOTE_GROUP_KEY,
            "note.none".to_owned(),
            unfiled,
            None,
        ));
    }
}

fn ids(tasks: &[&FilterTask]) -> Vec<String> {
    tasks.iter().map(|task| task.id.clone()).collect()
}
