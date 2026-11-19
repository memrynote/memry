//! A scripted first-launch migration (`crate::migration::Backend`) for the specs and the
//! live-app screenshots, chosen by `MEMRY_E2E_MIGRATION` in an e2e build with an open gate:
//!
//! - `done`: every phase over two vaults, then success.
//! - `fail:<check>`: fails with `<check>` after the app state and writes a report; Try again
//!   then succeeds.
//! - `hold:<phase>:<current>:<total>`: stops in that phase until the app quits.
//! - `notice`: nothing to migrate; the change notice shows.
//!
//! The backup it names is `MEMRY_ELECTRON_PROFILE_DIR`, or `electron-profile` in the data dir.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use memry_desktop::e2e::E2eGate;
use memry_desktop::electron_import::progress::{Phase, ProgressSink, ProgressUpdate};
use memry_desktop::electron_import::report::REPORT_FILE;
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::paths::AppPaths;
use tauri::{AppHandle, Manager, Wry};

use crate::migration::{Backend, MigrationFailure};

pub const SCRIPT_VAR: &str = "MEMRY_E2E_MIGRATION";
const STEP: Duration = Duration::from_millis(400);

enum Script {
    Done,
    Fail(String),
    Hold(ProgressUpdate),
    Notice,
}

struct Scripted {
    script: Script,
    runs: AtomicU32,
    notice: AtomicBool,
    data_dir: PathBuf,
    backup: PathBuf,
}

pub fn scripted(app: &AppHandle<Wry>) -> Option<Arc<dyn Backend>> {
    let env = app.state::<LaunchEnv>();
    if !E2eGate::from_env(&env).is_open() {
        return None;
    }
    let script = parse(env.get(SCRIPT_VAR)?)?;
    let data_dir = app.state::<AppPaths>().data_dir.clone();
    let backup = env
        .get("MEMRY_ELECTRON_PROFILE_DIR")
        .map_or_else(|| data_dir.join("electron-profile"), PathBuf::from);
    Some(Arc::new(Scripted {
        notice: AtomicBool::new(matches!(script, Script::Notice)),
        script,
        runs: AtomicU32::new(0),
        data_dir,
        backup,
    }))
}

fn parse(value: &str) -> Option<Script> {
    let mut parts = value.split(':');
    match parts.next()? {
        "done" => Some(Script::Done),
        "notice" => Some(Script::Notice),
        // The whole rest: a check such as `secrets:unreadable` holds a colon.
        "fail" => Some(Script::Fail(value.split_once(':')?.1.to_owned())),
        "hold" => {
            let phase = match parts.next()? {
                "app-state" => Phase::AppState,
                "secrets" => Phase::Secrets,
                "vault" => Phase::Vault,
                "finish" => Phase::Finish,
                _ => return None,
            };
            let current = parts.next()?.parse().ok()?;
            let total = parts.next()?.parse().ok()?;
            Some(Script::Hold(update(phase, current, total)))
        }
        _ => None,
    }
}

fn update(phase: Phase, current: u32, total: u32) -> ProgressUpdate {
    ProgressUpdate {
        phase,
        current,
        total,
        label: String::new(),
    }
}

fn walk(progress: &dyn ProgressSink, steps: &[ProgressUpdate]) {
    for step in steps {
        progress.update(step.clone());
        std::thread::sleep(STEP);
    }
}

impl Backend for Scripted {
    fn needed(&self) -> bool {
        !matches!(self.script, Script::Notice)
    }

    fn run(&self, progress: &dyn ProgressSink) -> Result<(), MigrationFailure> {
        let first_run = self.runs.fetch_add(1, Ordering::SeqCst) == 0;
        walk(progress, &[update(Phase::AppState, 1, 1)]);
        match &self.script {
            Script::Fail(check) if first_run => {
                let report = serde_json::json!({"version": 1, "failure": {"check": check}});
                let _ = std::fs::write(self.data_dir.join(REPORT_FILE), report.to_string());
                Err(MigrationFailure {
                    check: check.clone(),
                    details: format!("scripted failure of {check}"),
                })
            }
            Script::Hold(at) => {
                progress.update(at.clone());
                loop {
                    std::thread::park();
                }
            }
            Script::Done | Script::Fail(_) | Script::Notice => {
                walk(
                    progress,
                    &[
                        update(Phase::Secrets, 1, 1),
                        update(Phase::Vault, 1, 2),
                        update(Phase::Vault, 2, 2),
                        update(Phase::Finish, 0, 0),
                    ],
                );
                Ok(())
            }
        }
    }

    fn backup(&self) -> PathBuf {
        self.backup.clone()
    }

    fn take_change_notice(&self) -> bool {
        self.notice.swap(false, Ordering::SeqCst)
    }
}
