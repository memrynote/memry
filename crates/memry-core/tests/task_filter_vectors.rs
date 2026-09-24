//! Conformance: task filters, sorts and groups against the committed
//! `task-filtering` vectors (spec 004 TP018), recorded from desktop's
//! `packages/domain-tasks/src/filtering`.
//!
//! Every case of every section is asserted; a section collects all of its
//! mismatches and fails once, listing each case's input, expected and actual
//! value, so one run shows everything that differs.

mod support;

use std::collections::HashMap;

use memry_core::domain::calendar::{CivilDate, LocalDateTime};
use memry_core::domain::task_filter::{
    CompletionFilter, DueDateFilter, FilterProject, FilterStatus, FilterTask, HasTimeFilter,
    Priority, RepeatFilter, SortDirection, SortField, StatusType, TaskFilters, TaskGroup,
    TaskNoteInfo, TaskSort, apply_filters_and_sort, count_active_filters, filter_by_completion,
    filter_by_due_date_range, filter_by_has_time, filter_by_priorities, filter_by_projects,
    filter_by_repeat_type, filter_by_search, filter_by_statuses, filter_by_tags,
    group_tasks_for_sort, has_active_filters, sort_tasks_advanced,
};
use serde_json::{Value, json};
use support::vector_file;

struct Fixture {
    vectors: Value,
    tasks: Vec<FilterTask>,
    projects: Vec<FilterProject>,
    notes: HashMap<String, TaskNoteInfo>,
}

impl Fixture {
    fn load() -> Self {
        let vectors = vector_file("task-filtering");
        let tasks = list(&vectors["tasks"]).iter().map(task).collect();
        let projects = list(&vectors["projects"]).iter().map(project).collect();
        let notes = list(&vectors["notes"])
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
        Self {
            vectors,
            tasks,
            projects,
            notes,
        }
    }

    fn cases(&self, pointer: &str) -> &[Value] {
        list(
            self.vectors
                .pointer(pointer)
                .unwrap_or_else(|| panic!("no section {pointer}")),
        )
    }

    fn refs(&self) -> Vec<&FilterTask> {
        self.tasks.iter().collect()
    }

    /// A `nows` key (`wednesday`) resolved to its instant.
    fn named_now(&self, key: &str) -> LocalDateTime {
        instant(&self.vectors["nows"][key])
    }
}

/// Runs every case of a section and fails once with every mismatch.
fn check_all(section: &str, cases: &[Value], run: impl Fn(&Value) -> (Value, Value)) {
    let mismatches: Vec<String> = cases
        .iter()
        .filter_map(|case| {
            let (expected, actual) = run(case);
            (expected != actual)
                .then(|| format!("  input: {case}\n  expected: {expected}\n  actual:   {actual}"))
        })
        .collect();
    assert!(
        mismatches.is_empty(),
        "{section}: {} of {} cases differ\n{}",
        mismatches.len(),
        cases.len(),
        mismatches.join("\n\n")
    );
}

fn ids(tasks: &[&FilterTask]) -> Value {
    json!(
        tasks
            .iter()
            .map(|task| task.id.as_str())
            .collect::<Vec<_>>()
    )
}

fn strings(value: &Value) -> Vec<String> {
    list(value)
        .iter()
        .map(|item| item.as_str().expect("string item").to_owned())
        .collect()
}

fn list(value: &Value) -> &[Value] {
    value
        .as_array()
        .unwrap_or_else(|| panic!("not an array: {value}"))
}

fn text(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("missing `{key}`: {value}"))
        .to_owned()
}

fn optional_text(value: &Value, key: &str) -> Option<String> {
    value[key].as_str().map(str::to_owned)
}

fn instant(value: &Value) -> LocalDateTime {
    let raw = value.as_str().expect("instant string");
    LocalDateTime::parse(raw).unwrap_or_else(|| panic!("bad instant {raw}"))
}

fn optional_instant(value: &Value) -> Option<LocalDateTime> {
    (!value.is_null()).then(|| instant(value))
}

