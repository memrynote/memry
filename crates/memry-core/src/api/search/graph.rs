//! The graph view's reads and saved layouts ([`crate::domain::graph`]). Not on the FFI
//! surface: iOS has no graph view.

use crate::api::errors::StorageError;
use crate::domain::graph::{
    self, GraphData,
    layouts::{self, GraphLayout},
};

use super::Search;

impl Search {
    /// The whole-vault graph ([`graph::graph_data`]).
    pub fn graph_data(&self) -> Result<GraphData, StorageError> {
        let index = self.index.clone();
        self.data
            .read_blocking(move |data| index.read_blocking(|index| graph::graph_data(data, index)))
    }

    /// The neighbourhood of `id` out to `depth` hops ([`graph::local_graph`]).
    pub fn local_graph(&self, id: &str, depth: u32) -> Result<GraphData, StorageError> {
        let index = self.index.clone();
        self.data.read_blocking(move |data| {
            index.read_blocking(|index| graph::local_graph(data, index, id, depth))
        })
    }

    /// [`layouts::get`].
    pub fn graph_layout(&self, view_key: &str) -> Result<Option<GraphLayout>, StorageError> {
        layouts::check_view_key(view_key)?;
        self.data.read_blocking(|data| layouts::get(data, view_key))
    }

    /// [`layouts::save`].
    pub fn save_graph_layout(
        &self,
        view_key: &str,
        layout: &GraphLayout,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        self.data
            .call_blocking(|data| layouts::save(data, view_key, layout, now_ms))
    }

    /// [`layouts::clear`].
    pub fn clear_graph_layout(&self, view_key: &str) -> Result<(), StorageError> {
        self.data
            .call_blocking(|data| layouts::clear(data, view_key))
    }
}
