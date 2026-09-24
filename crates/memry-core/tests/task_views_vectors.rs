//! The `dueWindows` section of the `task-parsing` class (spec 004 D4, TP019).
//!
//! One fixture of projects and tasks, evaluated at two instants, against every
//! due window, the Done sections, every sidebar view, every project arm and the
//! tab badges. The committed JSON is the only input.

mod support;

use std::collections::HashMap;

use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::task_views::{self, DueWindow, Selection, TabCounts, ViewTask};
use serde_json::Value as Json;
use support::vector_file;

fn text(value: &Json) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn instant(value: &Json) -> Option<LocalDateTime> {
    value
        .as_str()
        .map(|text| LocalDateTime::parse(text).unwrap_or_else(|| panic!("instant `{text}`")))
}

fn fixture(section: &Json) -> Vec<ViewTask> {
    let mut status_types: HashMap<(String, String), String> = HashMap::new();
    for project in section["projects"].as_array().expect("projects") {
        let project_id = project["id"].as_str().expect("project id");
        for status in project["statuses"].as_array().expect("statuses") {
            status_types.insert(
                (
                    project_id.to_owned(),
                    status["id"].as_str().expect("status id").to_owned(),
                ),
                status["type"].as_str().expect("status type").to_owned(),
            );
        }
    }
    section["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .enumerate()
        .map(|(position, task)| {
            let project_id = task["projectId"].as_str().expect("projectId").to_owned();
            let status_id = text(&task["statusId"]);
            let done = status_id.as_ref().is_some_and(|status| {
                status_types
                    .get(&(project_id.clone(), status.clone()))
                    .is_some_and(|kind| kind == "done")
            });
            ViewTask {
                id: task["id"].as_str().expect("id").to_owned(),
                project_id,
                status_id,
                parent_id: text(&task["parentId"]),
                position: i64::try_from(position).expect("small"),
                due: task_views::stored_date(task["dueDate"].as_str()),
                start: task_views::stored_date(task["startDate"].as_str()),
                completed_at: instant(&task["completedAt"]),
                archived_at: instant(&task["archivedAt"]),
                done,
            }
        })
        .collect()
}

fn ids(list: Vec<&ViewTask>) -> Vec<String> {
    list.iter().map(|task| task.id.clone()).collect()
}

fn expected_ids(value: &Json) -> Vec<String> {
    value
        .as_array()
        .expect("an id list")
        .iter()
        .map(|id| id.as_str().expect("id").to_owned())
        .collect()
}

fn window(name: &str) -> DueWindow {
    match name {
        "today" => DueWindow::Today,
        "tomorrow" => DueWindow::Tomorrow,
        "next7" => DueWindow::Next7,
        other => panic!("unknown window {other}"),
    }
}

fn counts(value: &Json) -> TabCounts {
    let n = |key: &str| u32::try_from(value[key].as_u64().expect("count")).expect("small");
    TabCounts {
        all: n("all"),
        archived: n("archived"),
        today: n("today"),
        tomorrow: n("tomorrow"),
        next7: n("next7"),
    }
}

#[test]
fn due_windows_views_and_counts_match_the_committed_vectors() {
    let file = vector_file("task-parsing");
    let section = &file["dueWindows"];
    let tasks = fixture(section);
    let mut failures = Vec::new();
    let mut checked = 0;

    for at in section["at"].as_array().expect("at") {
        let now = instant(&at["now"]).expect("now");
        let label = at["now"].as_str().unwrap_or_default();
        let mut check = |what: String, actual: Vec<String>, expected: Vec<String>| {
            checked += 1;
            if actual != expected {
                failures.push(format!(
                    "{label} {what}: expected {expected:?}, got {actual:?}"
                ));
            }
        };

        for (name, expected) in at["windows"].as_object().expect("windows") {
            check(
                format!("window {name}"),
                ids(task_views::in_due_window(&tasks, window(name), now)),
                expected_ids(expected),
            );
        }
        for (name, expected) in at["completedInWindow"].as_object().expect("completed") {
            check(
                format!("completedInWindow {name}"),
                ids(task_views::completed_in_due_window(
                    &tasks,
                    window(name),
                    now,
                )),
                expected_ids(expected),
            );
        }
        check(
            "completedToday".into(),
            ids(task_views::completed_today(&tasks, now)),
            expected_ids(&at["completedToday"]),
        );
        check(
            "completedAll".into(),
            ids(task_views::completed_all(&tasks)),
            expected_ids(&at["completedAll"]),
        );
        for (view, expected) in at["views"].as_object().expect("views") {
            check(
                format!("view {view}"),
                ids(task_views::filtered(
                    &tasks,
                    &Selection::View(view.clone()),
                    now,
                )),
                expected_ids(expected),
            );
        }
        for (project, expected) in at["projects"].as_object().expect("projects") {
            check(
                format!("project {project}"),
                ids(task_views::filtered(
                    &tasks,
                    &Selection::Project(project.clone()),
                    now,
                )),
                expected_ids(expected),
            );
        }
        for (scope, expected) in at["tabCounts"].as_object().expect("tabCounts") {
            checked += 1;
            let scope_id = (scope != "*").then_some(scope.as_str());
            let actual = task_views::tab_counts(&tasks, scope_id, now);
            if actual != counts(expected) {
                failures.push(format!(
                    "{label} tabCounts {scope}: expected {expected}, got {actual:?}"
                ));
            }
        }
    }

    assert!(checked > 40, "the section drove {checked} checks");
    assert!(
        failures.is_empty(),
        "{} of {checked} due-window checks failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
