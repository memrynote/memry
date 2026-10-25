//! Test-only launch seams of the e2e build: the run-time gate and the per-instance control
//! file. Nothing here touches `tauri`; the e2e build of `memry-tauri` calls it.

pub mod control;
mod gate;

pub use gate::{E2E_VAR, E2eGate};
