//! The neighbourhood of one node (`getLocalGraph`): a walk outwards one hop at a time that
//! reads only the rows touching the current ring, so opening a note's local graph costs the
//! same on a large vault as on a small one. It returns exactly what building the whole-vault
//! graph and keeping the nodes within `depth` hops would return, the property the tests pin.

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;

use super::rows::{self, Among};
use super::{
    EdgeKind, GHOST_PREFIX, GraphData, GraphEdge, GraphNode, NodeKind, count_connections, edge,
    ghost_node, note_node, project_node, task_node,
};
use crate::api::errors::StorageError;
use crate::domain::canvas::edges as canvas_edges;

/// A whole-graph edge with the identity of the row that produced it, so a row reached from
/// both of its ends counts once.
struct Candidate {
    row_key: String,
    edge: GraphEdge,
    /// False only for `project-task`: the whole-vault build keeps a task's edge to a project
    /// that is no node (archived or gone).
    requires_both_nodes: bool,
}

/// What the walk has resolved, for one call.
#[derive(Default)]
struct Walk {
    /// Ids that resolved to a node.
    nodes: HashMap<String, GraphNode>,
    /// Every id already looked up, node or not.
    resolved: HashSet<String>,
    /// `tasks.project_id` of each resolved task.
    task_projects: HashMap<String, String>,
}

fn json_ids<'a>(ids: impl IntoIterator<Item = &'a String>) -> Result<String, StorageError> {
    let ids: Vec<&String> = ids.into_iter().collect();
    serde_json::to_string(&ids).map_err(|error| StorageError::Failed {
        what: format!("graph ids will not serialise: {error}"),
    })
}

impl Walk {
    /// Resolves `ids` the way the whole-vault build makes nodes: markdown notes and days,
    /// unarchived tasks and projects, and ghosts by title. Anything else stays unresolved.
    fn resolve(
        &mut self,
        data: &Connection,
        index: &Connection,
        ids: impl IntoIterator<Item = String>,
    ) -> Result<(), StorageError> {
        let mut real = Vec::new();
        for id in ids {
            if !self.resolved.insert(id.clone()) {
                continue;
            }
            match id.strip_prefix(GHOST_PREFIX) {
                Some(title) => {
                    let ghost = ghost_node(title);
                    self.nodes.insert(id, ghost);
                }
                None => real.push(id),
            }
        }
        if real.is_empty() {
            return Ok(());
        }
        let list = json_ids(&real)?;
        let among = Among::Ids(&list);
        let words = rows::word_counts(index, among)?;
        let mut tags = rows::tags(data, among)?;
        for row in rows::notes(data, among)? {
            let note_tags = tags.remove(&row.id).unwrap_or_default();
            let word_count = words.get(&row.id).copied().unwrap_or(0);
            self.nodes
                .insert(row.id.clone(), note_node(row, note_tags, word_count));
        }
        for row in rows::tasks(data, "id", among)? {
            self.nodes.insert(row.id.clone(), task_node(&row));
            self.task_projects.insert(row.id, row.project_id);
        }
        for row in rows::projects(data, among)? {
            self.nodes.insert(row.id.clone(), project_node(row));
        }
        Ok(())
    }

