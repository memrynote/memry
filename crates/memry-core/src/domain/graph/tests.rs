//! The graph against real `data.db` and `index.db`. `graph_parity` compares with what
//! Electron's `getGraphData` and `getLocalGraph` return for the same vault
//! (`scripts/dump-graph-fixture.ts` writes `graph_parity.json`; [`seed`] and that script's
//! `seed` describe one vault). The rest port `apps/desktop/src/main/database/queries/graph.test.ts`.

use std::collections::{HashMap, HashSet, VecDeque};

use rusqlite::{Connection, params};
use serde_json::Value;

use super::layouts::{self, GraphLayout, LayoutNode};
use super::{GraphData, graph_data, local_graph};
use crate::storage::test_support::{TempDir, temp_dir};
use crate::storage::{Db, open_data, open_index};

struct Vault {
    data: Db,
    index: Db,
    _dir: TempDir,
}

impl Vault {
    fn new(label: &str) -> Self {
        let dir = temp_dir(label);
        let data = open_data(&dir.path().join("data.db")).expect("data.db");
        let index = open_index(&dir.path().join("index.db"))
            .expect("index.db")
            .db;
        Self {
            data,
            index,
            _dir: dir,
        }
    }

    fn with<T>(&self, f: impl FnOnce(&Connection, &Connection) -> T) -> T {
        self.data
            .call_blocking(|data| self.index.call_blocking(|index| Ok(f(data, index))))
            .expect("connections")
    }

    fn graph(&self) -> GraphData {
        self.with(|data, index| graph_data(data, index).expect("graph"))
    }

    fn local(&self, id: &str, depth: u32) -> GraphData {
        self.with(|data, index| local_graph(data, index, id, depth).expect("local graph"))
    }
}

fn note(
    data: &Connection,
    index: &Connection,
    id: &str,
    title: &str,
    emoji: Option<&str>,
    words: i64,
) {
    data.execute(
        "INSERT INTO notes (id, title, emoji, file_type) VALUES (?1, ?2, ?3, 'markdown')",
        params![id, title, emoji],
    )
    .expect("note");
    stats(index, id, words);
}

fn stats(index: &Connection, id: &str, words: i64) {
    index
        .execute(
            "INSERT INTO note_stats (note_id, word_count, character_count, snippet, task_ids, \
             header_tags, indexed_at) VALUES (?1, ?2, 100, '', '[]', '[]', 0)",
            params![id, words],
        )
        .expect("note stats");
}

fn link(index: &Connection, source: &str, title: &str, target: Option<&str>) {
    index
        .execute(
            "INSERT INTO note_links (source_id, target_id, target_title) VALUES (?1, ?2, ?3)",
            params![source, target, title],
        )
        .expect("link");
}

fn relation(index: &Connection, source: &str, name: &str, kind: &str, target: &str) {
    index
        .execute(
            "INSERT INTO property_refs (source_id, name, target_type, target_id) \
             VALUES (?1, ?2, ?3, ?4)",
            params![source, name, kind, target],
        )
        .expect("relation");
}

fn task(data: &Connection, id: &str, project: &str, archived: Option<&str>, notes: &[&str]) {
    let linked = serde_json::to_string(notes).expect("ids");
    data.execute(
        "INSERT INTO tasks (id, title, project_id, archived_at, linked_note_ids) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, format!("Task {id}"), project, archived, linked],
    )
    .expect("task");
}

fn canvas_edge(index: &Connection, canvas: &str, arrow: &str, from: [&str; 2], to: [&str; 2]) {
    index
        .execute(
            "INSERT INTO canvas_entity_edges (canvas_id, arrow_id, source_type, source_id, \
             target_type, target_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![canvas, arrow, from[0], from[1], to[0], to[1]],
        )
        .expect("canvas edge");
}

