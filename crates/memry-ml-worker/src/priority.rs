//! The worker yields the CPU to everything else on the machine, as Electron's utility processes
//! do (`apps/desktop/src/main/lib/low-priority.ts`: Node's `PRIORITY_LOW`, which is nice 19 and,
//! through libuv, `IDLE_PRIORITY_CLASS` on Windows). Best effort: the work still runs without it.

use std::process::Child;

pub fn lower(child: &Child) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        // SAFETY: plain FFI call on a child process this process owns; it returns 0 or -1.
        let code =
            unsafe { libc::setpriority(libc::PRIO_PROCESS, child.id() as libc::id_t, NICE_LOW) };
        if code != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Threading::{IDLE_PRIORITY_CLASS, SetPriorityClass};
        // SAFETY: `child` owns this process handle, which stays open for the call.
        unsafe { SetPriorityClass(HANDLE(child.as_raw_handle()), IDLE_PRIORITY_CLASS) }
            .map_err(std::io::Error::other)?;
    }
    Ok(())
}

#[cfg(unix)]
pub const NICE_LOW: libc::c_int = 19;
