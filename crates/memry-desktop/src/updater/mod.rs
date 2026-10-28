//! The in-app updater's decisions, without Tauri or Velopack (`apps/desktop/src/main/updater*.ts`).
//! The Tauri crate owns the Velopack calls, the process hooks and the commands; everything here
//! is pure logic over values and three small files in the app data directory, which are
//! contracts with the Electron build that writes them before handing over.

pub mod check_health;
pub mod guard;
pub mod health;
pub mod marker;
pub mod notes;
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