/// The vault of `scripts/dump-graph-fixture.ts`: a 3-note cycle, two rows collapsing onto one
/// edge id, a ghost shared by two notes four hops apart, an untitled note, relation refs both
/// ways and to a deleted note and a task, portals (twice to one note, to itself, a search, to
/// a deleted note), task links, an archived task, tasks under an archived project, and canvas
/// arrows (duplicates, across two boards, to an event card, on a deleted board).
fn seed(data: &Connection, index: &Connection) {
    for (id, title, emoji, words) in [
        ("n1", "Alpha", Some("A"), 42),
        ("n2", "Beta", None, 10),
        ("n3", "Gamma", None, 10),
        ("n4", "Delta", None, 10),
        ("n5", "Epsilon", None, 10),
        ("n6", "Zeta", None, 10),
        ("n7", "Eta", None, 10),
        ("n8", "", None, 10),
    ] {
        note(data, index, id, title, emoji, words);
    }
    data.execute(
        "INSERT INTO journal_entries (id, date) VALUES ('j1', '2026-05-10')",
        [],
    )
    .expect("journal");
    stats(index, "j1", 10);
    data.execute(
        "INSERT INTO notes (id, title, file_type, mime_type) \
         VALUES ('pdf-1', 'Report', 'pdf', 'application/pdf')",
        [],
    )
    .expect("pdf");
    for (position, (id, tag)) in [
        ("n1", "work"),
        ("n1", "focus"),
        ("n2", "inbox"),
        ("j1", "daily"),
    ]
    .into_iter()
    .enumerate()
    {
        data.execute(
            "INSERT INTO note_tags (note_id, tag, position) VALUES (?1, ?2, ?3)",
            params![id, tag, position as i64],
        )
        .expect("tag");
    }
    for (source, title, target) in [
        ("n1", "Beta", Some("n2")),
        ("n2", "Gamma", Some("n3")),
        ("n3", "Alpha", Some("n1")),
        ("n1", "Delta", Some("n4")),
        ("n1", "Delta Alias", Some("n4")),
        ("n4", "Alpha", Some("n1")),
        ("j1", "Alpha", Some("n1")),
        ("n2", "Missing", None),
        ("n5", "Missing", None),
        ("n1", "Report", Some("pdf-1")),
        ("n1", "Deleted", Some("nte_gone")),
        ("pdf-1", "Alpha", Some("n1")),
        ("n8", "Nowhere", None),
    ] {
        link(index, source, title, target);
    }
    relation(index, "n3", "related", "note", "n4");
    relation(index, "n4", "mirror", "note", "n3");
    relation(index, "n3", "ghosted", "note", "nte_gone");
    relation(index, "n3", "assignee", "task", "t1");
    for (host, ordinal, source, kind) in [
        ("n6", 0, Some("n2"), "note"),
        ("n6", 1, Some("n2"), "blocks"),
        ("n3", 0, Some("n3"), "note"),
        ("n6", 2, None, "search"),
        ("n4", 0, Some("nte_gone"), "note"),
    ] {
        index
            .execute(
                "INSERT INTO portal_refs (host_note_id, ordinal, source_note_id, kind) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![host, ordinal, source, kind],
            )
            .expect("portal");
    }
    for (id, name, archived) in [
        ("p1", "Launch", None),
        ("p-arch", "Archived", Some("2026-05-10T00:00:00.000Z")),
    ] {
        data.execute(
            "INSERT INTO projects (id, name, color, icon, archived_at) \
             VALUES (?1, ?2, '#6b7280', 'briefcase', ?3)",
            params![id, name, archived],
        )
        .expect("project");
    }
    task(data, "t1", "p1", None, &["n1", "nte_gone"]);
    task(data, "t2", "p1", None, &["n5"]);
    task(data, "t3", "p-arch", None, &["n2"]);
    task(data, "t4", "p-arch", None, &[]);
    task(
        data,
        "t-arch",
        "p1",
        Some("2026-05-10T00:00:00.000Z"),
        &["n1"],
    );
    for (id, deleted) in [("c1", None), ("c2", None), ("c-dead", Some(5))] {
        data.execute(
            "INSERT INTO canvases (id, vault_id, title, deleted_at) VALUES (?1, 'vault-1', ?1, ?2)",
            params![id, deleted],
        )
        .expect("canvas");
    }
    canvas_edge(index, "c1", "a1", ["note", "n5"], ["note", "n7"]);
    canvas_edge(index, "c1", "a2", ["note", "n5"], ["note", "n7"]);
    canvas_edge(index, "c2", "a1", ["note", "n5"], ["note", "n7"]);
    canvas_edge(index, "c1", "a3", ["task", "t2"], ["note", "n7"]);
    canvas_edge(index, "c1", "a4", ["note", "n7"], ["calendar_event", "e1"]);
    canvas_edge(index, "c1", "a5", ["project", "p1"], ["note", "n6"]);
    canvas_edge(index, "c-dead", "a1", ["note", "n1"], ["note", "n7"]);
}

fn seeded(label: &str) -> Vault {
    let vault = Vault::new(label);
    vault.with(seed);
    vault
}

/// Array order carries no meaning (the renderer keys by id); every object and multiplicity does.
fn normalize(graph: Value) -> Value {
    let mut graph = graph;
    let by_id = |a: &Value, b: &Value| a["id"].as_str().cmp(&b["id"].as_str());
    let nodes = graph["nodes"].as_array_mut().expect("nodes");
    for node in nodes.iter_mut() {
        node["tags"]
            .as_array_mut()
            .expect("tags")
            .sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    }
    nodes.sort_by(by_id);
    graph["edges"].as_array_mut().expect("edges").sort_by(by_id);
    graph
}

