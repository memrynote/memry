//! `migrate_vault`, the session's open hook (REVIEW-5140 #2, #3): it refuses before the
//! first-launch run finished, and finds a vault's marker entry under any path string of its
//! folder.

use std::sync::mpsc;
use std::time::Duration;

use super::*;

/// Red with `Ok` on no marker: Work opens natively and the run then finds it `NativeFirst`.
#[test]
fn an_open_before_the_run_is_refused_and_the_run_then_imports_the_vault() {
    let w = two_vault_world();
    let ctx = w.ctx(None);

    let error = migrate_vault(&ctx, Path::new(&w.vault("Work"))).unwrap_err();

    assert!(matches!(error, RunError::NotMigrated), "{error}");
    assert_eq!(error.check(), "not-migrated");
    assert!(error.to_string().contains("Finish moving your data first"));
    assert!(!w.core_data("Work").exists());
    w.run().unwrap();
    assert_eq!(w.status("Work"), VaultStatus::Imported);

    // Settled: only the marker is read.
    fs::remove_dir_all(&w.profile).unwrap();
    migrate_vault(&ctx, Path::new(&w.vault("Work"))).unwrap();
    migrate_vault(&ctx, Path::new("/not/an/electron/vault")).unwrap();
}

#[test]
fn without_an_electron_profile_a_vault_opens() {
    let w = World::new(&[]);
    fs::remove_file(w.profile.join("memry-config.json")).unwrap();

    migrate_vault(&w.ctx(None), Path::new(&w.vault("Fresh"))).unwrap();
}

/// Blocks the run at its first progress update until the test lets it go.
struct Gate {
    started: Mutex<Option<mpsc::Sender<()>>>,
    go: Mutex<mpsc::Receiver<()>>,
}

impl ProgressSink for Gate {
    fn update(&self, _: ProgressUpdate) {
        if let Some(started) = self.started.lock().unwrap().take() {
            started.send(()).unwrap();
            self.go.lock().unwrap().recv().unwrap();
        }
    }
}

/// Red without the lock and the second marker read: the open answers while the run is still
/// going, before the vault is imported (or refuses it).
#[test]
fn an_open_during_the_run_waits_for_it() {
    let w = two_vault_world();
    let (started_tx, started) = mpsc::channel();
    let (go, go_rx) = mpsc::channel();
    let gate = Gate {
        started: Mutex::new(Some(started_tx)),
        go: Mutex::new(go_rx),
    };
    let mut run_ctx = w.ctx(None);
    run_ctx.progress = &gate;
    let open_ctx = w.ctx(None);
    let work = PathBuf::from(w.vault("Work"));

    std::thread::scope(|scope| {
        let run = scope.spawn(|| w.run_with(&run_ctx));
        started.recv().unwrap();
        let open = scope.spawn(|| {
            let result = migrate_vault(&open_ctx, &work);
            (result, Marker::read(&w.data).unwrap().is_some())
        });
        // A lower bound only: time for the open to reach the lock before the run goes on.
        std::thread::sleep(Duration::from_millis(200));
        go.send(()).unwrap();
        run.join().unwrap().unwrap();
        let (result, marker_then) = open.join().unwrap();
        result.unwrap();
        assert!(marker_then, "the open answered after the run finished");
    });
    assert_eq!(w.status("Work"), VaultStatus::Imported);
}

const AWAY_UUID: &str = "4a5b6c7d-0000-4000-8000-0000000000bb";

/// `name` missing at first launch (deferred), then back with its Electron data.
fn deferred(name: &str) -> World {
    let w = World::new(&[("Work", None), (name, Some(AWAY_UUID))]);
    w.electron_vault("Work", Some("4a5b6c7d-0000-4000-8000-000000000001"));
    w.run().unwrap();
    assert_eq!(w.status(name), VaultStatus::Deferred);
    w.electron_vault(name, None);
    w
}

/// Opens `name` through `alias` and checks it was imported. A file system that tells the two
/// strings apart has no folder at `alias`: nothing to import there.
fn opens_as_imported(w: &World, name: &str, alias: &str) {
    let ctx = w.ctx(None);
    migrate_vault(&ctx, Path::new(alias)).unwrap();
    if !Path::new(alias).join(".memry").join("data.db").is_file() {
        return;
    }
    assert!(w.core_data(name).is_file(), "{alias} imported {name}");
    assert_eq!(w.status(name), VaultStatus::Imported, "{alias}");
}

/// Red with the marker matched by the path string alone: the alias finds no entry and the
/// vault would open natively over Electron's data.
#[test]
fn a_deferred_vault_opened_under_another_path_string_is_imported() {
    let w = deferred("Away");
    opens_as_imported(&w, "Away", &format!("{}/", w.vault("Away")));

    let w = deferred("Away");
    let upper = Path::new(&w.vault("Away")).with_file_name("AWAY");
    opens_as_imported(&w, "Away", &upper.to_string_lossy());

    let w = deferred("Caf\u{e9}");
    let nfd = w.vault("Caf\u{e9}").replace("Caf\u{e9}", "Cafe\u{301}");
    opens_as_imported(&w, "Caf\u{e9}", &nfd);
}

#[cfg(unix)]
#[test]
fn a_deferred_vault_opened_through_a_symlink_is_imported() {
    let w = deferred("Away");
    let link = Path::new(&w.vault("Away")).with_file_name("Alias");
    std::os::unix::fs::symlink(w.vault("Away"), &link).unwrap();

    opens_as_imported(&w, "Away", &link.to_string_lossy());
    assert!(w.core_data("Away").is_file());
}

#[test]
fn a_folder_with_electron_data_the_marker_does_not_list_is_refused() {
    let w = World::new(&[("Work", None)]);
    w.electron_vault("Work", Some("4a5b6c7d-0000-4000-8000-000000000001"));
    w.run().unwrap();
    w.electron_vault("Stray", Some(AWAY_UUID));

    let error = migrate_vault(&w.ctx(None), Path::new(&w.vault("Stray"))).unwrap_err();

    assert!(matches!(error, RunError::NotMoved { .. }), "{error}");
    assert!(!w.core_data("Stray").exists());
}
