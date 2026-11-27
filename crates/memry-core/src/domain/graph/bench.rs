//! Query time of the graph at vault scale. Ignored in CI (wall-clock numbers, release build):
//! `cargo test -p memry-core --release --lib domain::graph::bench -- --ignored --nocapture`.
//! Each vault holds `n` notes linked in a ring and a stride, a hub every note fiftieth links,
//! ghosts, tags, `n / 2` tasks linking two notes each, relations, portals and canvas arrows.

use std::time::{Duration, Instant};

use rusqlite::{Connection, params};

use super::rows::{self, Among};
use super::{graph_data, local_graph};
use crate::domain::canvas::edges as canvas_edges;
use crate::storage::nested_tx;
use crate::storage::test_support::temp_dir;
use crate::storage::{open_data, open_index};

fn seed(data: &Connection, index: &Connection, n: usize) {
    let data_tx = nested_tx::begin(data).expect("begin data");
    let index_tx = nested_tx::begin(index).expect("begin index");
    for i in 0..n {
        data.execute(
            "INSERT INTO notes (id, title, file_type) VALUES (?1, ?2, 'markdown')",
            params![format!("n{i}"), format!("Note {i}")],
        )
        .expect("note");
        for (position, tag) in [format!("t{}", i % 40), format!("t{}", i % 7)]
            .iter()
            .enumerate()
        {
            data.execute(
                "INSERT OR IGNORE INTO note_tags (note_id, tag, position) VALUES (?1, ?2, ?3)",
                params![format!("n{i}"), tag, position as i64],
            )
            .expect("tag");
        }
        index
            .execute(
                "INSERT INTO note_stats (note_id, word_count, character_count, snippet, task_ids, \
                 header_tags, indexed_at) VALUES (?1, 100, 600, '', '[]', '[]', 0)",
                params![format!("n{i}")],
            )
            .expect("stats");
        let mut targets = vec![(i + 1) % n, (i * 7 + 3) % n];
        if i % 50 == 0 {
            targets.push(0);
        }
        for target in targets {
            index
                .execute(
                    "INSERT OR IGNORE INTO note_links (source_id, target_id, target_title) \
                     VALUES (?1, ?2, ?3)",
                    params![
                        format!("n{i}"),
                        format!("n{target}"),
                        format!("Note {target}")
                    ],
                )
                .expect("link");
        }
        if i % 10 == 0 {
            index
                .execute(
                    "INSERT OR IGNORE INTO note_links (source_id, target_id, target_title) \
                     VALUES (?1, NULL, ?2)",
                    params![format!("n{i}"), format!("Ghost {}", i % 100)],
                )
                .expect("ghost");
        }
        if i % 10 == 1 {
            index
                .execute(
                    "INSERT INTO property_refs (source_id, name, target_type, target_id) \
                     VALUES (?1, 'related', 'note', ?2)",
                    params![format!("n{i}"), format!("n{}", (i * 13) % n)],
                )
                .expect("relation");
        }
        if i % 20 == 2 {
            index
                .execute(
                    "INSERT INTO portal_refs (host_note_id, ordinal, source_note_id, kind) \
                     VALUES (?1, 0, ?2, 'note')",
                    params![format!("n{i}"), format!("n{}", (i * 17) % n)],
                )
                .expect("portal");
        }
    }
    for p in 0..20 {
        data.execute(
            "INSERT INTO projects (id, name, color) VALUES (?1, ?2, '#6b7280')",
            params![format!("p{p}"), format!("Project {p}")],
        )
        .expect("project");
    }
    for t in 0..n / 2 {
        let linked =
            serde_json::to_string(&[format!("n{}", (t * 2) % n), format!("n{}", (t * 3) % n)])
                .expect("ids");
        data.execute(
            "INSERT INTO tasks (id, title, project_id, linked_note_ids) VALUES (?1, ?2, ?3, ?4)",
            params![
                format!("t{t}"),
                format!("Task {t}"),
                format!("p{}", t % 20),
                linked
            ],
        )
        .expect("task");
    }
    for c in 0..10 {
        data.execute(
            "INSERT INTO canvases (id, vault_id, title) VALUES (?1, 'vault-1', ?1)",
            params![format!("c{c}")],
        )
        .expect("canvas");
    }
    for a in 0..n / 50 {
        index
            .execute(
                "INSERT INTO canvas_entity_edges (canvas_id, arrow_id, source_type, source_id, \
                 target_type, target_id) VALUES (?1, ?2, 'note', ?3, 'note', ?4)",
                params![
                    format!("c{}", a % 10),
                    format!("a{a}"),
                    format!("n{}", a * 5),
                    format!("n{}", a * 11 % n)
                ],
            )
            .expect("canvas edge");
    }
    data_tx.commit().expect("commit data");
    index_tx.commit().expect("commit index");
}

