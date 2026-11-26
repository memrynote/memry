//! The shell's one registration of its [`DiagnosticsSink`] (#5215).
//!
//! A process-global rather than a parameter of every sync call, because the
//! shell wires it once at launch and every vault's sync reports to it. It is
//! read only here, by the API layer, which hands the run an explicit
//! [`RunDiagnostics`]: the sync internals and their tests never touch the
//! global. With nothing registered a run is silent.

use std::sync::{Arc, RwLock};

use crate::seams::diagnostics::DiagnosticsSink;
use crate::sync::diagnostics::RunDiagnostics;

static SINK: RwLock<Option<Arc<dyn DiagnosticsSink>>> = RwLock::new(None);

/// Registers the shell's sink, replacing any earlier one. Call it once, at
/// launch, before the first sync.
#[uniffi::export]
pub fn set_diagnostics_sink(sink: Arc<dyn DiagnosticsSink>) {
    *SINK
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sink);
}

/// The recorder for one sync run: reports to the registered sink, or is
/// silent when the shell registered none.
pub(crate) fn run_diagnostics() -> Arc<RunDiagnostics> {
    let sink = SINK
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    sink.map_or_else(RunDiagnostics::silent, RunDiagnostics::new)
}
