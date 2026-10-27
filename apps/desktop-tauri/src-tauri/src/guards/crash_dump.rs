//! Native crashes leave a minidump. The app attaches an in-process crash handler that asks an
//! out-of-process monitor, the same binary started with `--crash-monitor`, to write the dump:
//! the crashed process cannot be trusted to write its own memory to disk. Dumps are raw process
//! memory and never upload; only the diagnostic bundle the user submits (Step 40 (#3557)) reads
//! them.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime};

use crash_handler::{CrashEventResult, CrashHandler, make_crash_event};
use memry_desktop::paths::AppPaths;
use memry_desktop::shell::crash_dumps;
use minidumper::{Client, LoopAction, MinidumpBinary, Server, ServerHandler, SocketName};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::CommandError;

/// The switch `main` looks for before anything else starts.
pub const MONITOR_SWITCH: &str = "--crash-monitor";
/// A client that has not pinged within this long is dropped by the monitor.
const STALE_TIMEOUT: Duration = Duration::from_secs(60);
const PING_INTERVAL: Duration = Duration::from_secs(20);
const CONNECT_ATTEMPTS: u32 = 100;
const CONNECT_RETRY: Duration = Duration::from_millis(50);

static HANDLER: OnceLock<CrashHandler> = OnceLock::new();

struct Monitor {
    dir: PathBuf,
}

impl ServerHandler for Monitor {
    fn create_minidump_file(&self) -> Result<(fs::File, PathBuf), std::io::Error> {
        fs::create_dir_all(&self.dir)?;
        let path = crash_dumps::new_path(&self.dir);
        Ok((fs::File::create(&path)?, path))
    }

    fn on_minidump_created(&self, result: Result<MinidumpBinary, minidumper::Error>) -> LoopAction {
        match result {
            Ok(dump) => eprintln!("crash monitor: wrote {}", dump.path.display()),
            Err(error) => eprintln!("crash monitor: could not write a minidump: {error}"),
        }
        LoopAction::Continue
    }

    fn on_message(&self, _kind: u32, _buffer: Vec<u8>) {}

    /// The app is gone, crashed or not: the monitor has nothing left to serve.
    fn on_client_disconnected(&self, num_clients: usize) -> LoopAction {
        if num_clients == 0 {
            LoopAction::Exit
        } else {
            LoopAction::Continue
        }
    }
}

/// `main` calls this first. When the process was started as the monitor it serves dump requests
/// until the app disconnects, and returns the exit code; otherwise it returns `None`.
pub fn monitor_entry() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(MONITOR_SWITCH) {
        return None;
    }
    let (Some(socket), Some(dir)) = (args.next(), args.next()) else {
        eprintln!("crash monitor: usage {MONITOR_SWITCH} <socket> <dump dir>");
        return Some(2);
    };
    let mut server = match Server::with_name(SocketName::path(&socket)) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("crash monitor: could not listen on {socket}: {error}");
            return Some(1);
        }
    };
    let shutdown = AtomicBool::new(false);
    let handler = Box::new(Monitor { dir: dir.into() });
    match server.run(handler, &shutdown, Some(STALE_TIMEOUT)) {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("crash monitor: {error}");
            Some(1)
        }
    }
}

/// Starts the monitor and attaches the crash handler. The attach waits for the monitor on a
/// thread, so the boot does not.
pub fn start(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let data_dir = app.state::<AppPaths>().data_dir.clone();
    let dir = crash_dumps::dir(&data_dir);
    match crash_dumps::prune(
        &dir,
        crash_dumps::KEEP_NEWEST,
        crash_dumps::MAX_AGE,
        SystemTime::now(),
    ) {
        Ok(0) => {}
        Ok(deleted) => tracing::info!(scope = "CrashDump", "pruned {deleted} old minidump(s)"),
        Err(error) => tracing::warn!(scope = "CrashDump", "could not prune minidumps: {error}"),
    }
    let socket = std::env::temp_dir().join(format!("memry-crash-{}.sock", std::process::id()));
    if let Err(error) = spawn_monitor(&socket, &dir) {
        // A crash then leaves no dump; the app itself still runs.
        tracing::warn!(scope = "CrashDump", "crash monitor did not start: {error}");
        return Ok(());
    }
    std::thread::Builder::new()
        .name("crash-dump-client".to_owned())
        .spawn(move || attach(&socket))
        .map_err(|error| {
            CommandError::new(
                crate::commands::error::ErrorKind::Internal,
                "crash_dump",
                error.to_string(),
            )
        })?;
    Ok(())
}

fn spawn_monitor(socket: &Path, dir: &Path) -> std::io::Result<()> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg(MONITOR_SWITCH)
        .arg(socket)
        .arg(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map(|_child| ())
}

fn connect(socket: &Path) -> Option<Client> {
    let name = socket.to_string_lossy();
    for _ in 0..CONNECT_ATTEMPTS {
        if let Ok(client) = Client::with_name(SocketName::path(&name)) {
            return Some(client);
        }
        std::thread::sleep(CONNECT_RETRY);
    }
    None
}

fn attach(socket: &Path) {
    let Some(client) = connect(socket) else {
        tracing::warn!(
            scope = "CrashDump",
            "could not reach the crash monitor; crashes leave no dump"
        );
        return;
    };
    let client = std::sync::Arc::new(client);
    let for_handler = client.clone();
    // SAFETY: the closure runs in a crashed process, where only a few calls are safe. It does
    // one thing, asking the monitor process to write the dump, which `crash-handler` documents
    // as the intended use of `minidumper::Client::request_dump`.
    let event = unsafe {
        make_crash_event(move |context| {
            CrashEventResult::Handled(for_handler.request_dump(context).is_ok())
        })
    };
    match CrashHandler::attach(event) {
        Ok(handler) => {
            let _ = HANDLER.set(handler);
        }
        Err(error) => {
            tracing::warn!(
                scope = "CrashDump",
                "could not attach the crash handler: {error}"
            );
            return;
        }
    }
    // The monitor drops a client that is silent for a minute; a quiet app still needs its dump.
    loop {
        std::thread::sleep(PING_INTERVAL);
        if client.ping().is_err() {
            tracing::warn!(
                scope = "CrashDump",
                "the crash monitor is gone; crashes leave no dump"
            );
            return;
        }
    }
}

/// Raises a crash the way a native fault does, then ends the process. A test hook: it asks the
/// handler to write the dump, and aborts once it is written.
#[cfg(feature = "e2e")]
pub fn simulate_crash() -> bool {
    let Some(handler) = HANDLER.get() else {
        return false;
    };
    #[cfg(target_os = "linux")]
    let _ = handler.simulate_signal(crash_handler::Signal::Segv as u32);
    #[cfg(any(windows, target_os = "macos"))]
    let _ = handler.simulate_exception(None);
    std::process::abort()
}
