//! The WebView2 runtime check of a Windows launch, before the Tauri runtime exists. Velopack's
//! Setup installs the runtime (`--framework webview2`), so a missing one was removed afterwards.
//! The app then runs the Microsoft bootstrapper it ships beside its executable, and starts only
//! once the runtime is there. Step 44 (#3561) reads the outcome codes in telemetry.
//!
//! The check runs in `main`, before the Tauri runtime is built: `tauri-runtime-wry` asks for the
//! runtime once, in `Wry::init`, and refuses every webview of a process whose answer was no, even
//! after the bootstrapper installed it (#3915). Logging starts later, inside the runtime, so
//! [`ensure`] returns a [`Check`] that the launch logs and reports once it can.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

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
    /// The version the WebView2 loader finds, which the window will use. Besides the Evergreen
    /// runtime the registry names, it finds a Fixed Version runtime the environment points at, and
    /// a Beta, Dev or Canary Edge a policy allows.
    fn loader_version(&self) -> Option<String>;
    /// Runs the bootstrapper until it exits or its deadline passes.
    fn run_bootstrapper(&self, path: &Path) -> Result<(), String>;
}

/// Microsoft's rule for the `pv` value: an installed runtime has a version above `0.0.0.0`.
/// An uninstall can leave the key behind with `0.0.0.0` or an empty value.
pub fn is_installed_version(pv: &str) -> bool {
    let parts: Option<Vec<u32>> = pv.trim().split('.').map(|part| part.parse().ok()).collect();
    parts.is_some_and(|parts| parts.iter().any(|&part| part > 0))
}

/// What the check found and did, for the launch to log and report once logging runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub outcome: Outcome,
    /// The runtime version the window will use, when there is one.
    pub version: Option<String>,
    /// Only the WebView2 loader found it: a Fixed Version runtime or an allowed Edge channel.
    pub found_by_loader: bool,
    pub bootstrapper: PathBuf,
    /// How long the bootstrapper ran, when it ran.
    pub bootstrapper_ran: Option<Duration>,
    pub bootstrapper_error: Option<String>,
    /// Why the check ran without the lock that keeps a second launch from installing at the same
    /// time. The caller sets it.
    pub lock_warning: Option<String>,
    /// The installing notice was still on screen after the bootstrapper ended. The caller sets it.
    pub notice_stuck: bool,
}

impl Check {
    /// The lines `ensure` would have logged had logging been running.
    pub fn log(&self) {
        let code = self.outcome.code();
        let version = self.version.as_deref().unwrap_or_default();
        if self.found_by_loader {
            tracing::info!(
                scope = "WebView2",
                "no Evergreen runtime in the registry; the WebView2 loader finds {version}"
            );
        }
        if let Some(ran) = self.bootstrapper_ran {
            tracing::warn!(
                scope = "WebView2",
                "no runtime; the bootstrapper ran for {} s before the window runtime started",
                ran.as_secs()
            );
        }
        if let Some(error) = &self.bootstrapper_error {
            tracing::warn!(scope = "WebView2", "bootstrapper failed: {error}");
        }
        if self.notice_stuck {
            tracing::warn!(
                scope = "WebView2",
                "the installing notice did not close; it stays until dismissed"
            );
        }
        if let Some(warning) = &self.lock_warning {
            tracing::warn!(scope = "WebView2", "{warning}");
        }
        match self.outcome {
            Outcome::Present | Outcome::Installed => {
                tracing::info!(scope = "WebView2", "{code}: runtime {version}");
            }
            Outcome::Missing => tracing::error!(
                scope = "WebView2",
                "{code}: no runtime and no bootstrapper at {}",
                self.bootstrapper.display()
            ),
            Outcome::InstallFailed => tracing::error!(
                scope = "WebView2",
                "{code}: still no runtime after the bootstrapper"
            ),
        }
    }
}

/// The registry first, as Microsoft documents it; the loader for every runtime it does not list.
/// The flag is true when only the loader found it.
fn installed(runtime: &impl Runtime) -> Option<(String, bool)> {
    runtime
        .versions()
        .into_iter()
        .find(|pv| is_installed_version(pv))
        .map(|pv| (pv, false))
        .or_else(|| runtime.loader_version().map(|version| (version, true)))
}