fn task(value: &Value) -> FilterTask {
    let priority = text(value, "priority");
    FilterTask {
        id: text(value, "id"),
        title: text(value, "title"),
        description: optional_text(value, "description"),
        project_id: text(value, "projectId"),
        status_id: text(value, "statusId"),
        parent_id: optional_text(value, "parentId"),
        priority: Priority::from_name(&priority).expect("known priority"),
        due_date: value["dueDate"].as_str().map(|key| {
            LocalDateTime::at_start_of(CivilDate::parse_key(key).expect("due date key"))
        }),
        due_time: optional_text(value, "dueTime"),
        created_at: instant(&value["createdAt"]),
        completed_at: optional_instant(&value["completedAt"]),
        archived_at: optional_instant(&value["archivedAt"]),
        is_repeating: value["isRepeating"].as_bool().expect("isRepeating"),
        tags: strings(&value["tags"]),
        source_note_id: optional_text(value, "sourceNoteId"),
        linked_note_ids: strings(&value["linkedNoteIds"]),
    }
}

fn project(value: &Value) -> FilterProject {
    FilterProject {
        id: text(value, "id"),
        name: text(value, "name"),
        color: text(value, "color"),
        statuses: list(&value["statuses"])
            .iter()
            .map(|status| FilterStatus {
                id: text(status, "id"),
                status_type: StatusType::from_name(&text(status, "type")).expect("status type"),
                color: text(status, "color"),
                order: status["order"].as_i64().expect("order"),
            })
            .collect(),
    }
}

fn group_json(group: &TaskGroup) -> Value {
    json!({
        "key": group.key,
        "labelKey": group.label_key,
        "name": group.name,
        "color": group.color,
        "variant": group.variant,
        "taskIds": group.task_ids,
    })
}

#[test]
fn dimension_search() {
    let f = Fixture::load();
    check_all("search", f.cases("/dimensions/search"), |case| {
        let query = case["query"].as_str().expect("query");
        (
            case["expected"].clone(),
            ids(&filter_by_search(&f.refs(), query)),
        )
    });
}

#[test]
fn dimension_projects() {
    let f = Fixture::load();
    check_all("projects", f.cases("/dimensions/projects"), |case| {
        let selected = strings(&case["projectIds"]);
        (
            case["expected"].clone(),
            ids(&filter_by_projects(&f.refs(), &selected)),
        )
    });
}

#[test]
fn dimension_priorities() {
    let f = Fixture::load();
    check_all("priorities", f.cases("/dimensions/priorities"), |case| {
        let selected = strings(&case["priorities"]);
        (
            case["expected"].clone(),
            ids(&filter_by_priorities(&f.refs(), &selected)),
        )
    });
}

#[test]
fn dimension_tags() {
    let f = Fixture::load();
    check_all("tags", f.cases("/dimensions/tags"), |case| {
        let selected = strings(&case["tags"]);
        (
            case["expected"].clone(),
            ids(&filter_by_tags(&f.refs(), &selected)),
        )
    });
}

#[test]
fn dimension_statuses() {
    let f = Fixture::load();
    check_all("statuses", f.cases("/dimensions/statuses"), |case| {
        let selected = strings(&case["statusIds"]);
        (
            case["expected"].clone(),
            ids(&filter_by_statuses(&f.refs(), &selected)),
        )
    });
}

#[test]
fn dimension_completion() {
    let f = Fixture::load();
    check_all("completion", f.cases("/dimensions/completion"), |case| {
        let completion = CompletionFilter::from_name(&text(case, "completion"));
        (
            case["expected"].clone(),
            ids(&filter_by_completion(&f.refs(), &completion, &f.projects)),
        )
    });
}

#[test]
fn dimension_repeat_type() {
    let f = Fixture::load();
    check_all("repeatType", f.cases("/dimensions/repeatType"), |case| {
        let repeat = RepeatFilter::from_name(&text(case, "repeatType"));
        (
            case["expected"].clone(),
            ids(&filter_by_repeat_type(&f.refs(), &repeat)),
        )
    });
}

#[test]
fn dimension_has_time() {
    let f = Fixture::load();
    check_all("hasTime", f.cases("/dimensions/hasTime"), |case| {
        let has_time = HasTimeFilter::from_name(&text(case, "hasTime"));
        (
            case["expected"].clone(),
            ids(&filter_by_has_time(&f.refs(), &has_time)),
        )
    });
}

