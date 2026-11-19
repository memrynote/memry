//! The graph view's data: Electron's `database/queries/graph.ts` (`getGraphData`,
//! `getLocalGraph`), the one owner of the graph query on this side.
//!
//! Nodes are markdown notes, journal days, unarchived tasks and projects, and a ghost
//! (`ghost:<title>`) per title a wiki link names that no note has. Edges, each with the id
//! `<source>-<target>-<type>`, come from the indexes that already exist for them: wiki links
//! (`note_links`), relation properties naming a note (`property_refs`), portal fences
//! (`portal_refs`), a task's project and linked notes (`tasks`), and arrows between cards on a
//! live canvas (`canvas::edges`). Nothing here keeps a second copy of any of them.
//!
//! `connectionCount` is a node's degree over the edges returned, and `isOrphan` means it has
//! none. The local graph keeps whole-vault degrees on its outermost ring ([`local_graph`]).

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;

use crate::api::errors::StorageError;
use crate::domain::canvas::edges as canvas_edges;

pub mod layouts;
mod local;
mod rows;

pub use local::local_graph;

use rows::{Among, NoteRow, ProjectRow, TaskRow};

const GHOST_PREFIX: &str = "ghost:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Note,
    Task,
    Journal,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EdgeKind {
    Wikilink,
    TaskNote,
    ProjectTask,
    Relation,
    Canvas,
    Portal,
}

impl EdgeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Wikilink => "wikilink",
            Self::TaskNote => "task-note",
            Self::ProjectTask => "project-task",
            Self::Relation => "relation",
            Self::Canvas => "canvas",
            Self::Portal => "portal",
        }
    }
}

/// `GraphNodeSchema` of `packages/contracts/src/graph-api.ts`, serialised in its shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: NodeKind,
    pub label: String,
    pub tags: Vec<String>,
    pub word_count: i64,
    pub connection_count: u32,
    pub emoji: Option<String>,
    /// The CSS variable the renderer paints the node with.
    pub color: &'static str,
    pub is_orphan: bool,
    pub is_unresolved: bool,
}

/// `GraphEdgeSchema`. `weight` is always 1, as Electron writes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(rename = "type")]
    pub kind: EdgeKind,
    pub weight: u32,
}

/// `GraphDataResponseSchema`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

fn color(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Note => "var(--graph-node-note)",
        NodeKind::Journal => "var(--graph-node-journal)",
        NodeKind::Task => "var(--graph-node-task)",
        NodeKind::Project => "var(--graph-node-project)",
    }
}

fn node(id: String, kind: NodeKind, label: String, emoji: Option<String>) -> GraphNode {
    GraphNode {
        id,
        kind,
        label,
        tags: Vec::new(),
        word_count: 0,
        connection_count: 0,
        emoji,
        color: color(kind),
        is_orphan: false,
        is_unresolved: false,
    }
}

fn or_untitled(label: String, fallback: &str) -> String {
    if label.is_empty() {
        fallback.to_owned()
    } else {
        label
    }
}

fn note_node(row: NoteRow, tags: Vec<String>, word_count: i64) -> GraphNode {
    let kind = if row.journal {
        NodeKind::Journal
    } else {
        NodeKind::Note
    };
    GraphNode {
        tags,
        word_count,
        ..node(row.id, kind, or_untitled(row.title, "Untitled"), row.emoji)
    }
}

fn task_node(row: &TaskRow) -> GraphNode {
    node(
        row.id.clone(),
        NodeKind::Task,
        or_untitled(row.title.clone(), "Untitled Task"),
        None,
    )
}

fn project_node(row: ProjectRow) -> GraphNode {
    node(
        row.id,
        NodeKind::Project,
        or_untitled(row.name, "Untitled Project"),
        row.icon,
    )
}

fn ghost_node(title: &str) -> GraphNode {
    GraphNode {
        color: "var(--graph-ghost-node)",
        is_unresolved: true,
        ..node(
            format!("{GHOST_PREFIX}{title}"),
            NodeKind::Note,
            title.to_owned(),
            None,
        )
    }
}

