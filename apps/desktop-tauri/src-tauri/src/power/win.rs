//! A second window subclass on the main window (the caption one is `win32_caption.rs`) for
//! `WM_POWERBROADCAST` and the session-end messages.
//!
//! Windows sends `WM_ENDSESSION` to every top-level window of the process, and tao's hidden
//! "Tao Thread Event Target" window answers it with `process::exit(0)` (tao 0.37 `event_loop.rs`),
//! whichever window is asked first. So the subclass goes on that window too: the first one asked
//! runs the quit sequence and holds the message until it is done, the other answers at once, and
//! tao's handler is never reached while a flush could still be under way.

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_desktop::shell::flush::FLUSH_WINDOW_TIMEOUT;
use memry_desktop::shell::power::{PowerEvent, SleepEdges, wait_for};
use memry_desktop::shell::shutdown::{Deadline, SESSION_END_BUDGET};
use tauri::{AppHandle, Wry};
use tokio::sync::broadcast::Sender;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Shutdown::{ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy};
use windows::Win32::System::Threading::{GetCurrentThreadId, SetProcessShutdownParameters};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EnumThreadWindows, GetClassNameW, MSG, MsgWaitForMultipleObjects,
    PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, PM_REMOVE, PeekMessageW,
    PostQuitMessage, QS_ALLINPUT, TranslateMessage, WM_ENDSESSION, WM_POWERBROADCAST,
    WM_QUERYENDSESSION, WM_QUIT,
};
use windows::core::{BOOL, w};

use crate::windows::registry::WindowRegistry;

const SUBCLASS_ID: usize = 0x4D45_4D50;
/// Windows ends a session's processes from the highest shutdown level down, and every process
/// starts at 0x280. Chromium leaves the WebView2 browser process there and lowers its children to
/// 0x27F (`content/app/content_main.cc`, `CommonSubprocessInit`), so at the same level the order
/// of the app and its webview is unspecified: on the VM a sign-out ended the webview while the
/// app was still answering `WM_QUERYENDSESSION`, and the page's edits were lost. One level above
/// the browser, Windows asks the app first, while every page can still answer.
const SHUTDOWN_LEVEL: u32 = 0x281;
/// The class tao registers for the hidden window that receives the thread's events.
const EVENT_TARGET_CLASS: &str = "Tao Thread Event Target";

/// The thread that owns the main window and tao's event target, set by [`start`].
static LOOP_THREAD: AtomicU32 = AtomicU32::new(0);

/// Leaked on purpose: the main window lives as long as the process.
struct Shared {
    app: AppHandle<Wry>,
    sender: Sender<PowerEvent>,
    edges: Mutex<SleepEdges>,
    /// The window `ShutdownBlockReasonCreate` was called with.
    main_hwnd: AtomicIsize,
    /// A `WM_ENDSESSION(TRUE)` is being or has been handled by one of the two windows.
    ending: AtomicBool,
}

impl Shared {
    fn emit(&self, event: PowerEvent) {
        super::publish(&self.sender, event);
    }
}

/// Answers `WM_ENDSESSION` for either window: the first one asked runs the quit sequence and
/// does not return until it is done or `SESSION_END_BUDGET` is spent; the other one returns at
/// once. Neither forwards the message, so tao's `process::exit(0)` is not reached.
fn end_session(shared: &Shared, ending: bool) {
    if ending {
        if shared.ending.swap(true, Ordering::SeqCst) {
            return;
        }
        crate::shutdown::begin_session_end(&shared.app);
        // Windows ends the process soon after this returns (about five seconds in all), so the
        // quit sequence has to finish here.
        let done = hold(SESSION_END_BUDGET, || {
            crate::shutdown::is_completed(&shared.app)
        });
        if !done {
            tracing::warn!(
                scope = "Power",
                "the session ended before the quit sequence"
            );
        }
    } else {
        shared.ending.store(false, Ordering::SeqCst);
        // The sign-out was cancelled: the install-on-quit decision is back.
        if let Some(hook) = crate::shutdown::update_hook(&shared.app) {
            hook.enable_install_on_quit();
        }
    }
    let main = HWND(shared.main_hwnd.load(Ordering::SeqCst) as *mut _);
    // SAFETY: the window `ShutdownBlockReasonCreate` was called with.
    let _ = unsafe { ShutdownBlockReasonDestroy(main) };
}

/// Keeps the calling window procedure from returning until `done` is true or `limit` is spent,
/// while this thread's messages keep being dispatched: the webview's IPC and the steps of the
/// quit sequence need the main thread. True when `done`.
fn hold(limit: Duration, done: impl Fn() -> bool) -> bool {
    let mut quit = None;
    let finished = wait_for(limit, done, |slice| {
        if quit.is_none() {
            quit = pump_messages(slice);
        } else {
            // The loop was asked to exit: leave its WM_QUIT for it, and wait without spinning on
            // the queue.
            std::thread::sleep(slice);
        }
    });
    if let Some(code) = quit {
        // The app asked to exit meanwhile: hand the request back to the real loop.
        // SAFETY: plain Win32 call on the thread that owns the message queue.
        unsafe { PostQuitMessage(code) };
    }
    finished
}

