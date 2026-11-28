//! Desktop's task reads (`apps/desktop/src/main/database/queries/tasks.ts`,
//! `packages/domain-tasks/src/queries.ts`) against a real SQLite file seeded
//! through the real write path. "Today" is 2026-04-16.
//!
//! | Test                                                  | Desktop reference                   |
//! | ----------------------------------------------------- | ----------------------------------- |
//! | defaults hide completed and archived, count subtasks  | `listTasks`, `enrichTask`           |
//! | filters; total counts project and state only          | `listTasks`, `countTasks`           |
//! | tags match every tag by fold                          | `listTasks` tag branch, `foldTag`   |
//! | sorts, nulls first ascending, ties by id              | `listTasks` `sortBy`/`sortOrder`    |
//! | get and subtasks carry every task field               | `getTask`, `getSubtasks`            |
//! | tag counts group by fold                              | `getAllTaskTags`                    |
//! | stats, today, upcoming, overdue                       | `getTaskStats`, `get*Tasks`         |

use memry_core::domain::calendar::{CivilDate, LocalDateTime};
use memry_core::domain::tasks::list::{self, ListQuery, Match, SortBy, TagCount, TaskListItem};
use memry_core::domain::tasks::stats::{self, TaskStats};
use memry_core::domain::tasks::{self, NewTask, Patch, TaskDetails, TaskPatch};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Map, Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-domain-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn today() -> CivilDate {
    CivilDate::new(2026, 4, 16).expect("a date")
}

/// A project with desktop's three default statuses.
fn seed_project(conn: &Connection, id: &str) {
    let payload = json!({
        "name": id,
        "color": "#0ea5e9",
        "statuses": [
            {"id": format!("{id}-todo"), "name": "To Do", "color": "#6b7280", "position": 0, "isDefault": true},
            {"id": format!("{id}-doing"), "name": "In Progress", "color": "#F59E0B", "position": 1},
            {"id": format!("{id}-done"), "name": "Done", "color": "#22c55e", "position": 2, "isDone": true}
        ],
        "clock": {"device-b": 1}
    });
    let outcome = sync_items::apply_remote(
        conn,
        &InboundRecord {
            item_type: "project".to_owned(),
            item_id: id.to_owned(),
            payload_json: payload.to_string(),
            server_cursor: None,
            signer_device_id: None,
            updated_at: NOW,
            deleted_at: None,
        },
        NOW,
    )
    .expect("apply");
    assert_eq!(outcome, sync_items::ApplyOutcome::Applied);
}

struct Seed<'a> {
    id: &'a str,
    project: &'a str,
    due: Option<&'a str>,
    time: Option<&'a str>,
    priority: i64,
    tags: &'a [&'a str],
    parent: Option<&'a str>,
    status: Option<&'a str>,
}

const BASE: Seed<'static> = Seed {
    id: "",
    project: "pa",
    due: None,
    time: None,
    priority: 0,
    tags: &[],
    parent: None,
    status: None,
};

fn add(conn: &Connection, seed: Seed<'_>, created_ms: i64) {
    let tags: Vec<String> = seed.tags.iter().map(|tag| (*tag).to_owned()).collect();
    tasks::create_detailed(
        conn,
        &NewTask {
            id: seed.id,
            title: seed.id,
            project_id: seed.project,
            due_date: seed.due,
            due_time: seed.time,
            priority: seed.priority,
            repeat_config: None,
            tags: &tags,
        },
        &TaskDetails {
            parent_id: seed.parent,
            status_id: seed.status,
            ..TaskDetails::default()
        },
        DEVICE,
        created_ms,
    )
    .expect("create");
}

/// Root positions in `pa`: a1 0, a2 1, a3 2, a4 3, a5 4, c1 5, r1 6, d1 7.
/// Under a1: s1 0, s2 1. In `pb`: b1 0. Completed: s2, c1. Archived: r1.
/// Deleted: d1.
fn seed(conn: &Connection) {
    seed_project(conn, "pa");
    seed_project(conn, "pb");
    let rows = [
        Seed {
            id: "a1",
            due: Some("2026-04-10"),
            priority: 1,
            tags: &["Work", "Urgent"],
            ..BASE
        },
        Seed {
            id: "a2",
            due: Some("2026-04-16"),
            time: Some("09:00"),
            priority: 3,
            tags: &["work"],
            status: Some("pa-doing"),
            ..BASE
        },
        Seed {
            id: "a3",
            due: Some("2026-04-16"),
            time: Some("08:00"),
            ..BASE
        },
        Seed {
            id: "a4",
            due: Some("2026-04-23"),
            priority: 2,
            ..BASE
        },
        Seed {
            id: "a5",
            due: Some("2026-04-24"),
            priority: 2,
            ..BASE
        },
        Seed {
            id: "c1",
            due: Some("2026-04-12"),
            ..BASE
        },
        Seed {
            id: "r1",
            due: Some("2026-04-16"),
            tags: &["Work"],
            ..BASE
        },
        Seed {
            id: "d1",
            tags: &["work"],
            ..BASE
        },
        Seed {
            id: "s1",
            parent: Some("a1"),
            ..BASE
        },
        Seed {
            id: "s2",
            parent: Some("a1"),
            ..BASE
        },
        Seed {
            id: "b1",
            project: "pb",
            tags: &["URGENT"],
            ..BASE
        },
    ];
    for (n, row) in rows.into_iter().enumerate() {
        add(conn, row, NOW + i64::try_from(n).expect("small") * 1_000);
    }
    let later = NOW + 60_000;
    tasks::set_completed(conn, "s2", true, DEVICE, later).expect("complete s2");
    tasks::set_completed(conn, "c1", true, DEVICE, later).expect("complete c1");
    tasks::set_archived(conn, "r1", true, DEVICE, later).expect("archive r1");
    tasks::delete(conn, "d1", DEVICE, later).expect("delete d1");
}

