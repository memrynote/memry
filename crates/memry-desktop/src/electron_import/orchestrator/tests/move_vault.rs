//! `move_vault`, "Move this vault now" on a folder the open refuses as `NotMoved` (Kaan, 20 Nov,
//! #5140): it imports the folder through the deferred import, after which the folder opens.

use yrs::{ReadTxn as _, Transact as _, XmlFragment as _};

use super::*;
use crate::electron_import::tests::synthetic;

const STRAY_UUID: &str = "4a5b6c7d-0000-4000-8000-0000000000cc";
const WORK_UUID: &str = "4a5b6c7d-0000-4000-8000-000000000001";
const AWAY_UUID: &str = "4a5b6c7d-0000-4000-8000-0000000000bb";

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
    w.electron_vault("Work", Some(WORK_UUID));
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

/// One real note in Electron's legacy global `crdt-store/`, which no vault has claimed.
fn legacy_store(w: &World) {
    store_with_note(&w.profile.join("crdt-store"));
}

/// A y-leveldb store at `dir` holding one real note.
fn store_with_note(dir: &Path) {
    let doc = yrs::Doc::new();
    let text = doc.get_or_insert_xml_fragment("prosemirror");
    {
        let mut txn = doc.transact_mut();
        text.push_back(&mut txn, yrs::XmlTextPrelim::new("legacy note body"));
    }
    let update = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    let mut db = rusty_leveldb::DB::open(dir, rusty_leveldb::Options::default()).unwrap();
    db.put(&synthetic::update_key("legacynote01", 0), &update)
        .unwrap();
    db.flush().unwrap();
}

fn fold(w: &World, name: &str) -> (Value, Value) {
    let report: Value = serde_json::from_str(&w.report()).unwrap();
    let path = w
        .vault(name)
        .replace(&*w.root.path().to_string_lossy(), "<root>");
    let section = report["vaults"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["path"] == path.as_str())
        .unwrap();
    let fold = &section["prep"]["fold"];
    (fold["docs"].clone(), fold["legacy"].clone())
}

/// VERIFY-5140A finding 1: Work, the one vault of the profile, read the unclaimed legacy store at
/// first launch. Moving a folder the config does not name must not fold that note a second
/// time. Red without the recorded reader and without the listed-vault rule (both `read`).
#[test]
fn a_moved_folder_never_reads_the_legacy_store_another_vault_read() {
    let w = World::new(&[("Work", None)]);
    w.electron_vault("Work", Some(WORK_UUID));
    legacy_store(&w);
    w.run().unwrap();
    assert_eq!(fold(&w, "Work"), (json!(1), json!("read")));
    assert_eq!(
        w.marker().unwrap().legacy_store_read_by.as_deref(),
        Some(WORK_UUID)
    );
    w.electron_vault("Stray", Some(STRAY_UUID));

    move_vault(&w.ctx(None), Path::new(&w.vault("Stray"))).unwrap();

    assert_eq!(fold(&w, "Stray"), (json!(0), json!("claimedByOther")));
    assert_eq!(fold(&w, "Work"), (json!(1), json!("read")));
}

/// A folder the config does not name never takes the unclaimed store, even when no vault read
/// it: Electron gave it to none of its vaults at that path.
#[test]
fn a_moved_folder_leaves_an_unclaimed_legacy_store_unread() {
    let w = World::new(&[("Work", None)]);
    w.electron_vault("Work", Some(WORK_UUID));
    w.run().unwrap();
    legacy_store(&w);
    w.electron_vault("Stray", Some(STRAY_UUID));

    move_vault(&w.ctx(None), Path::new(&w.vault("Stray"))).unwrap();

    assert_eq!(fold(&w, "Stray"), (json!(0), json!("leftUnread")));
    assert_eq!(w.marker().unwrap().legacy_store_read_by, None);
}

