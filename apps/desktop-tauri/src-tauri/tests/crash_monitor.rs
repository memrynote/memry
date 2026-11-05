use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::thread::sleep;
use std::time::Duration;

use memry_tauri::guards::crash_dump::MONITOR_SWITCH;
use minidumper::{Client, SocketName};

/// Polls `probe` every 20 ms, up to `tries` times.
fn poll<T>(tries: u32, mut probe: impl FnMut() -> Option<T>) -> Option<T> {
    for _ in 0..tries {
        if let Some(value) = probe() {
            return Some(value);
        }
        sleep(Duration::from_millis(20));
    }
    None
}

/// Up to 30 s: a deadline that only a broken monitor reaches.
const DEADLINE_TRIES: u32 = 1_500;

fn spawn_monitor(dir: &Path, socket: &Path) -> (Child, ChildStdin) {
    let mut monitor = Command::new(env!("CARGO_BIN_EXE_memry-tauri"))
        .arg(MONITOR_SWITCH)
        .arg(socket)
        .arg(dir.join("crash-dumps"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the monitor");
    let stdin = monitor.stdin.take().expect("the monitor's stdin");
    (monitor, stdin)
}

/// Connects as the app's crash handler does: the socket file is no readiness signal, because on
/// macOS the client also looks up a Mach service the monitor registers after it creates the file.
fn connect(socket: &Path) -> Client {
    let client = poll(DEADLINE_TRIES, || {
        Client::with_name(SocketName::path(&socket.to_string_lossy())).ok()
    })
    .expect("the monitor never accepted a client");
    client.ping().expect("the monitor answers a ping");
    client
}

fn exit_status(monitor: &mut Child) -> ExitStatus {
    let status = poll(DEADLINE_TRIES, || {
        monitor.try_wait().expect("poll the monitor")
    });
    if status.is_none() {
        let _ = monitor.kill();
    }
    status.expect("the monitor outlived its app")
}

/// The monitor serves while its app holds stdin, and ends once stdin closes even though no client
/// disconnected: an app that ends before its handler connects (a quit or a kill during the boot)
/// leaves the monitor nothing else to see.
#[test]
fn the_monitor_ends_when_its_app_is_gone_without_a_disconnect() {
    let dir = tempfile::tempdir().expect("temp dir");
    let socket = dir.path().join("monitor.sock");
    let (mut monitor, stdin) = spawn_monitor(dir.path(), &socket);
    // Held until the end: the exit below has to come from stdin, not from a disconnect.
    let client = connect(&socket);
    assert!(
        monitor.try_wait().expect("poll the monitor").is_none(),
        "the monitor ended while its app held stdin"
    );

    drop(stdin);

    let status = exit_status(&mut monitor);
    assert!(status.success(), "the monitor exited with {status}");
    drop(client);
}

/// A client that leaves is not its app leaving: a connect attempt that fails halfway (on macOS,
/// before the monitor registered its Mach service) still reaches the socket and then closes it.
/// The monitor keeps serving the app until stdin closes.
#[test]
fn a_client_that_leaves_does_not_end_the_monitor() {
    let dir = tempfile::tempdir().expect("temp dir");
    let socket = dir.path().join("monitor.sock");
    let (mut monitor, stdin) = spawn_monitor(dir.path(), &socket);

    drop(connect(&socket));
    // A monitor that took the disconnect for its app's exit ends within one 10 ms loop pass.
    assert!(
        poll(50, || monitor.try_wait().expect("poll the monitor")).is_none(),
        "the monitor ended when a client left"
    );
    let client = connect(&socket);

    drop(stdin);

    let status = exit_status(&mut monitor);
    assert!(status.success(), "the monitor exited with {status}");
    drop(client);
}
