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
    /// The whole bootstrap line (`serve.ts`), for what a case reads beyond the devices.
    #[allow(dead_code)] // One binary reads it.
    pub boot: Value,
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
                    Ok(value)
                        if value
                            .as_object()
                            .is_some_and(|o| o.keys().any(|k| k.starts_with("harness"))) =>
                    {
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
            boot,
            replies,
        }
    }

    /// Runs the Worker's cron, which sheds every tombstone to a marker (§5.12.3, retention 0 days
    /// for a user with no entitlement). Returns how many markers the server holds.
    #[allow(dead_code)] // One binary purges.
    pub fn purge(&mut self) -> u64 {
        self.command("purge")["harnessMarkers"]
            .as_u64()
            .expect("a marker count")
    }

    /// Deletes every server row of `item_id`, record and body, as a server that lost its create.
    /// Returns how many record rows went.
    #[allow(dead_code)] // One binary loses.
    pub fn lose(&mut self, item_id: &str) -> u64 {
        self.command(&format!("lose {item_id}"))["harnessLost"]
            .as_u64()
            .expect("a row count")
    }

    /// Registers one more device for the same user, now, and returns it in the bootstrap's
    /// device shape.
    #[allow(dead_code)] // One binary registers.
    pub fn register(&mut self) -> Value {
        self.command("register")["harnessDevice"].clone()
    }

    /// Makes `code` the pending sign-in code of `email`, as the server stores one it mailed.
    #[allow(dead_code)] // One binary signs in.
    pub fn otp(&mut self, email: &str, code: &str) {
        let reply = self.command(&format!("otp {email} {code}"));
        assert_eq!(reply["harnessOtp"], true, "{reply}");
    }

    /// Gives the user who signed in with `email` a paid plan, so it can add vaults to its account.
    #[allow(dead_code)] // One binary entitles.
    pub fn entitle(&mut self, email: &str) {
        let reply = self.command(&format!("entitle {email}"));
        assert_eq!(reply["harnessEntitled"], true, "{reply}");
    }

    /// The user's plan allows files up to `bytes`; the Worker refuses larger ones with a 413.
    #[allow(dead_code)] // One binary limits.
    pub fn file_limit(&mut self, bytes: u64) {
        let reply = self.command(&format!("file-limit {bytes}"));
        assert_eq!(reply["harnessFileLimit"], true, "{reply}");
    }

    /// Changes an account vault's id on the server, as a server that chose a hostile id would.
    #[allow(dead_code)] // One binary renames.
    pub fn rename_vault(&mut self, from: &str, to: &str) {
        let reply = self.command(&format!("rename-vault {from} {to}"));
        assert_eq!(reply["harnessRenamed"], true, "{reply}");
    }

    /// Sets the `desktop` client policy (§11.8): the kill switch and the optional write floor.
    #[allow(dead_code)] // One binary sets it.
    pub fn policy(&mut self, writes_enabled: bool, min_write_version: Option<&str>) {
        let line = format!(
            "policy {} {}",
            u8::from(writes_enabled),
            min_write_version.unwrap_or("")
        );
        let reply = self.command(line.trim_end());
        assert_eq!(reply["harnessPolicy"], true, "{reply}");
    }

    fn command(&mut self, line: &str) -> Value {
        let stdin = self.child.stdin.as_mut().expect("its stdin");
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|()| stdin.flush())
            .expect("a harness command");
        self.replies.recv().expect("the command's reply")
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

#[allow(dead_code)] // Not every binary goes online.
pub struct Online;

impl Reachability for Online {
    fn current(&self) -> Reachable {
        Reachable::Wifi
    }
    fn observe(&self, _observer: Arc<dyn ReachabilityObserver>) {}
}