/// A deferred vault the config names takes the unclaimed store once: its reader is recorded
/// before the import, so an import cut off after it reads the store again for the same vault.
#[test]
fn a_deferred_vault_records_its_legacy_read_before_importing() {
    let w = World::new(&[
        ("Work", None),
        ("Away", Some("4a5b6c7d-0000-4000-8000-0000000000bb")),
    ]);
    w.electron_vault("Work", Some(WORK_UUID));
    store_with_note(
        &w.profile
            .join("crdt-stores")
            .join("4a5b6c7d-0000-4000-8000-000000000001"),
    );
    legacy_store(&w);
    w.run().unwrap();
    assert_eq!(fold(&w, "Work").1, json!("leftUnread"));
    let away = PathBuf::from(w.vault("Away"));
    w.electron_vault("Away", None);
    vault_db::crash::arm("install:data-renamed");

    let crashed = catch_unwind(AssertUnwindSafe(|| migrate_vault(&w.ctx(None), &away)));

    assert!(crashed.is_err());
    assert_eq!(
        w.marker().unwrap().legacy_store_read_by.as_deref(),
        Some(AWAY_UUID)
    );
    migrate_vault(&w.ctx(None), &away).unwrap();
    assert_eq!(fold(&w, "Away"), (json!(1), json!("read")));
}

/// VERIFY-5140A finding 2: Away, missing at first launch, came back at `Away2` and was moved
/// there; the drive then remounts at Away's first path. Its core is intact and it opens. Red
/// without `moved_here`: refused for good as `SharedStore`.
#[test]
fn a_vault_moved_at_another_path_opens_back_at_its_first_path() {
    let uuid = AWAY_UUID;
    let w = World::new(&[("Work", None), ("Away", Some(uuid))]);
    w.electron_vault("Work", Some(WORK_UUID));
    w.run().unwrap();
    w.electron_vault("Away2", Some(uuid));
    move_vault(&w.ctx(None), Path::new(&w.vault("Away2"))).unwrap();
    fs::rename(w.vault("Away2"), w.vault("Away")).unwrap();
    let away = PathBuf::from(w.vault("Away"));
    let core = fs::read(w.core_data("Away")).unwrap();

    migrate_vault(&w.ctx(None), &away).unwrap();
    move_vault(&w.ctx(None), &away).unwrap();

    let marker = w.marker().unwrap();
    let entry = marker
        .vaults
        .iter()
        .find(|v| v.path == w.vault("Away"))
        .unwrap();
    assert_eq!(entry.status, VaultStatus::SameFolder);
    assert_eq!(entry.shared_with, [w.vault("Away2")]);
    assert_eq!(
        fs::read(w.core_data("Away")).unwrap(),
        core,
        "the core is untouched"
    );
}

/// The shared-store guard still holds for a second folder: a copy of the moved vault, its core
/// included, next to the original.
#[test]
fn a_copy_of_a_moved_vault_beside_it_stays_refused() {
    let uuid = AWAY_UUID;
    let w = World::new(&[("Work", None), ("Away", Some(uuid))]);
    w.electron_vault("Work", Some(WORK_UUID));
    w.run().unwrap();
    w.electron_vault("Away2", Some(uuid));
    move_vault(&w.ctx(None), Path::new(&w.vault("Away2"))).unwrap();
    w.electron_vault("Away", Some(uuid));
    let core = w.core_data("Away");
    fs::create_dir_all(core.parent().unwrap()).unwrap();
    fs::copy(w.core_data("Away2"), &core).unwrap();

    let error = migrate_vault(&w.ctx(None), Path::new(&w.vault("Away"))).unwrap_err();

    assert!(matches!(error, RunError::SharedStore { .. }), "{error}");
}

/// Work (its own store) and Away, missing at first launch, and an unclaimed legacy store.
fn away_world(vaults: &[(&str, Option<&str>)]) -> World {
    let w = World::new(vaults);
    if vaults.iter().any(|(name, _)| *name == "Work") {
        w.electron_vault("Work", Some(WORK_UUID));
        store_with_note(&w.profile.join("crdt-stores").join(WORK_UUID));
    }
    legacy_store(&w);
    w.run().unwrap();
    w
}

/// Away comes back at `Away2` and is moved there, then remounts at its first path.
fn move_then_remount(w: &World) {
    w.electron_vault("Away2", Some(AWAY_UUID));
    move_vault(&w.ctx(None), Path::new(&w.vault("Away2"))).unwrap();
    fs::rename(w.vault("Away2"), w.vault("Away")).unwrap();
    migrate_vault(&w.ctx(None), Path::new(&w.vault("Away"))).unwrap();
}

