//! Ctrl-C ends the current run the normal way: the wait loops see the flag, the app is asked to
//! quit (and killed with its web view processes if it does not), and the run's temp profile is
//! removed. On Windows a GUI app gets no console Ctrl-C of its own, so without this the app
//! and its WebView2 processes would outlive the tool.

use std::sync::atomic::{AtomicBool, Ordering};

static INTERRUPTED: AtomicBool = AtomicBool::new(false);

/// Installs the handler; call once, before the first launch.
pub fn install() {
    #[cfg(unix)]
    {
        extern "C" fn on_signal(_: libc::c_int) {
            INTERRUPTED.store(true, Ordering::SeqCst);
        }
        // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
        let handler: extern "C" fn(libc::c_int) = on_signal;
        unsafe { libc::signal(libc::SIGINT, handler as libc::sighandler_t) };
    }
    #[cfg(windows)]
    {
        unsafe extern "system" fn on_ctrl(_: u32) -> windows::core::BOOL {
            INTERRUPTED.store(true, Ordering::SeqCst);
            windows::core::BOOL(1)
        }
        // SAFETY: registers a handler that only stores to an atomic.
        if let Err(error) =
            unsafe { windows::Win32::System::Console::SetConsoleCtrlHandler(Some(on_ctrl), true) }
        {
            eprintln!(
                "measure-memory: no Ctrl-C handler ({error}); an interrupt leaves the app running"
            );
        }
    }
}

/// `Err` once the user interrupted.
pub fn check() -> Result<(), String> {
    if INTERRUPTED.load(Ordering::SeqCst) {
        Err("interrupted".to_owned())
    } else {
        Ok(())
    }
}
