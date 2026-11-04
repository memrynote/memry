use std::process::{Command, ExitStatus, Stdio};
use std::thread::sleep;
use std::time::Duration;

use memry_tauri::guards::crash_dump::MONITOR_SWITCH;

/// Polls `probe` every 20 ms, up to 1,500 times (30 s).
fn poll<T>(mut probe: impl FnMut() -> Option<T>) -> Option<T> {
    for _ in 0..1_500 {
        if let Some(value) = probe() {
            return Some(value);
        }
        sleep(Duration::from_millis(20));
    }
    None
}

/// An app that ends before its crash handler connects (a quit or a kill during the boot) leaves
/// the monitor no client to see disconnect; the closed stdin has to end it.
#[test]
fn the_monitor_ends_when_its_app_is_gone_before_it_connected() {
    let dir = tempfile::tempdir().expect("temp dir");
    let socket = dir.path().join("monitor.sock");
    let mut monitor = Command::new(env!("CARGO_BIN_EXE_memry-tauri"))
        .arg(MONITOR_SWITCH)
        .arg(&socket)
        .arg(dir.path().join("crash-dumps"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the monitor");
    assert!(
        poll(|| socket.exists().then_some(())).is_some(),
        "the monitor never listened"
    );

    drop(monitor.stdin.take());

    let status: Option<ExitStatus> = poll(|| monitor.try_wait().expect("poll the monitor"));
    if status.is_none() {
        let _ = monitor.kill();
    }
    let status = status.expect("the monitor outlived its app");
    assert!(status.success(), "the monitor exited with {status}");
}
