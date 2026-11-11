//! Native crashes leave a minidump. The app attaches an in-process crash handler that asks an
//! out-of-process monitor, the same binary started with `--crash-monitor`, to write the dump:
//! the crashed process cannot be trusted to write its own memory to disk. Dumps are raw process
//! memory and never upload; only the diagnostic bundle the user submits (Step 40 (#3557)) reads
//! them.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};
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

/// Held for the app's lifetime; only the e2e crash hook takes it, to detach it before it aborts.
static HANDLER: Mutex<Option<CrashHandler>> = Mutex::new(None);
/// The write end of the monitor's stdin, held for the app's lifetime. The OS closes it however
/// the app ends, which tells the monitor its app is gone.
static MONITOR_STDIN: OnceLock<ChildStdin> = OnceLock::new();

struct Monitor {
    dir: PathBuf,
    /// The dump being written. minidumper's write error carries no path, so a failed write
    /// removes its partial file through this.
    writing: Mutex<Option<PathBuf>>,
}

impl ServerHandler for Monitor {
    /// The dump is written under a partial name; `on_minidump_created` names it `.dmp` once whole.
    fn create_minidump_file(&self) -> Result<(fs::File, PathBuf), std::io::Error> {
        fs::create_dir_all(&self.dir)?;
        let path = crash_dumps::new_partial_path(&self.dir);
        let file = fs::File::create(&path)?;
        *self.writing.lock().unwrap_or_else(PoisonError::into_inner) = Some(path.clone());
        Ok((file, path))
    }

    fn on_minidump_created(&self, result: Result<MinidumpBinary, minidumper::Error>) -> LoopAction {
        let writing = self
            .writing
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let dump = match result {
            Ok(dump) => dump,
            Err(error) => {
                eprintln!("crash monitor: could not write a minidump: {error}");
                if let Some(partial) = writing
                    && let Err(error) = fs::remove_file(&partial)
                {
                    eprintln!(
                        "crash monitor: could not remove {}: {error}",
                        partial.display()
                    );
                }
                return LoopAction::Continue;
            }
        };
        drop(dump.file);
        match crash_dumps::complete(&dump.path) {
            Ok(path) => eprintln!("crash monitor: wrote {}", path.display()),
            Err(error) => eprintln!(
                "crash monitor: could not name {} a dump: {error}",
                dump.path.display()
            ),
        }
        LoopAction::Continue
    }

    fn on_message(&self, _kind: u32, _buffer: Vec<u8>) {}
}

/// `main` calls this first. When the process was started as the monitor it serves dump requests
/// until the app is gone, and returns the exit code; otherwise it returns `None`.
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
    // The app holds stdin open for its whole life, so stdin closing is the one sign the app is
    // gone, however it ended. A client disconnect is not: a connect attempt that fails halfway (on
    // macOS, before the Mach service the server registers after the socket file) also connects
    // and leaves. A dump in progress is still finished: `Server::run` reads the flag only between
    // events, never while it writes a dump, so stdin closing mid-dump (on macOS the client stops
    // waiting for the ack after 5 s) ends the monitor only once the dump is written.
    static APP_GONE: AtomicBool = AtomicBool::new(false);
    std::thread::spawn(|| {
        let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
        APP_GONE.store(true, Ordering::Relaxed);
    });
    let handler = Box::new(Monitor {
        dir: dir.into(),
        writing: Mutex::default(),
    });
    match server.run(handler, &APP_GONE, Some(STALE_TIMEOUT)) {
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
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn()?;
    if let Some(stdin) = child.stdin.take() {
        let _ = MONITOR_STDIN.set(stdin);
    }
    Ok(())
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
            *HANDLER.lock().unwrap_or_else(PoisonError::into_inner) = Some(handler);
            tracing::info!(scope = "CrashDump", "crash handler attached");
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
                "lost the crash monitor (it ended, or dropped this app after a minute without a ping); crashes leave no dump"
            );
            return;
        }
    }
}

/// Raises a crash the way a native fault does, then ends the process. A test hook: it asks the
/// handler to write the dump, and aborts once it is written.
#[cfg(feature = "e2e")]
pub fn simulate_crash() -> bool {
    let Some(handler) = HANDLER.lock().unwrap_or_else(PoisonError::into_inner).take() else {
        return false;
    };
    #[cfg(target_os = "linux")]
    let _ = handler.simulate_signal(crash_handler::Signal::Segv as u32);
    #[cfg(any(windows, target_os = "macos"))]
    let _ = handler.simulate_exception(None);
    // The handler also answers SIGABRT: attached, it would answer the abort below with a second
    // dump, and the crashed process stays alive while that one is written (#3967).
    drop(handler);
    std::process::abort()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_write_leaves_no_partial_dump() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let dir = tmp.path().join("crash-dumps");
        let monitor = Monitor {
            dir: dir.clone(),
            writing: Mutex::default(),
        };
        let (_file, partial) = monitor
            .create_minidump_file()
            .expect("create the dump file");
        assert!(partial.exists());

        monitor.on_minidump_created(Err(minidumper::Error::ProtocolError("write failed")));

        assert_eq!(
            fs::read_dir(&dir).expect("list").count(),
            0,
            "left {partial:?}"
        );
    }
}
