//! The WebView2 runtime check at boot (`memry_desktop::updater::webview2`), in the `Guards`
//! stage before the crash monitor starts and long before the first window. A launch without the
//! runtime runs the bootstrapper the pack put beside the executable. One that still has no
//! runtime tells the user where to get it and exits with code 1, since no window could open.

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use memry_desktop::i18n::{self, Arg, Args};
use memry_desktop::locale;
use memry_desktop::paths::AppPaths;
use memry_desktop::telemetry::TelemetryEvent;
use memry_desktop::telemetry::service::Service as Telemetry;
use memry_desktop::updater::webview2::{self, BOOTSTRAPPER, DOWNLOAD_URL, Outcome, Runtime};
use tauri::{AppHandle, Manager, Wry};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::{CREATE_NO_WINDOW, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumThreadWindows, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MB_RIGHT, MB_RTLREADING,
    MB_SETFOREGROUND, MB_YESNO, MESSAGEBOX_STYLE, MessageBoxW, PostMessageW, WM_CLOSE,
};
use windows::core::{BOOL, HSTRING};
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

/// This machine, with the copy of the notice shown while the bootstrapper runs.
struct Machine {
    notice: Notice,
}

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

    fn loader_version(&self) -> Option<String> {
        tauri::webview_version().ok()
    }

    fn run_bootstrapper(&self, path: &Path) -> Result<(), String> {
        let mut command = Command::new(path);
        // Unelevated, `/silent /install` installs the runtime for this user with no prompt.
        command
            .args(["/silent", "/install"])
            .creation_flags(CREATE_NO_WINDOW.0);
        // The silent install shows nothing for up to two minutes, so the user learns why the app
        // has not opened yet.
        let notice = self.notice.show();
        let result = run(command, BOOTSTRAPPER_DEADLINE);
        let _ = notice.close();
        result
    }
}

/// A native message box with an OK button, on a thread of its own, so it stays up while this
/// thread waits. Dismissing it early changes nothing.
struct Notice {
    title: String,
    body: String,
    style: MESSAGEBOX_STYLE,
}

struct OpenNotice {
    thread: JoinHandle<()>,
    thread_id: Option<u32>,
}

impl Notice {
    fn show(&self) -> OpenNotice {
        let (title, body, style) = (self.title.clone(), self.body.clone(), self.style);
        let (id_sender, id) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            // SAFETY: plain query of the calling thread.
            let _ = id_sender.send(unsafe { GetCurrentThreadId() });
            // SAFETY: both strings outlive the call, and no owner window is passed.
            unsafe { MessageBoxW(None, &HSTRING::from(body), &HSTRING::from(title), style) };
        });
        OpenNotice {
            thread,
            thread_id: id.recv().ok(),
        }
    }
}

