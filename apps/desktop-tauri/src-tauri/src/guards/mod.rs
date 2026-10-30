//! Crash and failure guards: native minidumps, the GPU fallback, the main-thread stall monitor
//! and the report of webview process failures. Each is registered at boot, in the `Guards`
//! stage, so it is armed before any window exists.

pub mod crash_dump;
pub mod gpu;
pub mod process_gone;
pub mod stall;

use tauri::Wry;

use crate::startup::{self, Stage, StageFn};

/// The `Guards` stage in its order. The stage runs before any window, and a guard that halts the
/// boot stops every later registration.
fn guards() -> Vec<(&'static str, StageFn<Wry>)> {
    vec![
        // First: on macOS it may end the boot before anything of the old bundle starts.
        (
            "updater relaunch guard",
            crate::updater::relaunch_guard::apply,
        ),
        // Windows: a launch without WebView2 installs it here, or ends before anything else
        // starts.
        #[cfg(windows)]
        ("check webview2 runtime", crate::updater::webview2::apply),
        ("start crash dumps", crash_dump::start),
        ("apply gpu guard", gpu::apply),
        ("start stall monitor", stall::start),
    ]
}

pub fn register_stages() {
    for (name, guard) in guards() {
        startup::register(Stage::Guards, name, guard);
    }
    startup::register(Stage::Handlers, "report gpu guard", gpu::report);
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_launch_checks_webview2_after_the_relaunch_guard_and_before_any_other_guard() {
        let names: Vec<_> = super::guards().into_iter().map(|(name, _)| name).collect();
        let expected: &[&str] = if cfg!(windows) {
            &["updater relaunch guard", "check webview2 runtime"]
        } else {
            &["updater relaunch guard"]
        };
        assert_eq!(&names[..expected.len()], expected);
        assert_eq!(
            names
                .iter()
                .filter(|name| **name == "check webview2 runtime")
                .count(),
            usize::from(cfg!(windows))
        );
    }
}