/// Finds the runtime, and installs it with `bootstrapper` when it is missing.
pub fn ensure(runtime: &impl Runtime, bootstrapper: &Path) -> Check {
    let mut check = Check {
        outcome: Outcome::Present,
        version: None,
        found_by_loader: false,
        bootstrapper: bootstrapper.to_owned(),
        bootstrapper_ran: None,
        bootstrapper_error: None,
        lock_warning: None,
        notice_stuck: false,
    };
    if let Some((version, by_loader)) = installed(runtime) {
        check.version = Some(version);
        check.found_by_loader = by_loader;
        return check;
    }
    if !bootstrapper.is_file() {
        check.outcome = Outcome::Missing;
        return check;
    }
    // The runtime is detected again either way: a bootstrapper can fail after the runtime
    // landed, or another installer can finish it meanwhile.
    let started = Instant::now();
    check.bootstrapper_error = runtime.run_bootstrapper(bootstrapper).err();
    check.bootstrapper_ran = Some(started.elapsed());
    match installed(runtime) {
        Some((version, by_loader)) => {
            check.outcome = Outcome::Installed;
            check.version = Some(version);
            check.found_by_loader = by_loader;
        }
        None => check.outcome = Outcome::InstallFailed,
    }
    check
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
        loader: Option<String>,
        runs: Cell<usize>,
    }

    impl Machine {
        fn new(versions: &[&str], installs: &[&str], fails: bool) -> Self {
            let owned = |list: &[&str]| list.iter().map(|v| (*v).to_owned()).collect();
            Self {
                versions: RefCell::new(owned(versions)),
                installs: owned(installs),
                fails,
                loader: None,
                runs: Cell::new(0),
            }
        }
    }

    impl Runtime for Machine {
        fn versions(&self) -> Vec<String> {
            self.versions.borrow().clone()
        }

        fn loader_version(&self) -> Option<String> {
            self.loader.clone()
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
        let check = ensure(&machine, &bootstrapper(&dir));
        assert_eq!(check.outcome, Outcome::Present);
        assert_eq!(check.version.as_deref(), Some("131.0.2903.70"));
        assert_eq!(check.bootstrapper_ran, None);
        assert_eq!(machine.runs.get(), 0);
    }

    /// A Fixed Version runtime, or an Edge channel a policy allows: the window opens with it.
    #[test]
    fn a_runtime_only_the_loader_finds_starts_the_app_without_the_bootstrapper() {
        let dir = tempfile::tempdir().expect("tmp");
        let machine = Machine {
            loader: Some("132.0.2957.11".to_owned()),
            ..Machine::new(&["0.0.0.0"], &[], true)
        };
        let check = ensure(&machine, &bootstrapper(&dir));
        assert_eq!(check.outcome, Outcome::Present);
        assert!(check.found_by_loader);
        assert_eq!(
            ensure(&machine, &dir.path().join("none.exe")).outcome,
            Outcome::Present
        );
        assert_eq!(machine.runs.get(), 0);
    }

    #[test]
    fn a_missing_runtime_is_installed_and_detected_again() {
        let dir = tempfile::tempdir().expect("tmp");
        let machine = Machine::new(&["0.0.0.0"], &["131.0.2903.70"], false);
        let check = ensure(&machine, &bootstrapper(&dir));
        assert_eq!(check.outcome, Outcome::Installed);
        assert_eq!(check.version.as_deref(), Some("131.0.2903.70"));
        assert!(check.bootstrapper_ran.is_some());
        assert_eq!(check.bootstrapper_error, None);
        assert_eq!(machine.runs.get(), 1);

        // A bootstrapper that reports a failure after the runtime landed still starts the app.
        let machine = Machine::new(&[], &["131.0.2903.70"], true);
        let check = ensure(&machine, &bootstrapper(&dir));
        assert_eq!(check.outcome, Outcome::Installed);
        assert_eq!(
            check.bootstrapper_error.as_deref(),
            Some("exit code 0x80040c01")
        );
    }

    #[test]
    fn a_runtime_still_missing_after_the_bootstrapper_stops_the_launch() {
        let dir = tempfile::tempdir().expect("tmp");
        for fails in [false, true] {
            let machine = Machine::new(&[], &[], fails);
            let outcome = ensure(&machine, &bootstrapper(&dir)).outcome;
            assert_eq!(outcome, Outcome::InstallFailed);
            assert!(!outcome.starts());
        }
    }

    #[test]
    fn no_bootstrapper_file_is_missing_without_running_anything() {
        let dir = tempfile::tempdir().expect("tmp");
        let machine = Machine::new(&[], &["131.0.2903.70"], false);
        let check = ensure(&machine, &dir.path().join(BOOTSTRAPPER));
        assert_eq!(check.bootstrapper, dir.path().join(BOOTSTRAPPER));
        let outcome = check.outcome;
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
