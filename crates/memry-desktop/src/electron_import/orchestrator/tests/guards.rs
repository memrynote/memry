//! Guards that stop a run before it installs a vault: a running Electron, a vault that changes
//! under the import (check 7), a malformed row, and the one-import-at-a-time lock.

use super::*;

/// Red without `probe` in `phases`: the run imports while Electron holds its stores.
#[cfg(unix)]
#[test]
fn a_running_electron_stops_the_run_before_any_write() {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let w = two_vault_world();
    let profile = crate::electron_import::profile::locate_profile(&w.ctx(None).env)
        .unwrap()
        .unwrap();
    let dir = profile.local_storage_dir();
    fs::create_dir_all(&dir).unwrap();
    let lock = dir.join("LOCK");
    fs::write(&lock, "").unwrap();
    // LevelDB holds an fcntl write lock for its lifetime; python's lockf is the same primitive.
    let mut holder = Command::new("python3")
        .args([
            "-c",
            "import fcntl,sys,time\nf=open(sys.argv[1],'r+')\nfcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint('locked',flush=True)\ntime.sleep(60)",
        ])
        .arg(&lock)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(holder.stdout.as_mut().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line.trim(), "locked");

    let result = w.run();
    holder.kill().unwrap();
    holder.wait().unwrap();

    let error = result.unwrap_err();
    assert!(matches!(error, RunError::ElectronRunning), "{error}");
    assert_eq!(error.check(), "electron-running");
    assert!(w.marker().is_none());
    assert!(!w.core_data("Work").exists());
    assert_eq!(w.spell_check(), None, "app state not carried");
}

/// Red with the checks after `install` in `vault::import`: the vault is installed although
/// check 7 fails.
#[test]
fn a_vault_that_changes_during_the_import_fails_check_7_and_installs_nothing() {
    let w = World::new(&[("Work", None)]);
    w.electron_vault("Work", Some("4a5b6c7d-0000-4000-8000-000000000001"));
    let mut ctx = w.ctx(None);
    // Another writer in the vault folder: the run's own report, in a data dir inside it.
    ctx.tauri_data_dir = Path::new(&w.vault("Work")).join("tauri-data");
    fs::create_dir_all(&ctx.tauri_data_dir).unwrap();

    let error = w.run_with(&ctx).unwrap_err();

    assert_eq!(error.check(), "check-7", "{error}");
    assert!(!w.core_data("Work").exists(), "not installed");
    assert!(Marker::read(&ctx.tauri_data_dir).unwrap().is_none());
}

/// Lone surrogates and oversized values stop the vault as one `MalformedRow`; the error names
/// the vault, the table and the row (C22).
#[test]
fn a_malformed_row_names_its_vault_table_and_row() {
    let w = two_vault_world();
    let conn = Connection::open(Path::new(&w.vault("Home")).join(".memry/data.db")).unwrap();
    let pad = "x".repeat(8 * 1024 * 1024);
    electron_db::seed(
        &conn,
        "sync_queue",
        &[
            ("type", Sql::Text("task".into())),
            ("item_id", Sql::Text("task-1".into())),
            ("operation", Sql::Text("delete".into())),
            (
                "payload",
                Sql::Text(format!(r#"{{"clock":{{"dev-A":1}},"pad":"{pad}"}}"#)),
            ),
            ("attempts", Sql::Integer(0)),
            ("created_at", Sql::Integer(100)),
        ],
    );
    drop(conn);

    let error = w.run().unwrap_err();

    assert_eq!(error.check(), "malformed-row", "{error}");
    let message = error.to_string();
    assert!(
        message.starts_with(&format!("{}: sync_queue row 1:", w.vault("Home"))),
        "{message}"
    );
    let report = VerificationReport::parse(&fs::read(w.data.join(REPORT_FILE)).unwrap()).unwrap();
    assert_eq!(report.failure.unwrap().vault, Some(w.vault("Home")));
    assert!(w.marker().is_none());
}

#[derive(Default)]
struct LockProbe(Mutex<Vec<bool>>);

impl ProgressSink for LockProbe {
    fn update(&self, _: ProgressUpdate) {
        let held = IMPORT_LOCK.try_lock().is_err();
        self.0.lock().unwrap().push(held);
    }
}

/// Red without `IMPORT_LOCK` in `run_first_launch`: a second import of the same vaults could
/// start while this one runs.
#[test]
fn a_run_holds_the_import_lock_from_start_to_end() {
    let w = two_vault_world();
    let probe = LockProbe::default();
    let mut ctx = w.ctx(None);
    ctx.progress = &probe;

    w.run_with(&ctx).unwrap();

    let held = probe.0.lock().unwrap();
    assert!(held.len() > 3, "{held:?}");
    assert!(held.iter().all(|h| *h), "{held:?}");
}