/// VERIFY-5140B P1: the claim follows the vault's uuid, as Electron's does, so Away read at
/// `Away2` takes the legacy store its first path would have taken. Red with the claim keyed by
/// path (`{0, leftUnread}`: no vault ever reads the note).
#[test]
fn a_listed_vault_moved_at_another_path_reads_the_legacy_store() {
    let w = away_world(&[("Work", Some(WORK_UUID)), ("Away", Some(AWAY_UUID))]);
    assert_eq!(fold(&w, "Work").1, json!("leftUnread"));

    move_then_remount(&w);

    assert_eq!(fold(&w, "Away2"), (json!(1), json!("read")));
    assert_eq!(
        w.marker().unwrap().legacy_store_read_by.as_deref(),
        Some(AWAY_UUID)
    );
    assert_eq!(w.status("Away"), VaultStatus::SameFolder);
}

/// VERIFY-5140B P1b, the one-vault profile: worked at 373bd3bb75, red at cb2c21f3c1.
#[test]
fn the_one_vault_moved_at_another_path_reads_the_legacy_store() {
    let w = away_world(&[("Away", Some(AWAY_UUID))]);

    move_then_remount(&w);

    assert_eq!(fold(&w, "Away2"), (json!(1), json!("read")));
}

/// VERIFY-5140B P3: a claim recorded before a crash stays with the vault, which reads the store
/// at the path it comes back at. Red with the claim keyed by path (`{0, claimedByOther}`).
#[test]
fn a_claim_recorded_before_a_crash_is_read_where_the_vault_comes_back() {
    let w = away_world(&[("Work", Some(WORK_UUID)), ("Away", Some(AWAY_UUID))]);
    w.electron_vault("Away", Some(AWAY_UUID));
    vault_db::crash::arm("stage:staged");

    let crashed = catch_unwind(AssertUnwindSafe(|| {
        migrate_vault(&w.ctx(None), Path::new(&w.vault("Away")))
    }));

    assert!(crashed.is_err());
    assert_eq!(
        w.marker().unwrap().legacy_store_read_by.as_deref(),
        Some(AWAY_UUID)
    );
    fs::rename(w.vault("Away"), w.vault("Away2")).unwrap();
    move_vault(&w.ctx(None), Path::new(&w.vault("Away2"))).unwrap();
    assert_eq!(fold(&w, "Away2"), (json!(1), json!("read")));
}

/// A `shared-store` refusal persisted while a copy stood at Away's path heals once the moved
/// vault itself remounts there. Red without the imported-core recheck in `migrate_vault`.
#[test]
fn a_persisted_shared_store_refusal_heals_when_the_moved_vault_remounts() {
    let w = World::new(&[("Work", Some(WORK_UUID)), ("Away", Some(AWAY_UUID))]);
    w.electron_vault("Work", Some(WORK_UUID));
    w.run().unwrap();
    w.electron_vault("Away2", Some(AWAY_UUID));
    move_vault(&w.ctx(None), Path::new(&w.vault("Away2"))).unwrap();
    w.electron_vault("Away", Some(AWAY_UUID));
    let away = PathBuf::from(w.vault("Away"));
    assert!(matches!(
        migrate_vault(&w.ctx(None), &away),
        Err(RunError::SharedStore { .. })
    ));
    fs::remove_dir_all(&away).unwrap();
    fs::rename(w.vault("Away2"), &away).unwrap();

    migrate_vault(&w.ctx(None), &away).unwrap();

    assert_eq!(w.status("Away"), VaultStatus::SameFolder);
}

/// An Electron-only folder at Away's first path (an old backup, no core) while the moved vault's
/// drive is gone stays refused: it never settles `SameFolder` and opens over Electron data with
/// nothing imported. Red without `moved_here`'s core check.
#[test]
fn an_electron_only_folder_at_a_moved_vaults_first_path_stays_refused() {
    let w = World::new(&[("Work", Some(WORK_UUID)), ("Away", Some(AWAY_UUID))]);
    w.electron_vault("Work", Some(WORK_UUID));
    w.run().unwrap();
    w.electron_vault("Away2", Some(AWAY_UUID));
    move_vault(&w.ctx(None), Path::new(&w.vault("Away2"))).unwrap();
    fs::remove_dir_all(w.vault("Away2")).unwrap();
    w.electron_vault("Away", Some(AWAY_UUID));

    let error = migrate_vault(&w.ctx(None), Path::new(&w.vault("Away"))).unwrap_err();

    assert!(matches!(error, RunError::SharedStore { .. }), "{error}");
    assert!(!w.core_data("Away").exists());
}

