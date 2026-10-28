//! What an update source does for the service (`apps/desktop/src/main/updater-backend.ts`). The
//! Velopack implementation lives in the Tauri crate; the scripted one drives the end-to-end
//! tests. Every call blocks and runs off the async runtime.

use super::marker::Installer;
use super::severity::UpdateError;
use super::state::AvailableUpdate;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckOutcome {
    UpToDate,
    Available(AvailableUpdate),
}

pub trait UpdateBackend: Send + Sync {
    /// Reads the feed. The backend keeps the release it found for `download` and `apply`.
    fn check(&self) -> Result<CheckOutcome, UpdateError>;
    /// Downloads the release the last check found; `progress` takes 0 to 100. A release already
    /// on disk returns at once.
    fn download(&self, progress: &dyn Fn(f64)) -> Result<(), UpdateError>;
    /// Starts the installer, which waits for this process to exit. `restart` relaunches the app
    /// after the install.
    fn apply(&self, silent: bool, restart: bool) -> Result<(), UpdateError>;
    /// What the install marker records for an install started now.
    fn installer(&self) -> Installer;
}
