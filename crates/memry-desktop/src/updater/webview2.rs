//! The WebView2 runtime check of a Windows launch, before any webview exists. Velopack's Setup
//! installs the runtime (`--framework webview2`), so a missing one was removed afterwards. The
//! app then runs the Microsoft bootstrapper it ships beside its executable, and starts only once
//! the runtime is there. Step 44 (#3561) reads the outcome codes in telemetry.

use std::path::Path;

use crate::telemetry::TelemetryEvent;
use crate::telemetry::service::Service as Telemetry;

/// The bootstrapper, relative to the executable's directory. The pack step puts it there
/// (`scripts/release/webview2-bootstrapper.mjs`).
pub const BOOTSTRAPPER: &str = "webview2/MicrosoftEdgeWebview2Setup.exe";

/// Microsoft's download of the same bootstrapper, for the user to run by hand.
pub const DOWNLOAD_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Present,
    /// The bootstrapper installed it on this launch.
    Installed,
    /// The bootstrapper ran and the runtime is still missing.
    InstallFailed,
    /// The runtime is missing and the bootstrapper file is not there.
    Missing,
}

impl Outcome {
    pub fn code(self) -> &'static str {
        match self {
            Self::Present => "WEBVIEW2_PRESENT",
            Self::Installed => "WEBVIEW2_INSTALLED",
            Self::InstallFailed => "WEBVIEW2_INSTALL_FAILED",
            Self::Missing => "WEBVIEW2_MISSING",
        }
    }

    /// Whether the app can create its window.
    pub fn starts(self) -> bool {
        matches!(self, Self::Present | Self::Installed)
    }

    /// What telemetry learns of it; nothing on the normal launch.
    pub fn event(self) -> Option<TelemetryEvent> {
        let (name, result) = match self {
            Self::Present => return None,
            Self::Installed => ("app_update_installed", "success"),
            Self::InstallFailed | Self::Missing => ("app_error_seen", "failed"),
        };
        let mut event = Telemetry::event(name, "updater", "webview2");
        event.source = Some("updater".to_owned());
        event.result = Some(result.to_owned());
        if !self.starts() {
            event.object_type = Some("exception".to_owned());
            event.error_code = Some(self.code().to_owned());
        }
        Some(event)
    }
}

/// The machine, as the check sees it.
pub trait Runtime {
    /// The `pv` value of each EdgeUpdate client key of the runtime that has one.
    fn versions(&self) -> Vec<String>;
    /// Runs the bootstrapper until it exits or its deadline passes.
    fn run_bootstrapper(&self, path: &Path) -> Result<(), String>;
}

/// Microsoft's rule for the `pv` value: an installed runtime has a version above `0.0.0.0`.
/// An uninstall can leave the key behind with `0.0.0.0` or an empty value.
pub fn is_installed_version(pv: &str) -> bool {
    let parts: Option<Vec<u32>> = pv.trim().split('.').map(|part| part.parse().ok()).collect();
    parts.is_some_and(|parts| parts.iter().any(|&part| part > 0))
}

fn installed(runtime: &impl Runtime) -> Option<String> {
    runtime
        .versions()
        .into_iter()
        .find(|pv| is_installed_version(pv))
}