fn ids(items: &[TaskListItem]) -> Vec<&str> {
    items.iter().map(|item| item.task.id.as_str()).collect()
}

fn page_ids(conn: &Connection, query: &ListQuery) -> (Vec<String>, i64, bool) {
    let page = list::page(conn, query).expect("page");
    let ids = ids(&page.tasks).into_iter().map(str::to_owned).collect();
    (ids, page.total, page.has_more)
}

#[test]
fn domain_tasks_list_defaults_hide_completed_and_archived_and_count_subtasks() {
    let db = open("tl-defaults");
    db.call_blocking(|conn| {
        seed(conn);
        let page = list::page(conn, &ListQuery::default()).expect("page");
        assert_eq!(ids(&page.tasks), ["a1", "b1", "s1", "a2", "a3", "a4", "a5"]);
        assert_eq!((page.total, page.has_more), (7, false));
        let a1 = &page.tasks[0];
        assert_eq!((a1.subtask_count, a1.completed_subtask_count), (2, 1));
        assert!(a1.has_subtasks());
        assert!(!page.tasks[1].has_subtasks());

        let window = |offset| ListQuery {
            limit: 3,
            offset,
            ..ListQuery::default()
        };
        assert_eq!(
            page_ids(conn, &window(3)),
            (vec!["a2".into(), "a3".into(), "a4".into()], 7, true)
        );
        assert_eq!(page_ids(conn, &window(6)), (vec!["a5".into()], 7, false));

        let everything = ListQuery {
            include_completed: true,
            include_archived: true,
            ..ListQuery::default()
        };
        let (all, total, _) = page_ids(conn, &everything);
        assert_eq!(
            all,
            ["a1", "b1", "s1", "a2", "s2", "a3", "a4", "a5", "c1", "r1"]
        );
        assert_eq!(total, 10, "a deleted task is in no list and no total");
        Ok(())
    })
    .expect("db");
}

#[test]
fn domain_tasks_list_filters_and_totals_count_project_and_state_only() {
    let db = open("tl-filters");
    db.call_blocking(|conn| {
        seed(conn);
        let project = ListQuery {
            project_id: Some("pa".into()),
            ..ListQuery::default()
        };
        let (rows, total, _) = page_ids(conn, &project);
        assert_eq!(rows, ["a1", "s1", "a2", "a3", "a4", "a5"]);
        assert_eq!(total, 6);
        let empty_project = ListQuery {
            project_id: Some(String::new()),
            ..ListQuery::default()
        };
        assert_eq!(
            page_ids(conn, &empty_project).1,
            7,
            "an empty project id filters nothing"
        );

        // `countTasks` ignores status, parent, due and tags: `hasMore` stays
        // true past the last match, as on desktop.
        let doing = ListQuery {
            status_id: Match::Is("pa-doing".into()),
            ..ListQuery::default()
        };
        assert_eq!(page_ids(conn, &doing), (vec!["a2".into()], 7, true));
        assert_eq!(
            page_ids(
                conn,
                &ListQuery {
                    status_id: Match::Null,
                    ..ListQuery::default()
                }
            )
            .0,
            Vec::<String>::new()
        );

        let roots = ListQuery {
            parent_id: Match::Null,
            ..ListQuery::default()
        };
        assert_eq!(
            page_ids(conn, &roots).0,
            ["a1", "b1", "a2", "a3", "a4", "a5"]
        );
        let children = ListQuery {
            parent_id: Match::Is("a1".into()),
            include_completed: true,
            ..ListQuery::default()
        };
        assert_eq!(page_ids(conn, &children).0, ["s1", "s2"]);

        let due = ListQuery {
            due_after: Some("2026-04-16".into()),
            due_before: Some("2026-04-23".into()),
            ..ListQuery::default()
        };
        assert_eq!(
            page_ids(conn, &due).0,
            ["a2", "a3", "a4"],
            "both bounds inclusive"
        );
        Ok(())
    })
    .expect("db");
}