/// Answers `WM_QUERYENDSESSION` only after every window has written the edits its page still
/// holds. At a sign-out the WebView2 processes end themselves on their own `WM_ENDSESSION`, a few
/// milliseconds into the app's quit sequence, so its `flush-windows` step may find no page to
/// ask. [`SHUTDOWN_LEVEL`] has Windows ask the app before it touches the webview, so the pages
/// are alive here. A sign-out that is then cancelled has only saved early.
fn flush_before_session_end(app: &AppHandle<Wry>) {
    if crate::startup::shutdown_started() {
        // The quit sequence is already running and flushed first.
        return;
    }
    let flushed = Arc::new(AtomicBool::new(false));
    let (handle, flag) = (app.clone(), flushed.clone());
    tauri::async_runtime::spawn(async move {
        crate::flush::flush_app_windows(&handle, Deadline::after(FLUSH_WINDOW_TIMEOUT)).await;
        flag.store(true, Ordering::SeqCst);
    });
    let started = Instant::now();
    if hold(FLUSH_WINDOW_TIMEOUT, || flushed.load(Ordering::SeqCst)) {
        tracing::info!(
            scope = "Power",
            "windows flushed before the session end in {} ms",
            started.elapsed().as_millis()
        );
    } else {
        tracing::warn!(
            scope = "Power",
            "the windows did not flush before the session end"
        );
    }
}