fn edge(source: &str, target: &str, kind: EdgeKind) -> GraphEdge {
    GraphEdge {
        id: format!("{source}-{target}-{}", kind.as_str()),
        source: source.to_owned(),
        target: target.to_owned(),
        kind,
        weight: 1,
    }
}

/// Sets each node's degree over `edges`; a node with none is an orphan.
fn count_connections<'a>(nodes: impl Iterator<Item = &'a mut GraphNode>, edges: &[GraphEdge]) {
    let mut counts: HashMap<&str, u32> = HashMap::new();
    for edge in edges {
        *counts.entry(edge.source.as_str()).or_default() += 1;
        *counts.entry(edge.target.as_str()).or_default() += 1;
    }
    for node in nodes {
        node.connection_count = counts.get(node.id.as_str()).copied().unwrap_or(0);
        node.is_orphan = node.connection_count == 0;
    }
}

/// The whole-vault graph (`getGraphData`): one statement per source table, built in memory.
pub fn graph_data(data: &Connection, index: &Connection) -> Result<GraphData, StorageError> {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut ids: HashSet<String> = HashSet::new();

    let words = rows::word_counts(index, Among::All)?;
    let mut tags = rows::tags(data, Among::All)?;
    for row in rows::notes(data, Among::All)? {
        ids.insert(row.id.clone());
        let note_tags = tags.remove(&row.id).unwrap_or_default();
        let word_count = words.get(&row.id).copied().unwrap_or(0);
        nodes.push(note_node(row, note_tags, word_count));
    }
    for row in rows::tasks(data, "id", Among::All)? {
        ids.insert(row.id.clone());
        nodes.push(task_node(&row));
        // A task under an archived project keeps this edge, as Electron's build does.
        if !row.project_id.is_empty() {
            edges.push(edge(&row.id, &row.project_id, EdgeKind::ProjectTask));
        }
    }
    for row in rows::projects(data, Among::All)? {
        ids.insert(row.id.clone());
        nodes.push(project_node(row));
    }

    for link in rows::links(index, "source_id", Among::All)? {
        if !ids.contains(&link.source_id) {
            continue;
        }
        match link.target_id {
            Some(target) if ids.contains(&target) => {
                edges.push(edge(&link.source_id, &target, EdgeKind::Wikilink));
            }
            Some(_) => {}
            None => {
                let ghost = ghost_node(&link.target_title);
                if ids.insert(ghost.id.clone()) {
                    nodes.push(ghost.clone());
                }
                edges.push(edge(&link.source_id, &ghost.id, EdgeKind::Wikilink));
            }
        }
    }
    let both = |source: &str, target: &str| ids.contains(source) && ids.contains(target);
    for (source, _, target) in rows::relations(index, "source_id", Among::All)? {
        if both(&source, &target) {
            edges.push(edge(&source, &target, EdgeKind::Relation));
        }
    }
    for (host, source) in rows::portals(index, "host_note_id", Among::All)? {
        if host != source && both(&host, &source) {
            edges.push(edge(&host, &source, EdgeKind::Portal));
        }
    }
    for (task, note) in rows::task_notes(data, Among::All)? {
        if both(&task, &note) {
            edges.push(edge(&task, &note, EdgeKind::TaskNote));
        }
    }
    let mut canvas_pairs = HashSet::new();
    for row in canvas_edges::list(data, index)? {
        let (source, target) = (row.source.entity_id, row.target.entity_id);
        if both(&source, &target) && canvas_pairs.insert((source.clone(), target.clone())) {
            edges.push(edge(&source, &target, EdgeKind::Canvas));
        }
    }

    count_connections(nodes.iter_mut(), &edges);
    Ok(GraphData { nodes, edges })
}

#[cfg(test)]
mod bench;
#[cfg(test)]
mod tests;
