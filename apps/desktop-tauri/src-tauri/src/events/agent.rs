//! The agent events (Step 28, #3545): Electron's `agent:event` broadcast. The gate raises the
//! approval cards (`tool_call_pending_approval`) and clears the ones nobody answered
//! (`tool_call_failed`); the runtime stage adds the rest of `AgentEventSchema`.

use memry_desktop::agent::runtime::AgentEvent;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct AgentEventEmittedEvent(pub AgentEvent);
