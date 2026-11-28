//! Stage 36b4 through the first session after the import: an Electron vault's device-local
//! settings, lock file modes and a field rename a locked note held, imported, installed and
//! opened with the services that own them.

use std::path::Path;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Instant;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::electron_import::ProfileLock;
use memry_desktop::electron_import::vault_db::{VaultImportInput, stage_vault_import};
use memry_desktop::locks::{self, TargetKind};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::service::NotesService;
use memry_desktop::registry::AppConfig;
use memry_desktop::settings::SettingsService;
use memry_desktop::tags::schema::rename::register_resume;
use rusqlite::Connection;
use rusqlite::types::Value;
use serde_json::json;

use super::desktop_records::seed_lock;
use super::settings::seed;
use super::vault_env::{Env, WAIT, env, indexed};
use super::{ELECTRON_DEVICE, NOW_MS, electron_db, electron_profile, staged};

struct Opened {
    e: Env,
    notes: Arc<NotesService>,
    store: Arc<dyn SecureStore>,
    /// One message for each field rename the open resumed (`register_resume`'s `finished`).
    resumed: mpsc::Receiver<()>,
}

fn text(s: &str) -> Value {
    Value::Text(s.into())
}

fn note(conn: &Connection, id: &str, path: &str) {
    electron_db::seed(
        conn,
        "note_metadata",
        &[
            ("id", text(id)),
            ("path", text(path)),
            ("title", text(id)),
            ("file_type", text("markdown")),
            ("local_only", Value::Integer(0)),
            ("clock", text(r#"{"dev-A":1}"#)),
            ("synced_at", text("2026-01-04T00:00:00.000Z")),
            ("created_at", text("2026-01-02T03:04:05.000Z")),
            ("modified_at", text("2026-01-03T03:04:05.000Z")),
        ],
    );
}

/// Electron's vault over `files`, seeded by `seed_data` (given the vault folder, its files
/// written), imported and installed, then opened
/// with the lock guard, the note index and the field rename's resume at open, as the shell
/// registers them, its first walk done.
fn import_and_open(files: &[(&str, &str)], seed_data: impl FnOnce(&Connection, &Path)) -> Opened {
    let kept: Mutex<Option<Arc<dyn SecureStore>>> = Mutex::default();
    let mut e = env(|s| {
        *kept.lock().unwrap() = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    let store = kept.into_inner().unwrap().unwrap();
    locks::register(&e.session);
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let (resume, resumed) = mpsc::channel();
    let resume = Mutex::new(resume);
    register_resume(
        &notes,
        &index,
        &e.session,
        Arc::new(move || {
            let _ = resume.lock().unwrap().send(());
        }),
    );

    let pair = electron_db::create_pair(&e.vault.join(".memry"));
    for (path, body) in files {
        e.write(path, body);
    }
    seed_data(&Connection::open(&pair.data).unwrap(), &e.vault);
    let profile = electron_profile(e._dir.path());
    let lock = ProfileLock::probe(&profile).unwrap();
    let input = VaultImportInput {
        electron_closed: &lock,
        vault_dir: e.vault.clone(),
        vault_id: "vault-1".into(),
        electron_data_db: pair.data.clone(),
        electron_index_db: pair.index.clone(),
        docs: Vec::new(),
        extra_owed_docs: Vec::new(),
        vault_key: None,
        electron_device_id: Some(ELECTRON_DEVICE.into()),
        now_ms: NOW_MS,
        progress: None,
    };
    staged(stage_vault_import(input).unwrap())
        .install()
        .unwrap();
    drop(lock);
    e.open();
    e.facts_until(indexed);
    Opened {
        e,
        notes,
        store,
        resumed,
    }
}

/// The onboarding, clock, date, zoom and editor layout of this device live only in Electron's
/// `general` and `editor` rows; the theme is synced. After the import and the first open's
/// settings pass, the tour is done and every local value is Electron's, while the synced theme
/// still wins over the row's.
#[test]
fn local_settings_survive_the_import_and_the_first_open() {
    let o = import_and_open(&[], |conn, _| {
        seed(
            conn,
            "general",
            r#"{"theme":"light","onboardingCompleted":true,"clockFormat":"24h","dateFormat":"YYYY-MM-DD","zoomFactor":1.25,"startOnBoot":true}"#,
        );
        seed(
            conn,
            "editor",
            r#"{"width":"full","toolbarMode":"sticky","spellCheck":true,"convertChecklistsToTasks":false}"#,
        );
        seed(conn, "synced_settings", r#"{"general":{"theme":"dark"}}"#);
        seed(
            conn,
            "synced_settings_clocks",
            r#"{"general.theme":{"dev-A":2}}"#,
        );
    });
    let settings = SettingsService::new(
        o.store.clone(),
        Arc::new(AppConfig::load(
            o.e._dir.path().join("settings-config.json"),
        )),
    );
    let open = o.e.session.current().unwrap();
    settings.on_open(&open).unwrap();

    let general = settings.read_group(Some(&open), "general").unwrap().value;
    for (field, value) in [
        ("onboardingCompleted", json!(true)),
        ("clockFormat", json!("24h")),
        ("dateFormat", json!("YYYY-MM-DD")),
        ("zoomFactor", json!(1.25)),
        ("startOnBoot", json!(true)),
        ("theme", json!("dark")),
    ] {
        assert_eq!(general.get(field), Some(&value), "general.{field}");
    }
    let editor = settings.read_group(Some(&open), "editor").unwrap().value;
    for (field, value) in [
        ("width", json!("full")),
        ("toolbarMode", json!("sticky")),
        ("spellCheck", json!(true)),
        // Synced: the row's value is not read, and the synced record has none.
        ("convertChecklistsToTasks", json!(true)),
    ] {
        assert_eq!(editor.get(field), Some(&value), "editor.{field}");
    }
}

#[cfg(unix)]
fn mode(e: &Env, rel: &str) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(e.vault.join(rel))
        .unwrap()
        .permissions()
        .mode()
        & 0o777
}

#[cfg(unix)]
fn until_mode(e: &Env, rel: &str, want: u32) {
    let deadline = Instant::now() + WAIT;
    while mode(e, rel) != want {
        assert!(
            Instant::now() < deadline,
            "{rel}: {:o}, want {want:o}",
            mode(e, rel)
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Two notes Electron locked at 0o640, left read-only on disk, one recorded with Electron's
/// `ino:birthtimeMs` identity and one with none (an older Electron row). The first open keeps
/// both saved modes, so an unlock gives Plan.md its 0o640 back, not the read-only bits.
#[cfg(unix)]
#[test]
fn an_unlock_after_the_import_gives_back_electrons_saved_mode() {
    use std::os::unix::fs::PermissionsExt;
    let mut o = import_and_open(
        &[("Plan.md", "Plan\n"), ("Other.md", "Other\n")],
        |conn, vault| {
            for (id, path, identity) in [
                ("n-plan", "Plan.md", text("4242:1767000000000.25")),
                ("n-other", "Other.md", Value::Null),
            ] {
                note(conn, id, path);
                seed_lock(
                    conn,
                    &format!("note:{id}"),
                    "note",
                    id,
                    text(r#"{"dev-A":1}"#),
                );
                electron_db::seed(
                    conn,
                    "vault_lock_file_modes",
                    &[
                        ("path", text(path)),
                        ("mode", Value::Integer(0o100640)),
                        ("identity", identity),
                    ],
                );
                // Electron's lock left the file read-only.
                std::fs::set_permissions(vault.join(path), std::fs::Permissions::from_mode(0o440))
                    .unwrap();
            }
        },
    );
    assert_eq!(mode(&o.e, "Plan.md"), 0o440);

    o.e.core()
        .locks()
        .set(TargetKind::Note, "n-plan", false, "device-a")
        .unwrap();
    o.e.close();
    o.e.open();
    o.e.facts_until(indexed);

    until_mode(&o.e, "Plan.md", 0o640);
    assert_eq!(mode(&o.e, "Other.md"), 0o440, "Other.md is still locked");
}

const ELIF: &str = "---\ntags: [person]\nPhone: '222'\n---\nE\n";

/// Electron's field rename skipped a locked note and kept its job (`field-rename.ts:173`). After
/// the import the job is the core's, and the unlock finishes it (`resumeFieldRenameAfterUnlock`).
/// The dismissed preset offer reaches its owner too.
#[test]
fn a_field_rename_a_locked_note_held_finishes_after_the_import() {
    let o = import_and_open(&[("Elif.md", ELIF)], |conn, _| {
        note(conn, "n-elif", "Elif.md");
        seed_lock(
            conn,
            "note:n-elif",
            "note",
            "n-elif",
            text(r#"{"dev-A":1}"#),
        );
        seed(
            conn,
            "tags.fieldRenameJob",
            r#"{"from":"Phone","to":"Mobile","runId":"r1"}"#,
        );
        seed(conn, "tagFields.presetOfferDismissed", "1");
    });
    assert!(o.e.core().field_rename_recorded().unwrap().is_some());
    let dismissed =
        o.e.core()
            .db_handle()
            .call_blocking(|conn| memry_core::domain::tag_schema::preset_offer_dismissed(conn))
            .unwrap();
    assert!(dismissed);

    let open = o.e.session.current().unwrap();
    // The rename finds its notes through the index, which reads a new note after the walk.
    let deadline = Instant::now() + WAIT;
    while open
        .search
        .notes_holding_properties(vec!["Phone".to_owned()])
        .unwrap()
        .is_empty()
    {
        assert!(Instant::now() < deadline, "the index never read Phone");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let (renamed, done) = mpsc::channel();
    let unlocked = locks::set(
        &open,
        &o.notes,
        TargetKind::Note,
        "n-elif",
        false,
        move || {
            let _ = renamed.send(());
        },
    )
    .unwrap();
    assert!(unlocked.changed);
    done.recv_timeout(WAIT)
        .expect("the unlock resumes the rename");
    assert!(
        o.e.read("Elif.md").contains("Mobile: '222'"),
        "{}",
        o.e.read("Elif.md")
    );
    assert!(o.e.core().field_rename_recorded().unwrap().is_none());
}

/// The first open after the import resumes the imported field rename on a fresh index. The
/// locked note holds it: the resume must find the note (the index read it) and keep the job,
/// across a restart too, until the unlock finishes it.
#[test]
fn the_first_open_keeps_an_imported_field_rename_a_locked_note_holds() {
    let mut o = import_and_open(&[("Elif.md", ELIF)], |conn, _| {
        note(conn, "n-elif", "Elif.md");
        seed_lock(
            conn,
            "note:n-elif",
            "note",
            "n-elif",
            text(r#"{"dev-A":1}"#),
        );
        seed(
            conn,
            "tags.fieldRenameJob",
            r#"{"from":"Phone","to":"Mobile","runId":"r1"}"#,
        );
    });
    o.resumed
        .recv_timeout(WAIT)
        .expect("the first open resumes the imported rename");
    assert!(
        o.e.core().field_rename_recorded().unwrap().is_some(),
        "the first open dropped the rename Elif.md holds"
    );
    assert!(o.e.read("Elif.md").contains("Phone: '222'"));

    o.e.close();
    o.e.open();
    o.e.facts_until(indexed);
    o.resumed
        .recv_timeout(WAIT)
        .expect("the next open resumes the rename again");
    assert!(
        o.e.core().field_rename_recorded().unwrap().is_some(),
        "the restart dropped the rename Elif.md holds"
    );

    let open = o.e.session.current().unwrap();
    let (renamed, done) = mpsc::channel();
    let unlocked = locks::set(
        &open,
        &o.notes,
        TargetKind::Note,
        "n-elif",
        false,
        move || {
            let _ = renamed.send(());
        },
    )
    .unwrap();
    assert!(unlocked.changed);
    done.recv_timeout(WAIT)
        .expect("the unlock resumes the rename");
    assert!(
        o.e.read("Elif.md").contains("Mobile: '222'"),
        "{}",
        o.e.read("Elif.md")
    );
    assert!(o.e.core().field_rename_recorded().unwrap().is_none());
}
