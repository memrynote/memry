//! The advisory index of what each canvas points at, in index.db (migration
//! `0012`): Electron's `canvas/edge-index.ts`, the ref writes of `store.ts` and
//! `canvas-handler.ts`, and the reads of `database/queries/canvas-edges.ts`.
//!
//! Both tables are rewritten from a canvas's scene ([`super::scene_refs`]) on
//! every save, sync apply and vault-open reconcile, so a lost index.db rebuilds
//! from the scenes. Electron's local save took the refs the renderer sent; here
//! they come from the scene, under the same card rule, so no caller is trusted
//! for either table. `canvases` lives in data.db, so every read keeps the rows
//! of live canvases there instead of joining.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

use super::scene_refs::{CanvasEntityRef, entity_edges, entity_refs};

/// One connection: an arrow between two cards on a live canvas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasEdge {
    pub canvas_id: String,
    pub canvas_title: Option<String>,
    pub source: CanvasEntityRef,
    pub target: CanvasEntityRef,
}

/// Replaces the canvas's refs and edges with those its scene draws.
pub fn rewrite(index: &Connection, canvas_id: &str, scene: &str) -> Result<(), StorageError> {
    let tx = index.unchecked_transaction().map_err(failed)?;
    clear_in(&tx, canvas_id)?;
    for card in entity_refs(scene) {
        tx.execute(
            "INSERT OR IGNORE INTO canvas_entity_refs (canvas_id, entity_type, entity_id)
             VALUES (?1, ?2, ?3)",
            params![canvas_id, card.entity_type, card.entity_id],
        )
        .map_err(failed)?;
    }
    for edge in entity_edges(scene) {
        tx.execute(
            "INSERT OR IGNORE INTO canvas_entity_edges
                 (canvas_id, arrow_id, source_type, source_id, target_type, target_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                canvas_id,
                edge.arrow_id,
                edge.source.entity_type,
                edge.source.entity_id,
                edge.target.entity_type,
                edge.target.entity_id
            ],
        )
        .map_err(failed)?;
    }
    tx.commit().map_err(failed)
}

/// Drops the canvas's refs and edges, for a deleted canvas.
pub fn clear(index: &Connection, canvas_id: &str) -> Result<(), StorageError> {
    let tx = index.unchecked_transaction().map_err(failed)?;
    clear_in(&tx, canvas_id)?;
    tx.commit().map_err(failed)
}

/// Every edge on a live canvas (`listCanvasEdges`).
pub fn list(data: &Connection, index: &Connection) -> Result<Vec<CanvasEdge>, StorageError> {
    edges_where(data, index, "", params![])
}

/// Edges on a live canvas that start or end at this entity
/// (`getCanvasEdgesForEntity`).
pub fn for_entity(
    data: &Connection,
    index: &Connection,
    entity_type: &str,
    entity_id: &str,
) -> Result<Vec<CanvasEdge>, StorageError> {
    edges_where(
        data,
        index,
        "WHERE (source_type = ?1 AND source_id = ?2) OR (target_type = ?1 AND target_id = ?2)",
        params![entity_type, entity_id],
    )
}

/// Edges on a live canvas with a note, task or project card at either end whose id is in
/// `ids`, a JSON array (`getCanvasEdgesTouching` with the graph's card types). The type is
/// part of the filter so both lookups use the `(type, id)` indexes.
pub fn touching(
    data: &Connection,
    index: &Connection,
    ids: &str,
) -> Result<Vec<CanvasEdge>, StorageError> {
    edges_where(
        data,
        index,
        "WHERE (source_type IN ('note', 'task', 'project') \
           AND source_id IN (SELECT value FROM json_each(?1))) \
         OR (target_type IN ('note', 'task', 'project') \
           AND target_id IN (SELECT value FROM json_each(?1)))",
        params![ids],
    )
}

/// How many entities each canvas holds, from the refs rather than the scenes
/// (`listCanvasesWithCounts`). A canvas with none is absent.
pub fn item_counts(index: &Connection) -> Result<HashMap<String, usize>, StorageError> {
    let mut statement = index
        .prepare_cached("SELECT canvas_id, COUNT(*) FROM canvas_entity_refs GROUP BY canvas_id")
        .map_err(failed)?;
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as usize)))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn clear_in(tx: &Connection, canvas_id: &str) -> Result<(), StorageError> {
    for table in ["canvas_entity_refs", "canvas_entity_edges"] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE canvas_id = ?1"),
            [canvas_id],
        )
        .map_err(failed)?;
    }
    Ok(())
}

/// Edges matching `filter` on a live canvas. Several arrows joining the same
/// two cards on one canvas are one connection; the same pair on two canvases
/// stays two.
fn edges_where(
    data: &Connection,
    index: &Connection,
    filter: &str,
    filter_params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<CanvasEdge>, StorageError> {
    let live = live_titles(data)?;
    let mut statement = index
        .prepare(&format!(
            "SELECT canvas_id, source_type, source_id, target_type, target_id
             FROM canvas_entity_edges {filter} ORDER BY canvas_id, arrow_id"
        ))
        .map_err(failed)?;
    let rows = statement
        .query_map(filter_params, |row| {
            let entity = |kind: usize, id: usize| -> rusqlite::Result<CanvasEntityRef> {
                Ok(CanvasEntityRef {
                    entity_type: row.get(kind)?,
                    entity_id: row.get(id)?,
                })
            };
            Ok((row.get::<_, String>(0)?, entity(1, 2)?, entity(3, 4)?))
        })
        .map_err(failed)?;
    let mut seen = HashSet::new();
    let mut edges = Vec::new();
    for row in rows {
        let (canvas_id, source, target) = row.map_err(failed)?;
        let Some(title) = live.get(&canvas_id) else {
            continue;
        };
        if seen.insert((canvas_id.clone(), source.clone(), target.clone())) {
            edges.push(CanvasEdge {
                canvas_title: title.clone(),
                canvas_id,
                source,
                target,
            });
        }
    }
    Ok(edges)
}

fn live_titles(data: &Connection) -> Result<HashMap<String, Option<String>>, StorageError> {
    let mut statement = data
        .prepare_cached("SELECT id, title FROM canvases WHERE deleted_at IS NULL")
        .map_err(failed)?;
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

#[cfg(test)]
mod tests;