fn json(graph: &GraphData) -> Value {
    normalize(serde_json::to_value(graph).expect("graph json"))
}

#[test]
fn graph_parity_with_electron_for_the_whole_vault_and_local_depths_1_to_3() {
    let fixture: Value =
        serde_json::from_str(include_str!("graph_parity.json")).expect("fixture json");
    let vault = seeded("graph-parity");

    assert_eq!(json(&vault.graph()), normalize(fixture["graph"].clone()));
    let local = fixture["local"].as_object().expect("local");
    assert_eq!(local.len(), 10);
    for (id, depths) in local {
        for (depth, expected) in depths.as_object().expect("depths") {
            let depth: u32 = depth.parse().expect("depth");
            assert_eq!(
                json(&vault.local(id, depth)),
                normalize(expected.clone()),
                "local graph of {id} at depth {depth}"
            );
        }
    }
}

/// `referenceLocalGraph` of the Electron test: the whole-vault graph, then a BFS of `depth`.
fn reference_local(graph: &GraphData, id: &str, depth: u32) -> Value {
    let mut adjacency: HashMap<&str, HashSet<&str>> = HashMap::new();
    for edge in &graph.edges {
        adjacency
            .entry(&edge.source)
            .or_default()
            .insert(&edge.target);
        adjacency
            .entry(&edge.target)
            .or_default()
            .insert(&edge.source);
    }
    let mut visited = HashSet::from([id]);
    let mut queue = VecDeque::from([(id, 0)]);
    while let Some((at, level)) = queue.pop_front() {
        if level >= depth {
            continue;
        }
        for &next in adjacency.get(at).into_iter().flatten() {
            if visited.insert(next) {
                queue.push_back((next, level + 1));
            }
        }
    }
    json(&GraphData {
        nodes: graph
            .nodes
            .iter()
            .filter(|node| visited.contains(node.id.as_str()))
            .cloned()
            .collect(),
        edges: graph
            .edges
            .iter()
            .filter(|edge| {
                visited.contains(edge.source.as_str()) && visited.contains(edge.target.as_str())
            })
            .cloned()
            .collect(),
    })
}

#[test]
fn the_local_walk_returns_what_the_whole_vault_build_then_filter_returns() {
    let vault = seeded("graph-local-reference");
    let graph = vault.graph();
    for id in [
        "n1", "n5", "n6", "n7", "n8", "j1", "t1", "t2", "p1", "p-arch", "nte_gone",
    ] {
        for depth in 0..=4 {
            assert_eq!(
                json(&vault.local(id, depth)),
                reference_local(&graph, id, depth),
                "{id} at depth {depth}"
            );
        }
    }
}

#[test]
fn the_outer_ring_keeps_whole_vault_connection_counts() {
    let vault = seeded("graph-outer-ring");
    let graph = vault.local("n1", 2);
    let node = |id: &str| graph.nodes.iter().find(|node| node.id == id);

    // Reached at depth 2 and never expanded, yet it carries both links, the second from n5.
    assert_eq!(node("ghost:Missing").map(|n| n.connection_count), Some(2));
    assert!(node("n5").is_none());
    let twice = graph
        .edges
        .iter()
        .filter(|e| e.id == "n1-n4-wikilink")
        .count();
    assert_eq!(twice, 2, "two rows on one edge id stay two edges");
}

#[test]
fn a_missing_id_has_an_empty_local_graph_and_depth_bounds_the_walk() {
    let vault = Vault::new("graph-depth");
    vault.with(|data, index| {
        for id in ["a", "b", "c"] {
            note(data, index, id, &id.to_uppercase(), None, 1);
        }
        link(index, "a", "B", Some("b"));
        link(index, "b", "C", Some("c"));
    });
    let ids = |graph: GraphData| {
        let mut ids: Vec<String> = graph.nodes.into_iter().map(|n| n.id).collect();
        ids.sort();
        ids
    };
    assert_eq!(ids(vault.local("a", 0)), ["a"]);
    assert_eq!(ids(vault.local("a", 1)), ["a", "b"]);
    assert_eq!(ids(vault.local("a", 2)), ["a", "b", "c"]);
    assert_eq!(vault.local("missing", 2), GraphData::default());
}

