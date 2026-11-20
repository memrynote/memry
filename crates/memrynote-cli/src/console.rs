//! The console of a `--cli` launch of the app binary on Windows.
//!
//! A release `Memrynote.exe` is a GUI-subsystem binary (`windows_subsystem = "windows"`), so
//! Windows gives it no console and no standard handles unless the caller redirected them. The
//! legacy `memrynote.cmd` shim runs it from a terminal, where its output must reach that
//! terminal. The sidecar `memrynote-cli.exe` is a console binary and needs none of this.

/// Attaches the parent's console and points stdout and stderr at it when they have no handle.
/// A redirected handle (a pipe, a file) is kept. Rust's std reads the handle at each write,
/// so this runs before the first line is printed. No-op elsewhere.
pub fn attach_parent_console() {
    #[cfg(windows)]
    windows::attach();
}

#[cfg(windows)]
mod windows {
    use std::os::windows::io::IntoRawHandle;

    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::{
        ATTACH_PARENT_PROCESS, AttachConsole, GetStdHandle, STD_ERROR_HANDLE, STD_HANDLE,
        STD_OUTPUT_HANDLE, SetStdHandle,
    };

    pub fn attach() {
        // SAFETY: plain Win32 calls with constant arguments. AttachConsole fails without a
        // parent console (a launch from Explorer); output then has nowhere to go, as before.
        if unsafe { AttachConsole(ATTACH_PARENT_PROCESS) } == 0 {
            return;
        }
        for which in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            point_at_console(which);
        }
    }

    fn point_at_console(which: STD_HANDLE) {
        // SAFETY: GetStdHandle only reads the process's standard handle table.
        let current: HANDLE = unsafe { GetStdHandle(which) };
        if !current.is_null() && current != INVALID_HANDLE_VALUE {
            return;
        }
        let console = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("CONOUT$");
        if let Ok(console) = console {
            // The handle lives as long as the process: the std handle table owns it now.
            let handle = console.into_raw_handle() as HANDLE;
            // SAFETY: `handle` is an open console handle this process owns.
            unsafe { SetStdHandle(which, handle) };
        }
    }
}
