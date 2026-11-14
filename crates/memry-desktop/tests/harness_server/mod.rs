//! The real sync Worker on miniflare (`tests/sync-harness/scripts/serve.ts`, which needs
//! `pnpm install`), shared by the harness test binaries.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};

use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_desktop::seams::tls::{PinFailure, PinFailureSink};
use serde_json::Value;

/// The Worker, serving until dropped.
pub struct Server {
    child: Child,
    pub url: String,
    pub devices: Vec<Value>,
    replies: Receiver<Value>,
}

impl Server {
    pub fn start() -> Self {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/sync-harness");
        let mut child = Command::new(dir.join("node_modules/.bin/tsx"))
            .arg("scripts/serve.ts")
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start the harness server (run `pnpm install` first)");
        let mut out = BufReader::new(child.stdout.take().expect("its stdout"));
        let mut line = String::new();
        out.read_line(&mut line).expect("the bootstrap line");
        // The Worker logs to stdout; a closed pipe would end it on its first line.
        let (reply, replies) = channel();
        std::thread::spawn(move || {
            for line in out.lines().map_while(Result::ok) {
                match serde_json::from_str::<Value>(&line) {
                    Ok(value) if value.get("harnessMarkers").is_some() => {
                        let _ = reply.send(value);
                    }
                    _ => eprintln!("[worker] {line}"),
                }
            }
        });
        let boot: Value = serde_json::from_str(&line).expect("the bootstrap is JSON");
        Self {
            child,
            url: boot["url"].as_str().expect("a url").to_owned(),
            devices: boot["devices"].as_array().expect("devices").clone(),
            replies,
        }
    }

    /// Runs the Worker's cron, which sheds every tombstone to a marker (§5.12.3, retention 0 days
    /// for a user with no entitlement). Returns how many markers the server holds.
    #[allow(dead_code)] // One binary purges.
    pub fn purge(&mut self) -> u64 {
        let stdin = self.child.stdin.as_mut().expect("its stdin");
        stdin
            .write_all(b"purge\n")
            .and_then(|()| stdin.flush())
            .expect("purge");
        let reply = self.replies.recv().expect("the purge reply");
        reply["harnessMarkers"].as_u64().expect("a marker count")
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct NoPins;

impl PinFailureSink for NoPins {
    fn pin_failed(&self, failure: PinFailure) {
        panic!("a loopback server has no pins: {}", failure.hostname);
    }
}

pub struct Online;

impl Reachability for Online {
    fn current(&self) -> Reachable {
        Reachable::Wifi
    }
    fn observe(&self, _observer: Arc<dyn ReachabilityObserver>) {}
}