unsafe extern "system" fn proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    refdata: usize,
) -> LRESULT {
    // SAFETY: `refdata` is the leaked `Shared` installed with this subclass.
    let shared = unsafe { &*(refdata as *const Shared) };
    match msg {
        WM_POWERBROADCAST => {
            let mut edges = shared
                .edges
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let event = match wparam.0 as u32 {
                PBT_APMSUSPEND => edges.suspend(),
                PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => edges.resume(),
                _ => None,
            };
            drop(edges);
            if let Some(event) = event {
                shared.emit(event);
            }
        }
        WM_QUERYENDSESSION => {
            shared.emit(PowerEvent::SessionEnding);
            // An update must not start installing as the machine goes down.
            if let Some(hook) = crate::shutdown::update_hook(&shared.app) {
                hook.disable_install_on_quit();
            }
            // Shown on the sign-out screen while the sequence runs, and what lets Windows hold
            // the session open for it.
            // SAFETY: `hwnd` is the window this procedure belongs to.
            if let Err(error) =
                unsafe { ShutdownBlockReasonCreate(hwnd, w!("MemryNote is saving your notes")) }
            {
                tracing::warn!(
                    scope = "Power",
                    "could not set the shutdown block reason: {error}"
                );
            }
            flush_before_session_end(&shared.app);
            return LRESULT(1);
        }
        WM_ENDSESSION => {
            end_session(shared, wparam.0 != 0);
            return LRESULT(0);
        }
        _ => {}
    }
    // SAFETY: forwards the message this procedure received.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// The subclass of tao's event target: only the session end, which it must not leave to tao.
unsafe extern "system" fn event_target_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    refdata: usize,
) -> LRESULT {
    if msg == WM_ENDSESSION {
        // SAFETY: `refdata` is the leaked `Shared` installed with this subclass.
        end_session(unsafe { &*(refdata as *const Shared) }, wparam.0 != 0);
        return LRESULT(0);
    }
    // SAFETY: forwards the message this procedure received.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Waits up to `slice` for input, then dispatches the messages queued on this thread until the
/// slice is spent. Returns the exit code of a `WM_QUIT` met on the way, which is not dispatched.
fn pump_messages(slice: Duration) -> Option<i32> {
    let started = Instant::now();
    // SAFETY: plain Win32 message-loop calls on the thread that owns the window.
    unsafe {
        MsgWaitForMultipleObjects(
            None,
            false,
            u32::try_from(slice.as_millis()).unwrap_or(u32::MAX),
            QS_ALLINPUT,
        );
        let mut msg = MSG::default();
        // A flood of messages must not hold the wait past its limit.
        while started.elapsed() < slice && PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            if msg.message == WM_QUIT {
                return Some(i32::try_from(msg.wParam.0).unwrap_or(0));
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    None
}

/// tao's event-target window on the loop thread, if it is there.
pub fn event_target_window() -> Option<HWND> {
    unsafe extern "system" fn visit(hwnd: HWND, found: LPARAM) -> BOOL {
        let mut class = [0u16; 64];
        // SAFETY: `class` is a writable buffer of the length passed.
        let len = unsafe { GetClassNameW(hwnd, &mut class) };
        let len = usize::try_from(len).unwrap_or(0);
        if String::from_utf16_lossy(&class[..len]) == EVENT_TARGET_CLASS {
            // SAFETY: `found` is the `Option<HWND>` of the caller below.
            unsafe { *(found.0 as *mut Option<HWND>) = Some(hwnd) };
            return BOOL(0);
        }
        BOOL(1)
    }
    let thread = LOOP_THREAD.load(Ordering::SeqCst);
    let mut found: Option<HWND> = None;
    // SAFETY: `found` outlives the call, which runs `visit` synchronously.
    let _ =
        unsafe { EnumThreadWindows(thread, Some(visit), LPARAM(&mut found as *mut _ as isize)) };
    found
}

/// Plays a sign-out the way Windows does: `WM_QUERYENDSESSION` to the main window and, once it
/// has answered, `WM_ENDSESSION(TRUE)` to `main` or to tao's event target. With `kill_browser`,
/// the WebView2 browser process with that id is ended between the two, as it ends itself on its
/// own `WM_ENDSESSION` at a real sign-out. Returns at once: the messages go from a thread.
#[cfg(feature = "e2e")]
pub fn post_sign_out(main: HWND, event_target: bool, kill_browser: Option<u32>) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
    use windows::Win32::UI::WindowsAndMessaging::{ENDSESSION_LOGOFF, SendMessageW};

    let target = if event_target {
        event_target_window()
    } else {
        Some(main)
    };
    let Some(target) = target else { return false };
    let (main, target) = (main.0 as isize, target.0 as isize);
    std::thread::spawn(move || {
        let logoff = Some(LPARAM(ENDSESSION_LOGOFF as isize));
        // SAFETY: the windows belong to this process and live as long as it; the process handle
        // is closed after use.
        unsafe {
            let answer = SendMessageW(
                HWND(main as *mut _),
                WM_QUERYENDSESSION,
                Some(WPARAM(0)),
                logoff,
            );
            tracing::info!(
                scope = "Power",
                "e2e: WM_QUERYENDSESSION answered {}",
                answer.0
            );
            if let Some(pid) = kill_browser {
                match OpenProcess(PROCESS_TERMINATE, false, pid) {
                    Ok(process) => {
                        let ended = TerminateProcess(process, 1);
                        let _ = CloseHandle(process);
                        tracing::info!(
                            scope = "Power",
                            "e2e: ended the WebView2 browser process {pid}: {ended:?}"
                        );
                    }
                    Err(error) => tracing::warn!(
                        scope = "Power",
                        "e2e: could not open the WebView2 browser process {pid}: {error}"
                    ),
                }
            }
            SendMessageW(
                HWND(target as *mut _),
                WM_ENDSESSION,
                Some(WPARAM(1)),
                logoff,
            );
        }
    });
    true
}

/// Puts the app ahead of its webview in the session-end order, then subclasses the main window
/// and tao's event target. Runs on the thread that owns them.
pub fn start(app: &AppHandle<Wry>, sender: &Sender<PowerEvent>) {
    // SAFETY: plain Win32 call that only changes this process's shutdown order.
    if let Err(error) = unsafe { SetProcessShutdownParameters(SHUTDOWN_LEVEL, 0) } {
        tracing::warn!(
            scope = "Power",
            "could not put the app ahead of its webview at a session end: {error}"
        );
    }
    let Some(window) = WindowRegistry::main_window(app) else {
        tracing::warn!(
            scope = "Power",
            "no main window; sleep and session end are not heard"
        );
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        tracing::warn!(
            scope = "Power",
            "no window handle; sleep and session end are not heard"
        );
        return;
    };
    // SAFETY: plain query of the calling thread.
    LOOP_THREAD.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
    let shared: &'static Shared = Box::leak(Box::new(Shared {
        app: app.clone(),
        sender: sender.clone(),
        edges: Mutex::new(SleepEdges::default()),
        main_hwnd: AtomicIsize::new(hwnd.0 as isize),
        ending: AtomicBool::new(false),
    }));
    // SAFETY: the procedures and their refdata outlive the windows.
    let ok =
        unsafe { SetWindowSubclass(hwnd, Some(proc), SUBCLASS_ID, shared as *const _ as usize) };
    if !ok.as_bool() {
        tracing::warn!(scope = "Power", "the power subclass was not installed");
    }
    match event_target_window() {
        // SAFETY: as above.
        Some(target) => {
            let ok = unsafe {
                SetWindowSubclass(
                    target,
                    Some(event_target_proc),
                    SUBCLASS_ID,
                    shared as *const _ as usize,
                )
            };
            if !ok.as_bool() {
                tracing::warn!(
                    scope = "Power",
                    "the event target subclass was not installed"
                );
            }
        }
        None => tracing::warn!(
            scope = "Power",
            "no event target window; a session end may end the process before the flush"
        ),
    }
}
