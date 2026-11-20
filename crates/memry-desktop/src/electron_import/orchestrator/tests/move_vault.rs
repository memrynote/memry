//! `move_vault`, "Move this vault now" on a folder the open refuses as `NotMoved` (Kaan, 20 Nov,
//! #5140): it imports the folder through the deferred import, after which the folder opens.

use super::*;

const STRAY_UUID: &str = "4a5b6c7d-0000-4000-8000-0000000000cc";

struct Quiet;

impl ProgressSink for Quiet {
    fn update(&self, _: ProgressUpdate) {}
}

impl MigrationTelemetry for Quiet {
    fn record(&self, _: MigrationEvent) {}
}

/// Work migrated at first launch, then `Stray`, a folder with Electron data that the config
/// does not name, as a copied-in folder or a vault back at another path is.
fn stray_world() -> World {
    let w = World::new(&[("Work", None)]);
    w.electron_vault("Work", Some("4a5b6c7d-0000-4000-8000-000000000001"));
    w.run().unwrap();
    w.electron_vault("Stray", Some(STRAY_UUID));
    w
}

/// A session whose open runs `migrate_vault`, as the shell installs it.
fn session(w: &World) -> Session {
    let config = Arc::new(AppConfig::load(w.data.join("session-config.json")));
    let session = Session::new(VaultRegistry::new(config));
    let ctx = w.ctx(None);
    let (env, data) = (ctx.env, ctx.tauri_data_dir);
    session.set_vault_migrator(Arc::new(move |path| {
        let ctx = ImportContext {
            env: env.clone(),
            tauri_data_dir: data.clone(),
            progress: &Quiet,
            telemetry: &Quiet,
            crash_after: None,
            now_ms: || 1_800_000_000_000,
            free_space: |_| Ok(u64::MAX),
        };
        migrate_vault(&ctx, path).map_err(|e| e.to_string())
    }));
    session
}

fn stray_entry(w: &World) -> Option<VaultStatus> {
    let path = w.vault("Stray");
    let marker = w.marker().unwrap();
    marker
        .vaults
        .iter()
        .find(|v| v.path == path)
        .map(|v| v.status)
}

/// Red with `move_vault` = `migrate_vault`: the folder stays `NotMoved`. Red with the deferred
/// import planning only the config's paths: Stray settles as `NoData` and opens natively over
/// Electron's data, with no core imported.
#[test]
fn a_folder_the_run_did_not_list_is_refused_until_moved_and_then_opens() {
    let w = stray_world();
    let stray = PathBuf::from(w.vault("Stray"));
    let session = session(&w);

    let Err(SessionError::Invalid(refused)) = session.open(&stray, OpenSource::Select) else {
        panic!("opened before the move");
    };
    assert!(refused.contains("did not move"), "{refused}");
    assert!(!w.core_data("Stray").exists());

    move_vault(&w.ctx(None), &stray).unwrap();

    assert_eq!(w.status("Stray"), VaultStatus::Imported);
    assert_eq!(stray_entry(&w), Some(VaultStatus::Imported));
    session.open(&stray, OpenSource::Select).unwrap();
    session.close();
    // Settled: a second move only reads the marker.
    move_vault(&w.ctx(None), &stray).unwrap();
}

/// The refusal then carries the import's error, not `NotMoved` (red with `move_vault` =
/// `migrate_vault`), and Step 36 writes nothing in the folder before its checks pass.
#[test]
fn a_failed_move_leaves_the_folder_refused_and_untouched() {
    let w = stray_world();
    let stray = PathBuf::from(w.vault("Stray"));
    let conn = Connection::open(stray.join(".memry/data.db")).unwrap();
    electron_db::seed(&conn, "attachment_files", &[]);
    drop(conn);
    let before = tree(&stray);

    let error = move_vault(&w.ctx(None), &stray).unwrap_err();

    assert_eq!(error.check(), "not-ready", "{error}");
    assert_eq!(tree(&stray), before, "the folder is as it was");
    assert!(
        migrate_vault(&w.ctx(None), &stray).is_err(),
        "still refused"
    );
    assert_eq!(tree(&stray), before);
    assert_eq!(stray_entry(&w), Some(VaultStatus::Deferred));
}

/// The deferred entry is written before the import, so a move cut off at any stage or install
/// point leaves the folder `Pending`, and the next call finishes it. Red without that entry.
#[test]
fn a_move_cut_off_anywhere_finishes_on_the_next_try() {
    for point in [
        "stage:staged",
        "install:index-renamed",
        "install:data-renamed",
    ] {
        let w = stray_world();
        let stray = PathBuf::from(w.vault("Stray"));
        vault_db::crash::arm(point);

        let crashed = catch_unwind(AssertUnwindSafe(|| move_vault(&w.ctx(None), &stray)));

        assert!(crashed.is_err(), "{point} crashed");
        assert_eq!(stray_entry(&w), Some(VaultStatus::Deferred), "{point}");
        move_vault(&w.ctx(None), &stray).unwrap();
        assert_eq!(w.status("Stray"), VaultStatus::Imported, "{point}");
        assert_eq!(stray_entry(&w), Some(VaultStatus::Imported), "{point}");
        assert!(w.core_data("Stray").is_file(), "{point}");
    }
}
