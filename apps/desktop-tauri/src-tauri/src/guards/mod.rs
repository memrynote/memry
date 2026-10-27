//! Crash and failure guards: native minidumps, the GPU fallback, the main-thread stall monitor
//! and the report of webview process failures. Each is registered at boot, in the `Guards`
//! stage, so it is armed before any window exists.

pub mod crash_dump;
pub mod gpu;
pub mod process_gone;
pub mod stall;

use crate::startup::{self, Stage};

pub fn register_stages() {
    startup::register(Stage::Guards, "start crash dumps", crash_dump::start);
    startup::register(Stage::Guards, "apply gpu guard", gpu::apply);
    startup::register(Stage::Guards, "start stall monitor", stall::start);
    startup::register(Stage::Handlers, "report gpu guard", gpu::report);
}