impl OpenNotice {
    /// Closes the box, which may not be on screen yet: asked again until its thread ends.
    /// Returns whether it closed.
    fn close(self) -> bool {
        unsafe extern "system" fn post_close(window: HWND, _: LPARAM) -> BOOL {
            // SAFETY: a window of the notice's thread; a stale handle only fails the post.
            let _ = unsafe { PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0)) };
            BOOL::from(true)
        }
        if let Some(thread_id) = self.thread_id {
            for _ in 0..100 {
                // SAFETY: the callback only posts a message to each window of that thread.
                let _ = unsafe { EnumThreadWindows(thread_id, Some(post_close), LPARAM(0)) };
                if self.thread.is_finished() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        tracing::warn!(
            scope = "WebView2",
            "the installing notice did not close; it stays until dismissed"
        );
        false
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
    // The config is not loaded yet, so the copy follows the OS language.
    let locale = preboot::locale(app);
    let machine = Machine {
        notice: Notice {
            title: "MemryNote".to_owned(),
            body: i18n::t(
                locale,
                "system:startup.webview2Installing.body",
                &Args::new(),
            ),
            style: MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | direction(locale),
        },
    };
    settle(
        webview2::ensure(&machine, &bootstrapper),
        |event| {
            if crate::shell::services::telemetry_enabled(app) {
                // The telemetry service starts later in this boot, or at the next launch when
                // this one ends here; either way it sends what the journal holds.
                Telemetry::queue_for_next_launch(&app.state::<AppPaths>().data_dir, event);
            }
        },
        |outcome| tell_user(app, locale, outcome),
        |code| app.exit(code),
    );
    Ok(())
}

/// What the launch does with the outcome: report it, and end the boot with code 1 when no window
/// can open, once the user knows why.
fn settle(
    outcome: Outcome,
    queue: impl FnOnce(TelemetryEvent),
    tell_user: impl FnOnce(Outcome),
    exit: impl FnOnce(i32),
) {
    if let Some(event) = outcome.event() {
        queue(event);
    }
    if outcome.starts() {
        return;
    }
    tell_user(outcome);
    startup::halt_boot();
    exit(1);
}

fn direction(locale: &str) -> MESSAGEBOX_STYLE {
    if locale::direction(locale) == "rtl" {
        MB_RTLREADING | MB_RIGHT
    } else {
        MESSAGEBOX_STYLE(0)
    }
}

/// A native message box: the app has no window, and cannot make one. The copy ends with a
/// question, so the OS's own Yes and No need no naming in it. It says an install was tried only
/// when one was.
fn tell_user(app: &AppHandle<Wry>, locale: &'static str, outcome: Outcome) {
    let mut args = Args::new();
    args.insert("url".to_owned(), Arg::from(DOWNLOAD_URL));
    let title = i18n::t(locale, "system:startup.webview2Missing.title", &Args::new());
    let body = if outcome == Outcome::InstallFailed {
        i18n::t(
            locale,
            "system:startup.webview2Missing.bodyInstallFailed",
            &args,
        )
    } else {
        i18n::t(locale, "system:startup.webview2Missing.body", &args)
    };
    let style = MB_YESNO | MB_ICONERROR | MB_SETFOREGROUND | direction(locale);
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

    fn machine() -> Machine {
        Machine {
            notice: Notice {
                title: "MemryNote".to_owned(),
                body: "test".to_owned(),
                style: MB_OK,
            },
        }
    }

    #[test]
    fn this_machine_reports_its_runtime() {
        // Every supported Windows, and every CI runner, has the runtime.
        let machine = machine();
        assert!(
            machine
                .versions()
                .iter()
                .any(|pv| webview2::is_installed_version(pv)),
            "{:?}",
            machine.versions()
        );
        assert!(machine.loader_version().is_some());
    }

    /// One test, since the halted boot is process-wide: a launch that can open its window boots
    /// on, and one that cannot tells the user, ends the boot and exits with code 1.
    #[test]
    fn only_a_launch_without_a_runtime_tells_the_user_ends_the_boot_and_exits_1() {
        let calls = std::cell::RefCell::new(Vec::new());
        let run = |outcome| {
            calls.borrow_mut().clear();
            settle(
                outcome,
                |event| {
                    calls
                        .borrow_mut()
                        .push(format!("queue {}", event.error_code.unwrap_or_default()))
                },
                |told| calls.borrow_mut().push(format!("tell {}", told.code())),
                |code| calls.borrow_mut().push(format!("exit {code}")),
            );
            calls.borrow().clone()
        };
        assert!(run(Outcome::Present).is_empty());
        assert_eq!(run(Outcome::Installed), ["queue "]);
        assert!(!startup::boot_halted());
        assert_eq!(
            run(Outcome::Missing),
            ["queue WEBVIEW2_MISSING", "tell WEBVIEW2_MISSING", "exit 1"]
        );
        assert!(startup::boot_halted());
        assert_eq!(
            run(Outcome::InstallFailed),
            [
                "queue WEBVIEW2_INSTALL_FAILED",
                "tell WEBVIEW2_INSTALL_FAILED",
                "exit 1"
            ]
        );
    }

    #[test]
    fn the_installing_notice_closes_when_the_bootstrapper_ends() {
        let open = machine().notice.show();
        std::thread::sleep(Duration::from_millis(200));
        assert!(open.close());
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