/// Finds the runtime, and installs it with `bootstrapper` when it is missing.
pub fn ensure(runtime: &impl Runtime, bootstrapper: &Path) -> Outcome {
    if let Some(version) = installed(runtime) {
        tracing::info!(
            scope = "WebView2",
            "{}: runtime {version}",
            Outcome::Present.code()
        );
        return Outcome::Present;
    }
    if !bootstrapper.is_file() {
        tracing::error!(
            scope = "WebView2",
            "{}: no runtime and no bootstrapper at {}",
            Outcome::Missing.code(),
            bootstrapper.display()
        );
        return Outcome::Missing;
    }
    tracing::warn!(scope = "WebView2", "no runtime; running the bootstrapper");
    // The runtime is detected again either way: a bootstrapper can fail after the runtime
    // landed, or another installer can finish it meanwhile.
    if let Err(error) = runtime.run_bootstrapper(bootstrapper) {
        tracing::warn!(scope = "WebView2", "bootstrapper failed: {error}");
    }
    match installed(runtime) {
        Some(version) => {
            tracing::info!(
                scope = "WebView2",
                "{}: runtime {version}",
                Outcome::Installed.code()
            );
            Outcome::Installed
        }
        None => {
            tracing::error!(
                scope = "WebView2",
                "{}: still no runtime after the bootstrapper",
                Outcome::InstallFailed.code()
            );
            Outcome::InstallFailed
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::path::PathBuf;

    use super::*;

    /// A machine whose runtime appears once the bootstrapper ran, if `installs`.
    struct Machine {
        versions: RefCell<Vec<String>>,
        installs: Vec<String>,
        fails: bool,
        runs: Cell<usize>,
    }

    impl Machine {
        fn new(versions: &[&str], installs: &[&str], fails: bool) -> Self {
            let owned = |list: &[&str]| list.iter().map(|v| (*v).to_owned()).collect();
            Self {
                versions: RefCell::new(owned(versions)),
                installs: owned(installs),
                fails,
                runs: Cell::new(0),
            }
        }
    }

    impl Runtime for Machine {
        fn versions(&self) -> Vec<String> {
            self.versions.borrow().clone()
        }

        fn run_bootstrapper(&self, _path: &Path) -> Result<(), String> {
            self.runs.set(self.runs.get() + 1);
            self.versions.borrow_mut().extend(self.installs.clone());
            if self.fails {
                Err("exit code 0x80040c01".to_owned())
            } else {
                Ok(())
            }
        }
    }

    fn bootstrapper(dir: &tempfile::TempDir) -> PathBuf {
        let path = dir.path().join("MicrosoftEdgeWebview2Setup.exe");
        std::fs::write(&path, b"MZ").expect("write");
        path
    }

    #[test]
    fn only_a_version_above_zero_counts_as_installed() {
        for pv in ["131.0.2903.70", "0.0.0.1", " 1.0 "] {
            assert!(is_installed_version(pv), "{pv}");
        }
        for pv in ["", "0.0.0.0", "0", "abc", "1..2", "-1.0.0.0", "1.0.0.x"] {
            assert!(!is_installed_version(pv), "{pv}");
        }
    }

    #[test]
    fn an_installed_runtime_never_runs_the_bootstrapper() {
        let dir = tempfile::tempdir().expect("tmp");
        // The HKLM key of an uninstalled runtime, then the HKCU one of the live install.
        let machine = Machine::new(&["0.0.0.0", "131.0.2903.70"], &[], false);
        assert_eq!(ensure(&machine, &bootstrapper(&dir)), Outcome::Present);
        assert_eq!(machine.runs.get(), 0);
    }

    #[test]
    fn a_missing_runtime_is_installed_and_detected_again() {
        let dir = tempfile::tempdir().expect("tmp");
        let machine = Machine::new(&["0.0.0.0"], &["131.0.2903.70"], false);
        assert_eq!(ensure(&machine, &bootstrapper(&dir)), Outcome::Installed);
        assert_eq!(machine.runs.get(), 1);

        // A bootstrapper that reports a failure after the runtime landed still starts the app.
        let machine = Machine::new(&[], &["131.0.2903.70"], true);
        assert_eq!(ensure(&machine, &bootstrapper(&dir)), Outcome::Installed);
    }

    #[test]
    fn a_runtime_still_missing_after_the_bootstrapper_stops_the_launch() {
        let dir = tempfile::tempdir().expect("tmp");
        for fails in [false, true] {
            let machine = Machine::new(&[], &[], fails);
            let outcome = ensure(&machine, &bootstrapper(&dir));
            assert_eq!(outcome, Outcome::InstallFailed);
            assert!(!outcome.starts());
        }
    }

    #[test]
    fn no_bootstrapper_file_is_missing_without_running_anything() {
        let dir = tempfile::tempdir().expect("tmp");
        let machine = Machine::new(&[], &["131.0.2903.70"], false);
        let outcome = ensure(&machine, &dir.path().join(BOOTSTRAPPER));
        assert_eq!(outcome, Outcome::Missing);
        assert!(!outcome.starts());
        assert_eq!(machine.runs.get(), 0);
    }

    #[test]
    fn each_outcome_reports_its_code() {
        assert_eq!(Outcome::Present.event(), None);
        let installed = Outcome::Installed.event().expect("event");
        assert_eq!(
            (installed.name.as_str(), installed.action.as_str()),
            ("app_update_installed", "webview2")
        );
        assert_eq!(installed.result.as_deref(), Some("success"));
        assert_eq!(installed.error_code, None);
        assert!(installed.is_known());
        for outcome in [Outcome::InstallFailed, Outcome::Missing] {
            let event = outcome.event().expect("event");
            assert_eq!(event.name, "app_error_seen");
            assert_eq!(event.error_code.as_deref(), Some(outcome.code()));
            assert_eq!(event.result.as_deref(), Some("failed"));
            assert!(event.is_known());
        }
    }
}
