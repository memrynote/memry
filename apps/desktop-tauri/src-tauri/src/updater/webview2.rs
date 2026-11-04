//! The WebView2 runtime check at launch (`memry_desktop::updater::webview2`). `main` runs it
//! before the Tauri runtime is built, since `tauri-runtime-wry` asks for the runtime only then
//! and refuses every webview of a process whose answer was no (#3915). A launch without the
//! runtime runs the bootstrapper the pack put beside the executable there. The `Guards` stage,
//! once logging runs, logs and reports the result, and a launch that still has no runtime tells
//! the user where to get it and exits with code 1, since no window could open.
//!
//! The check runs before the single-instance hand-off, so a named mutex makes a second launch
//! wait for the first one's install. It then finds the runtime and hands off to the first launch,
//! instead of running a second bootstrapper whose failure would show a false error.

use std::cell::{Cell, RefCell};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::sync::{OnceLock, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use memry_desktop::i18n::{self, Arg, Args};
use memry_desktop::locale;
use memry_desktop::paths::AppPaths;
use memry_desktop::telemetry::TelemetryEvent;
use memry_desktop::telemetry::service::Service as Telemetry;
use memry_desktop::updater::webview2::{self, BOOTSTRAPPER, Check, DOWNLOAD_URL, Outcome, Runtime};
use tauri::{AppHandle, Manager, Wry};
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, HWND, LPARAM, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT, WPARAM,
};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CreateMutexW, GetCurrentThreadId, ReleaseMutex, WaitForSingleObject,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumThreadWindows, GetClassNameW, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MB_RIGHT,
    MB_RTLREADING, MB_SETFOREGROUND, MB_YESNO, MESSAGEBOX_STYLE, MessageBoxW, PostMessageW,
    WM_CLOSE,
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

/// What `main` found before the Tauri runtime existed.
static CHECK: OnceLock<Check> = OnceLock::new();

/// One check at a time per user session. An unelevated bootstrapper installs the runtime for the
/// user, and the single-instance mutex of the Tauri plugin is per session too.
const INSTALL_LOCK: &str = r"Local\MemryNote-WebView2";

/// The longest a launch holds the lock: the bootstrapper's deadline, the checks around it and
/// the boot up to the `Guards` stage.
const INSTALL_LOCK_WAIT: Duration = Duration::from_secs(BOOTSTRAPPER_DEADLINE.as_secs() + 30);

thread_local! {
    /// The lock `check_before_runtime` took on the main thread. `apply` releases it on the same
    /// thread, once the single-instance plugin holds its own mutex, so a launch that waited hands
    /// off to this one instead of racing it to the plugin's mutex. A process that ends before
    /// that leaves the lock abandoned, which the next waiter takes.
    static HELD_LOCK: RefCell<Option<InstallLock>> = const { RefCell::new(None) };
}

/// A named mutex this thread owns, released when dropped.
struct InstallLock(HANDLE);

impl InstallLock {
    /// Waits up to `wait` for `name`. `Err` says why the launch goes on without it.
    fn acquire(name: &str, wait: Duration) -> Result<Self, String> {
        // SAFETY: no security attributes, and the name outlives the call.
        let handle = unsafe { CreateMutexW(None, false, &HSTRING::from(name)) }
            .map_err(|error| format!("no WebView2 install lock ({error}); checked without it"))?;
        let millis = u32::try_from(wait.as_millis()).unwrap_or(u32::MAX);
        // SAFETY: a handle this function owns.
        let waited = unsafe { WaitForSingleObject(handle, millis) };
        // Abandoned: the launch that held it ended mid-check. The runtime is detected again.
        if waited == WAIT_OBJECT_0 || waited == WAIT_ABANDONED {
            return Ok(Self(handle));
        }
        // SAFETY: the handle is closed once, here.
        let _ = unsafe { CloseHandle(handle) };
        Err(if waited == WAIT_TIMEOUT {
            format!(
                "another launch held the WebView2 install lock for {} s; checked without it",
                wait.as_secs()
            )
        } else {
            format!(
                "the WebView2 install lock wait failed ({:#x}); checked without it",
                waited.0
            )
        })
    }
}

