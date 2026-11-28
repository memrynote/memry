//! The graph view for the shell's `graph_*` commands: `memry_core::domain::graph` through the
//! open vault's `Search`, with the layout in the `GraphLayoutSchema` shape the renderer sends.

use std::collections::BTreeMap;

use memry_core::api::errors::StorageError;
use memry_core::domain::graph::layouts::{GraphLayout, LayoutNode};
use serde::{Deserialize, Serialize};

use crate::session::OpenVault;

/// `GraphLayoutNodeSchema`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct GraphLayoutNodeView {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub pinned: Option<bool>,
}

/// `GraphLayoutSchema`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct GraphLayoutView {
    pub version: u32,
    pub nodes: BTreeMap<String, GraphLayoutNodeView>,
}

impl From<GraphLayout> for GraphLayoutView {
    fn from(layout: GraphLayout) -> Self {
        let nodes = layout.nodes.into_iter().map(|(id, node)| {
            let LayoutNode { x, y, pinned } = node;
            (id, GraphLayoutNodeView { x, y, pinned })
        });
        Self {
            version: layout.version,
            nodes: nodes.collect(),
        }
    }
}

impl From<GraphLayoutView> for GraphLayout {
    fn from(view: GraphLayoutView) -> Self {
        let nodes = view.nodes.into_iter().map(|(id, node)| {
            let GraphLayoutNodeView { x, y, pinned } = node;
            (id, LayoutNode { x, y, pinned })
        });
        Self {
            version: view.version,
            nodes: nodes.collect(),
        }
    }
}

fn to_json(value: &impl Serialize) -> Result<Vec<u8>, StorageError> {
    serde_json::to_vec(value).map_err(|error| StorageError::Failed {
        what: format!("graph will not serialise: {error}"),
    })
}

/// The whole-vault graph as `GraphDataResponse` JSON bytes.
pub fn graph_json(open: &OpenVault) -> Result<Vec<u8>, StorageError> {
    to_json(&open.search.graph_data()?)
}

/// The neighbourhood of `id` out to `depth` hops, as `GraphDataResponse` JSON bytes.
pub fn local_graph_json(open: &OpenVault, id: &str, depth: u32) -> Result<Vec<u8>, StorageError> {
    to_json(&open.search.local_graph(id, depth)?)
}

pub fn layout(open: &OpenVault, view_key: &str) -> Result<Option<GraphLayoutView>, StorageError> {
    Ok(open
        .search
        .graph_layout(view_key)?
        .map(GraphLayoutView::from))
}

pub fn save_layout(
    open: &OpenVault,
    view_key: &str,
    layout: GraphLayoutView,
    now_ms: i64,
) -> Result<(), StorageError> {
    open.search
        .save_graph_layout(view_key, &layout.into(), now_ms)
}

pub fn clear_layout(open: &OpenVault, view_key: &str) -> Result<(), StorageError> {
    open.search.clear_graph_layout(view_key)
}
