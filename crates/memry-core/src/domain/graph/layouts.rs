//! Saved node positions per graph view (Electron's `database/queries/graph-layouts.ts`), in
//! data.db `graph_layouts` (migration 0042). The stored JSON is Electron's `positions` value
//! unchanged, `GraphLayoutSchema` of `packages/contracts/src/graph-api.ts`: a pinned node is
//! held in place by the simulation, the rest only seed where the layout starts.

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension as _, params};
use serde::{Deserialize, Serialize};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

/// `GRAPH_LAYOUT_VERSION`: the only shape this build reads or writes.
pub const LAYOUT_VERSION: u32 = 1;

/// `GraphLayoutViewKeySchema`: at most this many UTF-16 units, as zod counts a string.
pub const VIEW_KEY_MAX: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutNode {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphLayout {
    pub version: u32,
    pub nodes: BTreeMap<String, LayoutNode>,
}

fn invalid(what: &str) -> StorageError {
    StorageError::Invalid {
        what: what.to_owned(),
    }
}

/// Refuses a view key zod would refuse: empty, or over [`VIEW_KEY_MAX`] UTF-16 units.
pub fn check_view_key(view_key: &str) -> Result<(), StorageError> {
    let units = view_key.encode_utf16().count();
    if units == 0 || units > VIEW_KEY_MAX {
        return Err(invalid("graph view key must be 1 to 200 characters"));
    }
    Ok(())
}

/// The layout saved for `view_key`, or `None` when there is none or it does not read as a
/// version 1 layout: an unreadable value falls back to a fresh arrangement, never an error.
pub fn get(data: &Connection, view_key: &str) -> Result<Option<GraphLayout>, StorageError> {
    let stored: Option<String> = data
        .query_row(
            "SELECT layout_json FROM graph_layouts WHERE view_key = ?1",
            [view_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(stored
        .and_then(|json| serde_json::from_str::<GraphLayout>(&json).ok())
        .filter(|layout| layout.version == LAYOUT_VERSION))
}

/// Replaces the layout of `view_key`.
pub fn save(
    data: &Connection,
    view_key: &str,
    layout: &GraphLayout,
    now_ms: i64,
) -> Result<(), StorageError> {
    check_view_key(view_key)?;
    if layout.version != LAYOUT_VERSION {
        return Err(invalid("graph layout version must be 1"));
    }
    if layout
        .nodes
        .values()
        .any(|node| !node.x.is_finite() || !node.y.is_finite())
    {
        return Err(invalid("graph layout positions must be finite numbers"));
    }
    let json = serde_json::to_string(layout).map_err(|error| StorageError::Failed {
        what: format!("graph layout will not serialise: {error}"),
    })?;
    data.execute(
        "INSERT INTO graph_layouts (view_key, layout_json, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT (view_key) DO UPDATE SET layout_json = ?2, updated_at = ?3",
        params![view_key, json, now_ms],
    )
    .map_err(failed)?;
    Ok(())
}

/// Forgets the layout of `view_key`; nothing to forget is not an error.
pub fn clear(data: &Connection, view_key: &str) -> Result<(), StorageError> {
    check_view_key(view_key)?;
    data.execute("DELETE FROM graph_layouts WHERE view_key = ?1", [view_key])
        .map_err(failed)?;
    Ok(())
}