/// The fastest of nine runs, after one warm-up: on a loaded host the minimum is the closest
/// to the uncontended cost.
fn fastest<T>(mut run: impl FnMut() -> T) -> (Duration, T) {
    let mut out = run();
    let mut best = Duration::MAX;
    for _ in 0..9 {
        let start = Instant::now();
        out = run();
        best = best.min(start.elapsed());
    }
    (best, out)
}

fn measure(n: usize) {
    let dir = temp_dir("graph-bench");
    let data = open_data(&dir.path().join("data.db")).expect("data.db");
    let index = open_index(&dir.path().join("index.db"))
        .expect("index.db")
        .db;
    data.call_blocking(|data| {
        index.call_blocking(|index| {
            seed(data, index, n);
            let (time, graph) = fastest(|| graph_data(data, index).expect("graph"));
            println!(
                "n={n} graph_data: {time:?} ({} nodes, {} edges)",
                graph.nodes.len(),
                graph.edges.len()
            );
            for (seed_id, label) in [
                ("n0".to_owned(), "hub"),
                (format!("n{}", n * 43 / 100), "plain"),
            ] {
                for depth in 1..=3 {
                    let (time, local) =
                        fastest(|| local_graph(data, index, &seed_id, depth).expect("local"));
                    println!(
                        "n={n} local_graph {label} depth {depth}: {time:?} ({} nodes, {} edges)",
                        local.nodes.len(),
                        local.edges.len()
                    );
                }
            }
            readers(data, index, n);
            Ok(())
        })
    })
    .expect("connections");
}

/// Each reader the local walk calls per level, for a frontier of 1,500 notes.
fn readers(data: &Connection, index: &Connection, n: usize) {
    let notes: Vec<String> = (0..1_500.min(n)).map(|i| format!("n{i}")).collect();
    let ids = serde_json::to_string(&notes).expect("ids");
    let (ids, none) = (Among::Ids(&ids), Among::Ids("[]"));
    let report = |name: &str, time: Duration| println!("n={n} 1500-note frontier {name}: {time:?}");
    report(
        "notes",
        fastest(|| rows::notes(data, ids).expect("read").len()).0,
    );
    report(
        "word_counts",
        fastest(|| rows::word_counts(index, ids).expect("read").len()).0,
    );
    report(
        "tags",
        fastest(|| rows::tags(data, ids).expect("read").len()).0,
    );
    report(
        "tasks by project (none)",
        fastest(|| rows::tasks(data, "project_id", none).expect("read").len()).0,
    );
    for column in ["source_id", "target_id"] {
        report(
            column,
            fastest(|| rows::links(index, column, ids).expect("read").len()).0,
        );
    }
    report(
        "links by ghost title (none)",
        fastest(|| {
            rows::links(index, "target_title", none)
                .expect("read")
                .len()
        })
        .0,
    );
    for column in ["source_id", "target_id"] {
        report(
            "relations",
            fastest(|| rows::relations(index, column, ids).expect("read").len()).0,
        );
    }
    for column in ["host_note_id", "source_note_id"] {
        report(
            column,
            fastest(|| rows::portals(index, column, ids).expect("read").len()).0,
        );
    }
    report(
        "task_notes, every pair",
        fastest(|| rows::task_notes(data, Among::All).expect("read").len()).0,
    );
    // The lookup by note each ring ran before the walk read the pairs once (e87c428bd2).
    let reverse = "SELECT DISTINCT t.id, j.value FROM tasks t, json_each(\
           CASE WHEN json_valid(t.linked_note_ids) AND json_type(t.linked_note_ids) = 'array' \
           THEN t.linked_note_ids ELSE '[]' END) j \
         WHERE t.deleted_at IS NULL AND j.type = 'text' \
           AND j.value IN (SELECT value FROM json_each(?1))";
    for size in [8, 1_500] {
        let list = serde_json::to_string(&notes[..size.min(notes.len())]).expect("ids");
        let (time, _) = fastest(|| {
            let mut statement = data.prepare(reverse).expect("prepare");
            let rows = statement
                .query_map([&list], |row| row.get::<_, String>(0))
                .expect("query");
            rows.count()
        });
        report(
            &format!("per-ring task lookup by {size} notes (removed)"),
            time,
        );
    }
    let entities = serde_json::to_string(&notes).expect("ids");
    report(
        "canvas touching",
        fastest(|| {
            canvas_edges::touching(data, index, &entities)
                .expect("read")
                .len()
        })
        .0,
    );
}

#[test]
#[ignore = "benchmark: run with --release --ignored --nocapture"]
fn graph_at_scale() {
    for n in [1_000, 10_000] {
        measure(n);
    }
}