    /// Every whole-graph edge touching `frontier`, both directions of every relationship.
    fn incident(
        &self,
        data: &Connection,
        index: &Connection,
        frontier: &[String],
    ) -> Result<Vec<Candidate>, StorageError> {
        let mut notes = Vec::new();
        let mut tasks = Vec::new();
        let mut ghost_titles = Vec::new();
        // Projects, and ids that resolved to nothing: a task can name an archived or deleted
        // project, and the whole-vault build still walks that edge.
        let mut project_like = Vec::new();
        for id in frontier {
            if let Some(title) = id.strip_prefix(GHOST_PREFIX) {
                ghost_titles.push(title.to_owned());
                continue;
            }
            match self.nodes.get(id).map(|node| node.kind) {
                None | Some(NodeKind::Project) => project_like.push(id.clone()),
                Some(NodeKind::Task) => tasks.push(id.clone()),
                Some(NodeKind::Note | NodeKind::Journal) => notes.push(id.clone()),
            }
        }
        let (note_list, task_list) = (json_ids(&notes)?, json_ids(&tasks)?);
        let (ghost_list, project_list) = (json_ids(&ghost_titles)?, json_ids(&project_like)?);
        let notes_among = Among::Ids(&note_list);

        let mut out = Vec::new();
        let project_task = |task: &str, project: &str| Candidate {
            row_key: format!("project-task\0{task}"),
            edge: edge(task, project, EdgeKind::ProjectTask),
            requires_both_nodes: false,
        };
        for task in &tasks {
            if let Some(project) = self.task_projects.get(task).filter(|p| !p.is_empty()) {
                out.push(project_task(task, project));
            }
        }
        for row in rows::tasks(data, "project_id", Among::Ids(&project_list))? {
            out.push(project_task(&row.id, &row.project_id));
        }

        let mut links = HashMap::new();
        for (column, among) in [
            ("source_id", notes_among),
            ("target_id", notes_among),
            ("target_title", Among::Ids(&ghost_list)),
        ] {
            for row in rows::links(index, column, among)? {
                links.insert(format!("{}\0{}", row.source_id, row.target_title), row);
            }
        }
        for (key, row) in links {
            let target = row
                .target_id
                .unwrap_or_else(|| format!("{GHOST_PREFIX}{}", row.target_title));
            out.push(both(
                format!("wikilink\0{key}"),
                edge(&row.source_id, &target, EdgeKind::Wikilink),
            ));
        }

        let mut relations = HashSet::new();
        for column in ["source_id", "target_id"] {
            relations.extend(rows::relations(index, column, notes_among)?);
        }
        for (source, name, target) in relations {
            out.push(both(
                format!("relation\0{source}\0{name}\0{target}"),
                edge(&source, &target, EdgeKind::Relation),
            ));
        }

        let mut portals = HashSet::new();
        for column in ["host_note_id", "source_note_id"] {
            portals.extend(rows::portals(index, column, notes_among)?);
        }
        for (host, source) in portals.into_iter().filter(|(h, s)| h != s) {
            out.push(both(
                format!("portal\0{host}\0{source}"),
                edge(&host, &source, EdgeKind::Portal),
            ));
        }

        let mut task_notes = HashSet::new();
        task_notes.extend(rows::task_notes(data, "t.id", Among::Ids(&task_list))?);
        task_notes.extend(rows::task_notes(data, "j.value", notes_among)?);
        for (task, note) in task_notes {
            out.push(both(
                format!("task-note\0{task}\0{note}"),
                edge(&task, &note, EdgeKind::TaskNote),
            ));
        }

        let entities = json_ids(notes.iter().chain(&tasks).chain(&project_like))?;
        let mut pairs = HashSet::new();
        for row in canvas_edges::touching(data, index, &entities)? {
            pairs.insert((row.source.entity_id, row.target.entity_id));
        }
        for (source, target) in pairs {
            out.push(both(
                format!("canvas\0{source}\0{target}"),
                edge(&source, &target, EdgeKind::Canvas),
            ));
        }
        Ok(out)
    }
}

fn both(row_key: String, edge: GraphEdge) -> Candidate {
    Candidate {
        row_key,
        edge,
        requires_both_nodes: true,
    }
}

/// The nodes within `depth` hops of `id` and the edges between them. Edges incident to the
/// outermost ring are still read (not followed), because `connectionCount` is a node's degree
/// in the whole graph, not in the slice returned. An id that is no node returns nothing.
pub fn local_graph(
    data: &Connection,
    index: &Connection,
    id: &str,
    depth: u32,
) -> Result<GraphData, StorageError> {
    let mut walk = Walk::default();
    walk.resolve(data, index, [id.to_owned()])?;

    let mut visited: Vec<String> = vec![id.to_owned()];
    let mut seen: HashSet<String> = HashSet::from([id.to_owned()]);
    let mut edges: Vec<(String, GraphEdge)> = Vec::new();
    let mut edge_keys: HashSet<String> = HashSet::new();
    let mut frontier = vec![id.to_owned()];
    let mut level = 0;

    while !frontier.is_empty() {
        let candidates = walk.incident(data, index, &frontier)?;
        let ends = candidates
            .iter()
            .flat_map(|c| [c.edge.source.clone(), c.edge.target.clone()]);
        walk.resolve(data, index, ends.collect::<Vec<_>>())?;

        let mut next = Vec::new();
        for candidate in candidates {
            let Candidate {
                row_key,
                edge,
                requires_both_nodes,
            } = candidate;
            if requires_both_nodes
                && !(walk.nodes.contains_key(&edge.source) && walk.nodes.contains_key(&edge.target))
            {
                continue;
            }
            if level < depth {
                for end in [&edge.source, &edge.target] {
                    if seen.insert(end.clone()) {
                        visited.push(end.clone());
                        next.push(end.clone());
                    }
                }
            }
            if edge_keys.insert(row_key.clone()) {
                edges.push((row_key, edge));
            }
        }
        if level >= depth {
            break;
        }
        level += 1;
        frontier = next;
    }

    let edges: Vec<GraphEdge> = edges.into_iter().map(|(_, edge)| edge).collect();
    let mut nodes: Vec<GraphNode> = visited
        .iter()
        .filter_map(|id| walk.nodes.remove(id))
        .collect();
    count_connections(nodes.iter_mut(), &edges);
    let edges = edges
        .into_iter()
        .filter(|edge| seen.contains(&edge.source) && seen.contains(&edge.target))
        .collect();
    Ok(GraphData { nodes, edges })
}