#[test]
fn deleted_and_non_markdown_items_are_no_nodes() {
    let vault = seeded("graph-live-only");
    vault.with(|data, _| {
        data.execute("UPDATE notes SET deleted_at = 1 WHERE id = 'n7'", [])
            .expect("delete note");
        data.execute("UPDATE tasks SET deleted_at = 1 WHERE id = 't2'", [])
            .expect("delete task");
    });
    let graph = vault.graph();
    let ids: HashSet<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
    for gone in ["n7", "t2", "pdf-1", "t-arch", "p-arch"] {
        assert!(!ids.contains(gone), "{gone} is no node");
    }
    assert!(graph.edges.iter().all(|e| ids.contains(e.source.as_str())));
    assert!(
        !graph
            .edges
            .iter()
            .any(|e| e.kind == super::EdgeKind::Canvas && e.target == "n7")
    );
}

#[test]
fn a_task_link_list_that_is_not_an_array_links_nothing() {
    let vault = seeded("graph-bad-links");
    vault.with(|data, _| {
        data.execute(
            "UPDATE tasks SET linked_note_ids = '{\"a\":\"n1\"}' WHERE id = 't1'",
            [],
        )
        .expect("object");
        data.execute(
            "UPDATE tasks SET linked_note_ids = 'not json' WHERE id = 't2'",
            [],
        )
        .expect("garbage");
    });
    let graph = vault.graph();
    assert!(
        !graph
            .edges
            .iter()
            .any(|e| e.id == "t1-n1-task-note" || e.id == "t2-n5-task-note")
    );
    assert!(graph.edges.iter().any(|e| e.id == "t3-n2-task-note"));
}

fn layout(pinned: Option<bool>) -> GraphLayout {
    GraphLayout {
        version: 1,
        nodes: [(
            "n1".to_owned(),
            LayoutNode {
                x: 1.5,
                y: -2.0,
                pinned,
            },
        )]
        .into(),
    }
}

#[test]
fn a_layout_saves_replaces_reads_and_clears_per_view() {
    let vault = Vault::new("graph-layouts");
    vault.with(|data, _| {
        assert_eq!(layouts::get(data, "global").expect("none yet"), None);
        layouts::save(data, "global", &layout(Some(true)), 1).expect("save");
        layouts::save(data, "view-2", &layout(None), 1).expect("save other");
        layouts::save(data, "global", &layout(Some(false)), 2).expect("replace");
        assert_eq!(
            layouts::get(data, "global").expect("read"),
            Some(layout(Some(false)))
        );
        layouts::clear(data, "global").expect("clear");
        assert_eq!(layouts::get(data, "global").expect("cleared"), None);
        assert_eq!(
            layouts::get(data, "view-2").expect("other kept"),
            Some(layout(None))
        );
    });
}

#[test]
fn an_electron_row_with_pinned_nodes_reads_back_and_garbage_reads_as_none() {
    let vault = Vault::new("graph-layout-compat");
    vault.with(|data, _| {
        // Electron's `positions` value as `saveGraphLayout` writes it, copied unchanged.
        let electron =
            r#"{"version":1,"nodes":{"n1":{"x":1.5,"y":-2,"pinned":true},"n2":{"x":0,"y":3}}}"#;
        for (key, value) in [
            ("global", electron),
            ("garbage", "{not json"),
            ("v2", r#"{"version":2,"nodes":{}}"#),
            ("no-nodes", r#"{"version":1}"#),
        ] {
            data.execute(
                "INSERT INTO graph_layouts (view_key, layout_json, updated_at) VALUES (?1, ?2, 0)",
                params![key, value],
            )
            .expect("row");
        }
        let read = layouts::get(data, "global").expect("read").expect("layout");
        assert_eq!(read.nodes["n1"].pinned, Some(true));
        assert_eq!(
            read.nodes["n2"],
            LayoutNode {
                x: 0.0,
                y: 3.0,
                pinned: None
            }
        );
        for key in ["garbage", "v2", "no-nodes"] {
            assert_eq!(layouts::get(data, key).expect("read"), None, "{key}");
        }
    });
}

#[test]
fn a_layout_write_refuses_what_the_contract_refuses() {
    let vault = Vault::new("graph-layout-refusals");
    vault.with(|data, _| {
        let long = "k".repeat(201);
        for key in ["", long.as_str()] {
            assert!(
                layouts::save(data, key, &layout(None), 1).is_err(),
                "key of {}",
                key.len()
            );
            assert!(layouts::clear(data, key).is_err());
        }
        assert!(layouts::save(data, &"k".repeat(200), &layout(None), 1).is_ok());
        let v2 = GraphLayout {
            version: 2,
            ..layout(None)
        };
        assert!(layouts::save(data, "global", &v2, 1).is_err());
        let mut nan = layout(None);
        nan.nodes.get_mut("n1").expect("n1").x = f64::NAN;
        assert!(layouts::save(data, "global", &nan, 1).is_err());
    });
}