/// With no Electron config no folder takes the unclaimed legacy store. Red with the no-config
/// rule returning `true`.
#[test]
fn without_a_config_a_moved_folder_leaves_the_legacy_store_unread() {
    let w = stray_world();
    legacy_store(&w);
    fs::remove_file(w.profile.join("memry-config.json")).unwrap();
    // The profile is still found, by its secret store.
    fs::write(
        w.profile
            .join(crate::electron_import::profile::SECRET_STORE_FILENAME),
        "{}",
    )
    .unwrap();

    move_vault(&w.ctx(None), Path::new(&w.vault("Stray"))).unwrap();

    assert_eq!(fold(&w, "Stray"), (json!(0), json!("leftUnread")));
}

/// A process writing a marker it read before another process recorded the legacy claim keeps
/// the claim. Red with a plain write.
#[test]
fn a_stale_marker_write_keeps_the_recorded_legacy_claim() {
    let w = stray_world();
    let stale = w.marker().unwrap();
    let mut claimed = stale.clone();
    claimed.legacy_store_read_by = Some(STRAY_UUID.to_owned());
    claimed.write(&w.data).unwrap();

    stale.write(&w.data).unwrap();

    assert_eq!(
        w.marker().unwrap().legacy_store_read_by.as_deref(),
        Some(STRAY_UUID)
    );
}

/// Away, with no uuid in its `data.db` or the config and missing at first launch, comes back;
/// its first import fails in the fold, after its claim, then is retried. Returns the claim.
/// The fold fails because the legacy store's `CURRENT` names a manifest that is not there, a
/// fault that needs no permissions and so runs on every OS.
fn fail_away_after_its_claim(w: &World) -> String {
    let away = PathBuf::from(w.vault("Away"));
    w.electron_vault("Away", None);
    let current = w.profile.join("crdt-store").join("CURRENT");
    let intact = fs::read(&current).unwrap();
    fs::write(&current, "MANIFEST-999999\n").unwrap();
    let failed = migrate_vault(&w.ctx(None), &away);
    fs::write(&current, intact).unwrap();
    assert!(failed.is_err(), "the fold failed");
    let claim = w.marker().unwrap().legacy_store_read_by.unwrap();
    migrate_vault(&w.ctx(None), &away).unwrap();
    claim
}

/// VERIFY-5140C C4: the retry at the same path imports under the id the claim names and reads
/// the note once. Red with the minted id not kept in the marker entry (`{0, claimedByOther}`).
#[test]
fn a_uuidless_vault_whose_fold_failed_after_its_claim_reads_the_store_on_retry() {
    let w = away_world(&[("Work", Some(WORK_UUID)), ("Away", None)]);

    let claim = fail_away_after_its_claim(&w);

    assert_eq!(fold(&w, "Away"), (json!(1), json!("read")));
    assert_eq!(fold(&w, "Work"), (json!(1), json!("leftUnread")));
    let marker = w.marker().unwrap();
    let away = marker.vaults.iter().find(|v| v.path == w.vault("Away"));
    assert_eq!(away.unwrap().vault_uuid.as_deref(), Some(claim.as_str()));
}

/// VERIFY-5140C finding 3: a profile whose one vault was last opened in Electron before June
/// 2026 (no singleton, no config `vaultUuid`) reads the unclaimed legacy store as a listed vault
/// with a uuid does, a failed first attempt included. Red with the minted id not kept.
#[test]
fn a_pre_june_profiles_uuidless_vault_reads_the_legacy_store() {
    let w = away_world(&[("Away", None)]);

    fail_away_after_its_claim(&w);

    assert_eq!(fold(&w, "Away"), (json!(1), json!("read")));
}

/// Electron keeps a stale config entry for a moved vault (`crdt-store-path.ts:70`): Away, gone,
/// and Away2 carry the same `vaultUuid`. Away2 is listed, so it never stands at Away's place;
/// Work, the first present vault without a store, reads the store, and only Work. Red without
/// `place`'s `!distinct.contains(vault_path)`: Away2 reads it too.
#[test]
fn a_listed_vault_never_stands_in_for_a_gone_entry_with_its_uuid() {
    let w = World::new(&[
        ("Away", Some(AWAY_UUID)),
        ("Work", None),
        ("Away2", Some(AWAY_UUID)),
    ]);
    w.electron_vault("Work", Some(WORK_UUID));
    w.electron_vault("Away2", Some(AWAY_UUID));
    legacy_store(&w);

    w.run().unwrap();

    assert_eq!(fold(&w, "Work"), (json!(1), json!("read")));
    assert_eq!(fold(&w, "Away2"), (json!(0), json!("leftUnread")));
}
