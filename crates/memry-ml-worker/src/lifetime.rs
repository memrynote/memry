//! The worker never outlives the app. A child hung in pdfium or Tesseract reads no stdin, so the
//! pipe the app's death closes does not end it. On Unix the child watches its parent id and exits
//! when it changes ([`exit_with_parent`]); on Windows the app puts each child in a job that kills
//! it when the app's last handle to the job closes ([`bind_to_app`]). `PR_SET_PDEATHSIG` is not
//! used: Linux sends it when the thread that spawned the child exits, and the app spawns from
//! tokio's blocking pool, whose threads exit after 10 s idle.

use std::process::Child;

/// How often the child checks its parent.
#[cfg(unix)]
const PARENT_POLL: std::time::Duration = std::time::Duration::from_millis(500);

/// Starts, once per process, a thread that exits the process when its parent dies (the child is
/// then reparented, so its parent id changes).
#[cfg(unix)]
pub fn exit_with_parent() {
    static WATCH: std::sync::Once = std::sync::Once::new();
    WATCH.call_once(|| {
        let parent = std::os::unix::process::parent_id();
        let spawned = std::thread::Builder::new()
            .name("parent-watch".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(PARENT_POLL);
                    // Nothing is logged: stderr went with the app, and a failed write panics.
                    if std::os::unix::process::parent_id() != parent {
                        std::process::exit(4);
                    }
                }
            });
        if let Err(error) = spawned {
            eprintln!("could not watch the app's process: {error}");
        }
    });
}

#[cfg(not(unix))]
pub fn exit_with_parent() {}

/// Puts `child` in the app's kill-on-close job (Windows); a no-op elsewhere. Best effort: the
/// worker still runs without it.
pub fn bind_to_app(child: &Child) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use std::sync::OnceLock;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        // The job's handle is never closed: the OS closes it when the app exits, which kills every
        // child in it. Stored as an integer because a raw handle is not `Sync`.
        static JOB: OnceLock<Result<isize, String>> = OnceLock::new();
        let job = JOB.get_or_init(|| {
            // SAFETY: plain FFI calls on a job this process creates and owns.
            unsafe {
                let job = CreateJobObjectW(None, windows::core::PCWSTR::null())
                    .map_err(|error| error.to_string())?;
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&limits).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(|error| error.to_string())?;
                Ok(job.0 as isize)
            }
        });
        let job = job.as_ref().map_err(std::io::Error::other)?;
        // SAFETY: the job lives for the process, and `child` owns its handle for the call.
        unsafe {
            AssignProcessToJobObject(
                HANDLE(*job as *mut std::ffi::c_void),
                HANDLE(child.as_raw_handle()),
            )
        }
        .map_err(std::io::Error::other)?;
    }
    #[cfg(not(windows))]
    let _ = child;
    Ok(())
}
