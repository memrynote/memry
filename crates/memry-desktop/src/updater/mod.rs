//! The in-app updater without Tauri or Velopack (`apps/desktop/src/main/updater*.ts`): the
//! service, its state and decisions, and three small files in the app data directory that keep
//! Electron's formats. The Tauri crate owns the Velopack backend, the process hooks and the
//! commands.

pub mod backend;
pub mod check_health;
pub mod guard;
pub mod health;
pub mod marker;
pub mod notes;
#[cfg(any(test, feature = "e2e"))]
pub mod scripted;
pub mod service;
pub mod severity;
pub mod state;
pub mod version;

#[cfg(test)]
mod tests;

use std::io::Read;
use std::path::Path;

/// Largest marker file read. Electron writes about 150 bytes; anything past this is not one of
/// its files, and reading it whole would let a stray file cost unbounded memory at launch.
pub const MAX_MARKER_BYTES: u64 = 64 * 1024;

/// The file's bytes, or `None` when it is missing, unreadable or larger than
/// [`MAX_MARKER_BYTES`].
fn read_marker(path: &Path) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(MAX_MARKER_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= MAX_MARKER_BYTES).then_some(bytes)
}
