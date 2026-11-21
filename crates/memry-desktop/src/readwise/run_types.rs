//! What a Readwise run reports (`BookEvent`, `RunResult`) and the hooks its callers plug into
//! it: the observer of its progress and the gate that holds it (D8).

use chrono_tz::Tz;
use tokio_util::sync::CancellationToken;

use super::client::ReadwiseError;
use super::run_state::RunCounts;
use super::writer::SkipReason;

/// What happened to one book (`BookEvent`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BookResult {
    Created,
    Updated,
    Appended,
    Unchanged,
    Skipped(SkipReason),
    CategoryOff,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookEvent {
    pub title: String,
    pub result: BookResult,
}

/// `RunObserver` without its signal: the run's progress for the import dialog and the
/// settings panel.
pub trait RunObserver {
    /// `total` books will be looked at.
    fn planned(&self, _total: usize) {}
    /// A book is about to be written.
    fn writing(&self, _title: &str) {}
    /// A book is done.
    fn book(&self, _event: &BookEvent) {}
    /// The import runner writes its own summary, so it answers false.
    fn log_activity(&self) -> bool {
        true
    }
}

/// An observer that hears nothing.
pub struct Unobserved;
impl RunObserver for Unobserved {}

/// The claim and the pull gate (D8, stage 33d3).
pub trait RunGate: Send + Sync {
    /// Returns once this device may pull: sync completed a pull and the vault is indexed.
    fn await_ready(&self, _cancel: &CancellationToken) -> Result<(), RunError> {
        Ok(())
    }
    /// Read before each book: true once another device holds the claim.
    fn claim_lost(&self) -> bool {
        false
    }
    /// The run stopped because the claim moved.
    fn on_claim_lost(&self) {}
}

/// No gate: every run may pull.
pub struct Ungated;
impl RunGate for Ungated {}

/// `RunResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunResult {
    pub cancelled: bool,
    /// Another device took Readwise over, so the run stopped at the next book (D8).
    pub claim_lost: bool,
    pub counts: RunCounts,
}

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("A Readwise run is already in progress")]
    AlreadyRunning,
    #[error(transparent)]
    Readwise(#[from] ReadwiseError),
    #[error("{0}")]
    Failed(String),
}

pub(crate) fn failed(error: impl std::fmt::Display) -> RunError {
    RunError::Failed(error.to_string())
}

/// `Intl.DateTimeFormat().resolvedOptions().timeZone`. An unknown zone fails the run, as
/// `Intl` throws `RangeError`, rather than write days in another zone.
pub fn system_time_zone() -> Result<Tz, String> {
    let name = iana_time_zone::get_timezone().map_err(|error| error.to_string())?;
    name.parse::<Tz>()
        .map_err(|_| format!("Unknown time zone {name}"))
}