impl Drop for InstallLock {
    fn drop(&mut self) {
        // SAFETY: this thread owns the mutex, and the handle is closed once, here.
        unsafe {
            let _ = ReleaseMutex(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}

/// This machine, with the copy of the notice shown while the bootstrapper runs.
struct Machine {
    notice: Notice,
    /// The notice was still on screen after the bootstrapper ended.
    notice_stuck: Cell<bool>,
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
        self.notice_stuck.set(notice.close() == Closed::Stuck);
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

/// How `OpenNotice::close` left the box.
#[derive(Debug, PartialEq, Eq)]
enum Closed {
    /// It was on screen, and is gone now.
    OnScreen,
    /// The user had dismissed it already.
    Dismissed,
    /// It is still on screen; it stays until dismissed.
    Stuck,
}

impl Notice {
    fn show(&self) -> OpenNotice {
        // Tao makes the process per-monitor DPI aware only when the runtime starts, after this
        // box, which a scaled display would otherwise stretch blurry. Tao's own call then finds the
        // same awareness set and keeps it; an error here only means it was set already.
        // SAFETY: a plain process-wide setting.
        let _ =
            unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
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
    fn close(self) -> Closed {
        /// `#32770` is the dialog class of a message box; the thread's IME windows are left alone.
        unsafe extern "system" fn post_close(window: HWND, found: LPARAM) -> BOOL {
            let mut class = [0u16; 16];
            // SAFETY: the buffer outlives the call.
            let len = unsafe { GetClassNameW(window, &mut class) };
            if class[..usize::try_from(len).unwrap_or(0)]
                == *"#32770".encode_utf16().collect::<Vec<_>>()
            {
                // SAFETY: `found` points at the counter of `close`, alive for the whole enumeration.
                unsafe { *(found.0 as *mut usize) += 1 };
                // SAFETY: a window of the notice's thread; a stale handle only fails the post.
                let _ = unsafe { PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0)) };
            }
            BOOL::from(true)
        }
        let mut found = 0_usize;
        if let Some(thread_id) = self.thread_id {
            for _ in 0..100 {
                // SAFETY: the callback only reads each window's class and posts it a message.
                let _ = unsafe {
                    EnumThreadWindows(thread_id, Some(post_close), LPARAM(&raw mut found as isize))
                };
                if self.thread.is_finished() {
                    return if found > 0 {
                        Closed::OnScreen
                    } else {
                        Closed::Dismissed
                    };
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        Closed::Stuck
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

/// Finds the runtime, and installs it when it is missing. `main` calls it before
/// `memry_tauri::run`: a runtime installed after `Wry::init` stays unusable for this process.
pub fn check_before_runtime() {
    CHECK.get_or_init(|| {
        let lock = InstallLock::acquire(INSTALL_LOCK, INSTALL_LOCK_WAIT);
        let bootstrapper = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join(BOOTSTRAPPER)))
            .unwrap_or_default();
        // No config is loaded yet, so the copy follows the OS language.
        let locale = locale::resolve_os_locale(sys_locale::get_locale().as_deref());
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
            notice_stuck: Cell::new(false),
        };
        let mut check = webview2::ensure(&machine, &bootstrapper);
        check.notice_stuck = machine.notice_stuck.get();
        match lock {
            Ok(lock) => HELD_LOCK.set(Some(lock)),
            Err(warning) => check.lock_warning = Some(warning),
        }
        check
    });
}

/// Logs and reports what `check_before_runtime` found, and ends the launch when no window can
/// open.
pub fn apply(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    // The single-instance plugin holds its mutex by now: a launch waiting here hands off to this
    // one.
    drop(HELD_LOCK.take());
    let Some(check) = CHECK.get() else {
        tracing::error!(
            scope = "WebView2",
            "the runtime was not checked before the Tauri runtime started"
        );
        return Ok(());
    };
    check.log();
    let locale = preboot::locale(app);
    settle(
        check.outcome,
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
            notice_stuck: Cell::new(false),
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

    /// `close` counts only the message box it found on screen and closed, so a box that never
    /// appeared fails this.
    #[test]
    fn the_installing_notice_closes_when_the_bootstrapper_ends() {
        let open = machine().notice.show();
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(open.close(), Closed::OnScreen);
    }

    /// Threads stand in for launches: a mutex belongs to the thread that took it.
    #[test]
    fn a_second_launch_checks_only_after_the_first_one_finished_its_install() {
        let name = r"Local\MemryNote-WebView2-test-wait";
        let installed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (held, first_holds) = mpsc::channel();
        let first = std::thread::spawn({
            let installed = installed.clone();
            move || {
                let lock = InstallLock::acquire(name, Duration::from_secs(60)).expect("first");
                held.send(()).expect("send");
                std::thread::sleep(Duration::from_millis(300));
                installed.store(true, std::sync::atomic::Ordering::SeqCst);
                drop(lock);
            }
        });
        first_holds.recv().expect("first holds the lock");
        let second = InstallLock::acquire(name, Duration::from_secs(60)).expect("second");
        assert!(installed.load(std::sync::atomic::Ordering::SeqCst));
        drop(second);
        first.join().expect("first");
    }

    #[test]
    fn a_lock_held_past_the_wait_lets_the_launch_check_without_it() {
        let name = r"Local\MemryNote-WebView2-test-timeout";
        let (held, first_holds) = mpsc::channel();
        let (done, release) = mpsc::channel::<()>();
        let first = std::thread::spawn(move || {
            let lock = InstallLock::acquire(name, Duration::from_secs(60)).expect("first");
            held.send(()).expect("send");
            let _ = release.recv();
            drop(lock);
        });
        first_holds.recv().expect("first holds the lock");
        let waited = InstallLock::acquire(name, Duration::from_millis(100));
        assert_eq!(
            waited.err().as_deref(),
            Some("another launch held the WebView2 install lock for 0 s; checked without it")
        );
        done.send(()).expect("release");
        first.join().expect("first");
    }

    /// A launch that ended while it held the lock (a crash, or the single-instance hand-off's
    /// exit) does not block the next one.
    #[test]
    fn a_lock_left_by_an_ended_launch_is_taken() {
        let name = r"Local\MemryNote-WebView2-test-abandoned";
        std::thread::spawn(move || {
            std::mem::forget(InstallLock::acquire(name, Duration::from_secs(60)).expect("first"));
        })
        .join()
        .expect("first");
        assert!(InstallLock::acquire(name, Duration::from_secs(60)).is_ok());
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