#[test]
fn domain_tasks_list_tags_match_every_tag_by_fold() {
    let db = open("tl-tags");
    db.call_blocking(|conn| {
        seed(conn);
        let tagged = |tags: &[&str], limit, offset| ListQuery {
            tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
            limit,
            offset,
            ..ListQuery::default()
        };
        assert_eq!(
            page_ids(conn, &tagged(&["work", "URGENT"], 100, 0)).0,
            ["a1"]
        );
        assert_eq!(page_ids(conn, &tagged(&["urgent"], 100, 0)).0, ["a1", "b1"]);
        assert_eq!(
            page_ids(conn, &tagged(&["WORK"], 1, 1)).0,
            ["a2"],
            "paged after the match"
        );
        assert_eq!(
            page_ids(conn, &tagged(&["home"], 100, 0)),
            (Vec::new(), 7, true),
            "no match still answers countTasks' total"
        );
        Ok(())
    })
    .expect("db");
}

#[test]
fn domain_tasks_list_sorts_with_nulls_first_ascending_and_ties_by_id() {
    let db = open("tl-sort");
    db.call_blocking(|conn| {
        seed(conn);
        let sorted = |sort_by, descending| ListQuery {
            sort_by,
            descending,
            ..ListQuery::default()
        };
        assert_eq!(
            page_ids(conn, &sorted(SortBy::DueDate, false)).0,
            ["b1", "s1", "a1", "a2", "a3", "a4", "a5"]
        );
        assert_eq!(
            page_ids(conn, &sorted(SortBy::DueDate, true)).0,
            ["a5", "a4", "a2", "a3", "a1", "b1", "s1"]
        );
        assert_eq!(
            page_ids(conn, &sorted(SortBy::Priority, true)).0,
            ["a2", "a4", "a5", "a1", "a3", "b1", "s1"]
        );
        assert_eq!(
            page_ids(conn, &sorted(SortBy::Created, true)).0,
            ["b1", "s1", "a5", "a4", "a3", "a2", "a1"]
        );
        Ok(())
    })
    .expect("db");
}

#[test]
fn domain_tasks_list_get_and_subtasks_carry_every_task_field() {
    let db = open("tl-get");
    db.call_blocking(|conn| {
        seed(conn);
        tasks::update::apply(
            conn,
            "a2",
            &TaskPatch {
                duration_minutes: Patch::Set(45),
                fields: Some(Map::from_iter([("Effort".to_owned(), json!("high"))])),
                ..TaskPatch::default()
            },
            LocalDateTime::parse("2026-04-16T12:00:00").expect("a local instant"),
            true,
            DEVICE,
            NOW + 120_000,
        )
        .expect("update")
        .expect("accepted");

        let a2 = list::get(conn, "a2").expect("get").expect("live");
        assert_eq!(a2.task.duration_minutes, Some(45));
        assert_eq!(a2.task.fields.get("Effort"), Some(&Value::from("high")));
        assert_eq!(a2.task.status_id.as_deref(), Some("pa-doing"));
        assert_eq!(a2.task.tags, ["work"]);
        let a1 = list::get(conn, "a1").expect("get").expect("live");
        assert_eq!((a1.subtask_count, a1.completed_subtask_count), (2, 1));
        assert!(
            list::get(conn, "d1").expect("get").is_none(),
            "a tombstone is no task"
        );
        assert!(list::get(conn, "zz").expect("get").is_none());

        assert_eq!(
            ids(&list::subtasks(conn, "a1").expect("subtasks")),
            ["s1", "s2"]
        );
        assert!(list::subtasks(conn, "a2").expect("subtasks").is_empty());
        Ok(())
    })
    .expect("db");
}

#[test]
fn domain_tasks_list_tag_counts_group_by_fold() {
    let db = open("tl-tag-counts");
    db.call_blocking(|conn| {
        seed(conn);
        assert_eq!(
            list::tag_counts(conn).expect("tags"),
            [
                TagCount {
                    tag: "Work".into(),
                    count: 3
                },
                TagCount {
                    tag: "URGENT".into(),
                    count: 2
                },
            ],
            "archived r1 counts, deleted d1 does not; the smallest spelling names the fold"
        );
        Ok(())
    })
    .expect("db");
}

#[test]
fn domain_tasks_stats_and_dated_views() {
    let db = open("tl-stats");
    db.call_blocking(|conn| {
        seed(conn);
        assert_eq!(
            stats::stats(conn, today()).expect("stats"),
            TaskStats {
                total: 9,
                completed: 2,
                overdue: 1,
                due_today: 2,
                due_this_week: 3
            }
        );
        assert_eq!(
            ids(&stats::today(conn, today()).expect("today")),
            ["a3", "a2"]
        );
        assert_eq!(
            ids(&stats::upcoming(conn, today(), 7).expect("upcoming")),
            ["a3", "a2", "a4"]
        );
        assert_eq!(
            ids(&stats::upcoming(conn, today(), 8).expect("upcoming")),
            ["a3", "a2", "a4", "a5"]
        );
        let overdue = stats::overdue(conn, today()).expect("overdue");
        assert_eq!(ids(&overdue), ["a1"]);
        assert_eq!(overdue[0].subtask_count, 2);
        Ok(())
    })
    .expect("db");
}