#[test]
fn dimension_due_date() {
    let f = Fixture::load();
    check_all("dueDate", f.cases("/dimensions/dueDate"), |case| {
        let filter = DueDateFilter::from_json(&case["filter"]);
        let week_starts_on = case["weekStartsOn"].as_u64().expect("weekStartsOn");
        let week_starts_on = u32::try_from(week_starts_on).expect("small week start");
        (
            case["expected"].clone(),
            ids(&filter_by_due_date_range(
                &f.refs(),
                &filter,
                instant(&case["now"]),
                week_starts_on,
            )),
        )
    });
}

#[test]
fn sorts() {
    let f = Fixture::load();
    check_all("sorts", f.cases("/sorts"), |case| {
        let sort = TaskSort::from_json(case).expect("sort");
        (
            case["expected"].clone(),
            ids(&sort_tasks_advanced(&f.refs(), &sort, &f.projects)),
        )
    });
}

#[test]
fn groups() {
    let f = Fixture::load();
    let top_level: Vec<&FilterTask> = f
        .tasks
        .iter()
        .filter(|task| task.parent_id.is_none())
        .collect();
    check_all("groups", f.cases("/groups"), |case| {
        let with_notes = case["withNotes"].as_bool().expect("withNotes");
        let groups = group_tasks_for_sort(
            &top_level,
            &SortField::from_name(&text(case, "field")),
            &SortDirection::from_name(&text(case, "direction")),
            &f.projects,
            instant(&case["now"]),
            with_notes.then_some(&f.notes),
        );
        (
            case["expected"].clone(),
            json!(groups.iter().map(group_json).collect::<Vec<_>>()),
        )
    });
}

#[test]
fn applied() {
    let f = Fixture::load();
    check_all("applied", f.cases("/applied"), |case| {
        let filters = TaskFilters::from_json(&case["filters"]);
        let sort = TaskSort::from_json(&case["sort"]).expect("sort");
        let week_starts_on = case["weekStartsOn"].as_u64().expect("weekStartsOn");
        let result = apply_filters_and_sort(
            &f.tasks,
            &filters,
            &sort,
            &f.projects,
            f.named_now(&text(case, "now")),
            u32::try_from(week_starts_on).expect("small week start"),
        );
        let actual = json!({
            "taskIds": ids(&result),
            "hasActiveFilters": has_active_filters(&filters),
            "countActiveFilters": count_active_filters(&filters),
        });
        (case["expected"].clone(), actual)
    });
}

/// A saved filter written by a newer build keeps its unknown values through a
/// read and a write, and a missing field reads as the zod default.
#[test]
fn saved_filter_config_round_trips_unknown_values() {
    let config = json!({
        "filters": {
            "search": "report",
            "projectIds": ["p1"],
            "priorities": ["urgent", "critical"],
            "tags": ["work"],
            "dueDate": {"type": "custom", "customStart": "2026-01-14T21:00:00.000Z", "customEnd": null},
            "statusIds": ["p1-todo"],
            "completion": "snoozed",
            "repeatType": "one-time",
            "hasTime": "with-time"
        },
        "sort": {"field": "energy", "direction": "desc"},
        "starred": true
    });
    let filters = TaskFilters::from_json(&config["filters"]);
    let sort = TaskSort::from_json(&config["sort"]).expect("sort");
    assert_eq!(
        filters.completion,
        CompletionFilter::Other("snoozed".into())
    );
    assert_eq!(sort.field, SortField::Other("energy".into()));
    let written = json!({
        "filters": filters.to_json(),
        "sort": sort.to_json(),
        "starred": config["starred"],
    });
    assert_eq!(written, config);

    let defaults = TaskFilters::from_json(&json!({}));
    assert_eq!(defaults, TaskFilters::default());
    assert!(!has_active_filters(&defaults));
    assert_eq!(
        defaults.to_json(),
        json!({
            "search": "",
            "projectIds": [],
            "priorities": [],
            "tags": [],
            "dueDate": {"type": "any", "customStart": null, "customEnd": null},
            "statusIds": [],
            "completion": "active",
            "repeatType": "all",
            "hasTime": "all"
        })
    );
}
