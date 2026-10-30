//! The WebView2 runtime check at boot (`memry_desktop::updater::webview2`), in the `Guards`
//! stage before the crash monitor starts and long before the first window. A launch without the
//! runtime runs the bootstrapper the pack put beside the executable. One that still has no
//! runtime tells the user where to get it and exits with code 1, since no window could open.

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use memry_desktop::i18n::{self, Arg, Args};
use memry_desktop::locale;
use memry_desktop::paths::AppPaths;
use memry_desktop::telemetry::service::Service as Telemetry;
use memry_desktop::updater::webview2::{self, BOOTSTRAPPER, DOWNLOAD_URL, Runtime};
use tauri::{AppHandle, Manager, Wry};
use windows::Win32::System::Threading::CREATE_NO_WINDOW;
use windows::Win32::UI::WindowsAndMessaging::{
    IDYES, MB_ICONERROR, MB_RIGHT, MB_RTLREADING, MB_SETFOREGROUND, MB_YESNO, MessageBoxW,
};
use windows::core::HSTRING;
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

use crate::commands::error::CommandError;
use crate::startup;
use crate::windows::preboot;

/// The runtime's EdgeUpdate client key. Microsoft's detection order: the per-machine install of
/// a 64-bit system, of a 32-bit one, then the per-user install.
const CLIENT_KEY: &str = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const CLIENT_KEYS: [(winreg::HKEY, &str); 3] = [
    (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\"),
    (HKEY_LOCAL_MACHINE, r"SOFTWARE\"),
    (HKEY_CURRENT_USER, r"Software\"),
];

/// How long the bootstrapper may take to download and install the runtime.
const BOOTSTRAPPER_DEADLINE: Duration = Duration::from_secs(120);

struct Machine;

impl Runtime for Machine {
    fn versions(&self) -> Vec<String> {
        CLIENT_KEYS
            .iter()
            .filter_map(|(hive, prefix)| {
                RegKey::predef(*hive)
                    .open_subkey(format!("{prefix}{CLIENT_KEY}"))
                    .ok()?
                    .get_value::<String, _>("pv")
                    .ok()
            })
            .collect()
    }

    fn run_bootstrapper(&self, path: &Path) -> Result<(), String> {
        let mut command = Command::new(path);
        // Unelevated, `/silent /install` installs the runtime for this user with no prompt.
        command
            .args(["/silent", "/install"])
            .creation_flags(CREATE_NO_WINDOW.0);
        run(command, BOOTSTRAPPER_DEADLINE)
    }
}

/// Runs `command` to its end, or kills it at `deadline`.
fn run(mut command: Command, deadline: Duration) -> Result<(), String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("not started: {error}"))?;
    let until = Instant::now() + deadline;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            // The bootstrapper exits with an HRESULT.
            Ok(Some(status)) => {
                return Err(status.code().map_or_else(
                    || status.to_string(),
                    |code| format!("exit code {:#010x}", code as u32),
                ));
            }
            Ok(None) if Instant::now() >= until => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("still running after {} s", deadline.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(error) => return Err(format!("wait failed: {error}")),
        }
    }
}

pub fn apply(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let bootstrapper = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(BOOTSTRAPPER)))
        .unwrap_or_default();
    let outcome = webview2::ensure(&Machine, &bootstrapper);
    if let Some(event) = outcome.event()
        && crate::shell::services::telemetry_enabled(app)
    {
        // The telemetry service starts later in this boot, or at the next launch when this one
        // ends here; either way it sends what the journal holds.
        Telemetry::queue_for_next_launch(&app.state::<AppPaths>().data_dir, event);
    }
    if outcome.starts() {
        return Ok(());
    }
    tell_user(app);
    startup::halt_boot();
    app.exit(1);
    Ok(())
}

/// A native message box: the app has no window, and cannot make one. The copy ends with a
/// question, so the OS's own Yes and No need no naming in it.
fn tell_user(app: &AppHandle<Wry>) {
    // The config is not loaded yet, so the copy follows the OS language.
    let locale = preboot::locale(app);
    let mut args = Args::new();
    args.insert("url".to_owned(), Arg::from(DOWNLOAD_URL));
    let title = i18n::t(locale, "system:startup.webview2Missing.title", &Args::new());
    let body = i18n::t(locale, "system:startup.webview2Missing.body", &args);
    let mut style = MB_YESNO | MB_ICONERROR | MB_SETFOREGROUND;
    if locale::direction(locale) == "rtl" {
        style |= MB_RTLREADING | MB_RIGHT;
    }
    // SAFETY: both strings outlive the call, and no owner window is passed.
    let choice = unsafe { MessageBoxW(None, &HSTRING::from(body), &HSTRING::from(title), style) };
    if choice == IDYES
        && let Err(error) = crate::shell::external::open_url(app, DOWNLOAD_URL)
    {
        tracing::warn!(
            scope = "WebView2",
            "download page not opened: {}",
            error.message
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_machine_reports_its_runtime() {
        // Every supported Windows, and every CI runner, has the runtime.
        assert!(
            Machine
                .versions()
                .iter()
                .any(|pv| webview2::is_installed_version(pv)),
            "{:?}",
            Machine.versions()
        );
    }

    #[test]
    fn a_bootstrapper_past_its_deadline_is_stopped() {
        // Ping runs for about 30 s; only a kill at the deadline returns this error.
        let mut command = Command::new("ping");
        command
            .args(["-n", "30", "127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW.0);
        let result = run(command, Duration::from_secs(1));
        assert_eq!(result, Err("still running after 1 s".to_owned()));
    }

    #[test]
    fn a_failing_bootstrapper_reports_its_exit_code() {
        let mut command = Command::new("cmd");
        command
            .args(["/c", "exit", "-2147218431"])
            .creation_flags(CREATE_NO_WINDOW.0);
        assert_eq!(
            run(command, Duration::from_secs(30)),
            Err("exit code 0x80040c01".to_owned())
        );
    }
}
