//! The renderer's launch timings, logged next to the `launch timeline {` block so
//! `scripts/launch-bench.mjs` reads both from `main.log`.

use serde::{Deserialize, Serialize};

use super::error::CommandError;

/// Milliseconds since navigation start; a field is absent when the web view never recorded it.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RendererLaunchMarks {
    pub first_paint_ms: Option<f64>,
    pub fcp_ms: Option<f64>,
    pub dom_interactive_ms: Option<f64>,
    pub dom_content_loaded_ms: Option<f64>,
    /// `memry:note-readable`, set only when the note the launch restored rendered.
    pub note_readable_ms: Option<f64>,
}

/// Logs `renderer launch marks {json}`, the line the launch bench parses.
#[tauri::command]
#[specta::specta]
pub fn launch_report_renderer_marks(marks: RendererLaunchMarks) -> Result<(), CommandError> {
    let json = serde_json::to_string(&marks).unwrap_or_default();
    tracing::info!(scope = "Startup", "renderer launch marks {json}");
    Ok(())
}
