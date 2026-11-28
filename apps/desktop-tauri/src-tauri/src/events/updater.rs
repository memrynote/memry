//! The updater event.

use memry_desktop::updater::state::AppUpdateState;
use serde::Serialize;

/// The updater state changed (`updater:state-changed`). The whole state, which the renderer
/// replaces wholesale; a burst of progress ticks reaches it as the latest value only.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct UpdaterStateChangedEvent(pub AppUpdateState);
