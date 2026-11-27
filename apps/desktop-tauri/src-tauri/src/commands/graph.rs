//! The graph commands (`graph:*` of `ipc/graph-handlers.ts`), each one call of
//! `memry_desktop::graph`.
//!
//! `graph_get_graph_data` and `graph_get_local_graph` answer with the JSON as a raw `Response`
//! (`binary::COMMANDS`): a 10k-note vault's graph is megabytes, which the JSON IPC path would
//! encode a second time as a string. The layout commands are specta commands.

use memry_desktop::graph::{self, GraphLayoutView};
use tauri::ipc::Response;
use tauri::{AppHandle, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::notes::open_vault;
use crate::binary;

/// `LocalGraphRequestSchema`: depth 1 to 3, 2 when absent.
const DEPTH_DEFAULT: u32 = 2;
const DEPTH_MAX: u32 = 3;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// `graph:get-graph-data`: the whole-vault graph, as raw JSON (`GraphDataResponse`). Listed in
/// `binary::COMMANDS`; not a specta command.
#[tauri::command]
pub async fn graph_get_graph_data<R: Runtime>(app: AppHandle<R>) -> Result<Response, CommandError> {
    blocking("graph_get_graph_data", move || {
        graph::graph_json(&open_vault(&app)?)
            .map(binary::response)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `graph:get-local-graph`: the nodes within `depth` hops of `note_id`, as raw JSON. Listed in
/// `binary::COMMANDS`; not a specta command.
#[tauri::command]
pub async fn graph_get_local_graph<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    depth: Option<u32>,
) -> Result<Response, CommandError> {
    let depth = depth.unwrap_or(DEPTH_DEFAULT);
    if note_id.is_empty() || !(1..=DEPTH_MAX).contains(&depth) {
        return Err(CommandError::new(
            ErrorKind::Invalid,
            "graph_local_input",
            "noteId must not be empty and depth must be between 1 and 3",
        ));
    }
    blocking("graph_get_local_graph", move || {
        graph::local_graph_json(&open_vault(&app)?, &note_id, depth)
            .map(binary::response)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `graph:get-layout`: the layout saved for the view, `null` when none reads.
#[tauri::command]
#[specta::specta]
pub async fn graph_get_layout<R: Runtime>(
    app: AppHandle<R>,
    view_key: String,
) -> Result<Option<GraphLayoutView>, CommandError> {
    blocking("graph_get_layout", move || {
        graph::layout(&open_vault(&app)?, &view_key)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `graph:save-layout`: replaces the view's layout.
#[tauri::command]
#[specta::specta]
pub async fn graph_save_layout<R: Runtime>(
    app: AppHandle<R>,
    view_key: String,
    layout: GraphLayoutView,
) -> Result<(), CommandError> {
    blocking("graph_save_layout", move || {
        graph::save_layout(&open_vault(&app)?, &view_key, layout, now_ms())
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `graph:clear-layout`: forgets the view's layout.
#[tauri::command]
#[specta::specta]
pub async fn graph_clear_layout<R: Runtime>(
    app: AppHandle<R>,
    view_key: String,
) -> Result<(), CommandError> {
    blocking("graph_clear_layout", move || {
        graph::clear_layout(&open_vault(&app)?, &view_key)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}
