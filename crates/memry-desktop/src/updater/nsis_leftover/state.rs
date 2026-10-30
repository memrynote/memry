//! `nsis-leftover.json` in the app data directory: what this app knows about the leftover across
//! launches. Written by this app only; a missing or unreadable file reads as empty, which at worst
//! restarts the wait before removal.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::vault::fs_atomic::atomic_write;

pub const STATE_FILENAME: &str = "nsis-leftover.json";

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverState {
    /// When a launch first found the leftover at [`Self::install_location`] (epoch ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_seen_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_location: Option<String>,
    /// The name the directory was renamed to before its removal. Recorded before the rename, so
    /// a removal cut short resumes there, and only there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tombstone: Option<String>,
    /// The last reason reported for keeping the leftover, so one reason is reported once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reported: Option<String>,
}

fn path(dir: &Path) -> PathBuf {
    dir.join(STATE_FILENAME)
}

pub fn read(dir: &Path) -> LeftoverState {
    super::super::read_marker(&path(dir))
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Atomic: a recorded tombstone must be on disk before the rename it describes.
pub fn write(dir: &Path, state: &LeftoverState) -> Result<(), String> {
    if *state == LeftoverState::default() {
        return clear(dir);
    }
    let bytes = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    atomic_write(&path(dir), &bytes).map_err(|error| error.to_string())
}

fn clear(dir: &Path) -> Result<(), String> {
    match std::fs::remove_file(path(dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
