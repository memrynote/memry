//! Home boards and their covers on a real vault (`data.db` through the core, `.memry/home-covers`
//! on disk), after Electron's `ipc/home-page-handlers.test.ts` and `home/cover-service.test.ts`.
//!
//! | Test                                                          | Rule                                 |
//! | ------------------------------------------------------------- | ------------------------------------ |
//! | widgets are written in `WidgetInstanceSchema` order           | `JSON.stringify(data.widgets)`       |
//! | legacy `{size}` widgets are placed on read, the text kept     | `rowToHomePage`                      |
//! | a widget or framing out of the schema's range is refused      | the zod schemas                      |
//! | an image cover is the board's file, a wash drops the files    | `setHomeCover`, `pruneCoverFiles`    |
//! | a type the vault refuses or a failed write sets nothing       | `not-an-image`, `write-failed`       |
//! | a vault image is read from its note's folder, under the cap   | the `vaultFile` source               |
//! | removing a cover or the board removes its files               | `removeHomeCover`, `delete`          |
//! | reconcile prunes a stale file, never a refused ref's folder   | `reconcileHomeCovers`, #3529 note    |

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::{SecureStoreError, StorageError};
use memry_core::api::home_pages::{BoardChanges, HomePages};
use memry_core::api::vault::Vault;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::attachments::MAX_FILE_SIZE;
use memry_desktop::home::covers::{CoverFailure, CoverImage, SetCoverOutcome};
use memry_desktop::home::{
    CoverFramingInput, HomeBoards, HomePageCreateInput, HomePageUpdateInput, HomePageView,
    WidgetInput,
};
use serde_json::{Map, Value, json};

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<SecureStoreKey, Vec<u8>>>);

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self.0.lock().unwrap().get(&key).cloned())
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().insert(key, value);
        Ok(())
    }
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().remove(&key);
        Ok(())
    }
    fn clear(&self) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().clear();
        Ok(())
    }
}

struct Env {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    /// The core's own handle, for what only a peer or an older build writes.
    core: HomePages,
    boards: HomeBoards,
}

fn env() -> Env {
    let dir = tempfile::Builder::new()
        .prefix("memry-home-boards-")
        .tempdir()
        .expect("tmp");
    let vault = dir.path().join("vault");
    let core_dir = vault.join(".memry").join("core");
    fs::create_dir_all(&core_dir).expect("vault dirs");
    let store: Arc<dyn SecureStore> = Arc::new(MemoryStore::default());
    ensure_device_identity(store.clone()).expect("device identity");
    let core =
        Vault::open("vault".into(), core_dir.to_string_lossy().into_owned()).expect("data.db");
    Env {
        boards: HomeBoards::new(
            vault.clone(),
            core.home_pages(store.clone()).expect("boards"),
        ),
        core: core.home_pages(store).expect("boards"),
        _dir: dir,
        vault,
    }
}

fn create(env: &Env, name: &str) -> HomePageView {
    env.boards
        .create(HomePageCreateInput {
            name: name.into(),
            icon: None,
            position: None,
            widgets: None,
        })
        .expect("create")
}

fn png(name: &str) -> CoverImage {
    CoverImage {
        filename: name.into(),
        bytes: vec![0x89, 0x50, 0x4e, 0x47, 1, 2, 3],
        credit: None,
    }
}

fn saved(outcome: SetCoverOutcome) -> HomePageView {
    match outcome {
        SetCoverOutcome::Saved { page } => *page,
        SetCoverOutcome::Failed { reason } => panic!("not saved: {reason:?}"),
    }
}

fn folder(env: &Env, board: &str) -> PathBuf {
    env.vault.join(".memry").join("home-covers").join(board)
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn stored_widgets(env: &Env, id: &str) -> String {
    env.core.get(id.into()).unwrap().expect("live").widgets
}

fn set_ref(env: &Env, id: &str, cover: Value) {
    let changes = BoardChanges {
        cover: Some(Some(cover)),
        ..BoardChanges::default()
    };
    env.core.update(id.into(), changes).expect("cover");
}

#[test]
fn widgets_are_written_in_schema_order_and_read_back() {
    let env = env();
    let board = create(&env, "Work");
    assert_eq!(stored_widgets(&env, &board.id), "[]");
    let mut config = Map::new();
    config.insert("limit".into(), json!(5));
    let widget = WidgetInput {
        id: "w1".into(),
        kind: "from-a-newer-build".into(),
        x: 0,
        y: 2,
        w: 4,
        h: 3,
        config,
    };
    let updated = env
        .boards
        .update(HomePageUpdateInput {
            id: board.id.clone(),
            name: Some("Work 2".into()),
            icon: None,
            position: None,
            widgets: Some(vec![widget]),
        })
        .unwrap();
    assert_eq!(
        stored_widgets(&env, &board.id),
        r#"[{"id":"w1","type":"from-a-newer-build","x":0,"y":2,"w":4,"h":3,"config":{"limit":5}}]"#
    );
    assert_eq!(updated.name, "Work 2");
    assert_eq!(updated.widgets[0].kind, "from-a-newer-build");
    assert_eq!(updated.widgets[0].h, 3.0);
}

#[test]
fn legacy_size_widgets_are_placed_on_read_and_the_stored_text_is_kept() {
    let env = env();
    let board = create(&env, "Old");
    let legacy = r#"[{"id":"a","type":"inbox","size":"S","config":{}},{"id":"b","type":"tasks","size":"M"}]"#;
    let changes = BoardChanges {
        widgets: Some(legacy.into()),
        ..BoardChanges::default()
    };
    env.core.update(board.id.clone(), changes).unwrap();
    let read = env.boards.get(board.id.clone()).unwrap().expect("live");
    let placed: Vec<_> = read
        .widgets
        .iter()
        .map(|w| (w.id.as_str(), w.x, w.y, w.w, w.h))
        .collect();
    assert_eq!(
        placed,
        vec![("a", 0.0, 0.0, 2.0, 2.0), ("b", 0.0, 2.0, 4.0, 4.0)]
    );
    assert_eq!(
        stored_widgets(&env, &board.id),
        legacy,
        "a read writes nothing"
    );
}

#[test]
fn a_widget_or_framing_outside_the_schema_is_refused() {
    let env = env();
    let board = create(&env, "Work");
    let flat = WidgetInput {
        id: "w".into(),
        kind: "inbox".into(),
        x: 0,
        y: 0,
        w: 0,
        h: 1,
        config: Map::new(),
    };
    let refused = env.boards.update(HomePageUpdateInput {
        id: board.id.clone(),
        name: None,
        icon: None,
        position: None,
        widgets: Some(vec![flat]),
    });
    assert!(
        matches!(refused, Err(StorageError::Invalid { .. })),
        "{refused:?}"
    );
    let zoom = CoverFramingInput {
        zoom: Some(3.5),
        ..CoverFramingInput::default()
    };
    let refused = env.boards.set_cover_framing(board.id, zoom);
    assert!(
        matches!(refused, Err(StorageError::Invalid { .. })),
        "{refused:?}"
    );
}

#[test]
fn an_image_cover_is_the_boards_file_and_a_wash_drops_the_files() {
    let env = env();
    let board = create(&env, "Work");
    let mut photo = png("sky photo.png");
    photo.credit = Some(("Ann".into(), "https://unsplash.com/@ann".into()));
    let page = saved(env.boards.set_image(&board.id, photo).unwrap());
    let cover = page.cover.expect("a cover");
    let prefix = format!(".memry/home-covers/{}/", board.id);
    let name = cover
        .reference
        .strip_prefix(&prefix)
        .expect("in the board's folder");
    assert!(name.ends_with("-sky-photo.png"), "{name}");
    assert_eq!(cover.credit.as_deref(), Some("Ann"));
    assert_eq!(names(&folder(&env, &board.id)), vec![name.to_owned()]);

    let second = saved(env.boards.set_image(&board.id, png("b.png")).unwrap());
    let second_name = second.cover.unwrap().reference[prefix.len()..].to_owned();
    assert_eq!(
        names(&folder(&env, &board.id)),
        vec![second_name],
        "the old file is pruned"
    );

    let washed = saved(env.boards.set_wash(&board.id, "sage").unwrap());
    assert_eq!(washed.cover.unwrap().reference, "wash:sage");
    assert!(names(&folder(&env, &board.id)).is_empty());
    assert_eq!(
        env.boards.set_wash(&board.id, "neon").unwrap(),
        SetCoverOutcome::Failed {
            reason: CoverFailure::Failed
        }
    );
}

#[test]
fn a_refused_type_or_a_failed_write_sets_nothing() {
    let env = env();
    let board = create(&env, "Work");
    assert_eq!(
        env.boards.set_image(&board.id, png("run.exe")).unwrap(),
        SetCoverOutcome::Failed {
            reason: CoverFailure::NotAnImage
        }
    );
    // A file where the covers folder belongs fails the write.
    fs::write(env.vault.join(".memry").join("home-covers"), b"").unwrap();
    assert_eq!(
        env.boards.set_image(&board.id, png("a.png")).unwrap(),
        SetCoverOutcome::Failed {
            reason: CoverFailure::WriteFailed
        }
    );
    assert_eq!(
        env.boards.get(board.id.clone()).unwrap().unwrap().cover,
        None
    );
    assert!(matches!(
        env.boards.set_image("gone", png("a.png")),
        Err(StorageError::NotFound { .. })
    ));
}

#[test]
fn a_vault_image_is_read_from_its_notes_folder_under_the_cap() {
    let env = env();
    let notes = env.vault.join("attachments").join("note-1");
    fs::create_dir_all(&notes).unwrap();
    fs::write(notes.join("sky.png"), b"png").unwrap();
    let image = env.boards.read_vault_image("note-1", "sky.png").unwrap();
    assert_eq!(image.bytes, b"png");
    assert_eq!(
        env.boards.read_vault_image("..", "sky.png"),
        Err(CoverFailure::Failed)
    );
    assert_eq!(
        env.boards.read_vault_image("note-1", "missing.png"),
        Err(CoverFailure::Failed)
    );
    let big = fs::File::create(notes.join("big.png")).unwrap();
    big.set_len(MAX_FILE_SIZE as u64 + 1).unwrap();
    assert_eq!(
        env.boards.read_vault_image("note-1", "big.png"),
        Err(CoverFailure::TooLarge)
    );
}

#[test]
fn removing_the_cover_or_the_board_removes_its_files() {
    let env = env();
    let board = create(&env, "Work");
    saved(env.boards.set_image(&board.id, png("a.png")).unwrap());
    let removed = env.boards.remove_cover(&board.id).unwrap();
    assert_eq!(removed.cover, None);
    assert!(names(&folder(&env, &board.id)).is_empty());

    saved(env.boards.set_image(&board.id, png("a.png")).unwrap());
    assert!(env.boards.delete(board.id.clone()).unwrap());
    assert!(!folder(&env, &board.id).exists());
    assert!(!env.boards.delete(board.id).unwrap(), "no second delete");
}

#[test]
fn reconcile_prunes_a_stale_file_and_keeps_an_nfd_file_under_an_nfc_ref() {
    let env = env();
    let board = create(&env, "Work");
    let dir = folder(&env, &board.id);
    fs::create_dir_all(&dir).unwrap();
    // "café.png": the file in NFD, as HFS+ stored it; the ref in NFC.
    fs::write(dir.join("abc-cafe\u{301}.png"), b"live").unwrap();
    fs::write(dir.join("old.png"), b"stale").unwrap();
    let reference = format!(".memry/home-covers/{}/abc-caf\u{e9}.png", board.id);
    set_ref(&env, &board.id, json!({ "ref": reference }));

    env.boards.reconcile(Some(&board.id)).unwrap();

    assert_eq!(names(&dir), vec!["abc-cafe\u{301}.png".to_owned()]);
}

#[test]
fn reconcile_never_prunes_for_a_ref_this_build_refuses() {
    let env = env();
    let board = create(&env, "Work");
    let dir = folder(&env, &board.id);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("abc-photo."), b"electron's").unwrap();
    for reference in [
        format!(".memry/home-covers/{}/abc-photo.", board.id),
        ".memry/home-covers/other-board/a.png".to_owned(),
    ] {
        set_ref(&env, &board.id, json!({ "ref": reference }));
        env.boards.reconcile(None).unwrap();
        assert_eq!(names(&dir), vec!["abc-photo.".to_owned()], "{reference}");
    }
    set_ref(
        &env,
        &board.id,
        json!({ "ref": "https://example.com/a.png" }),
    );
    env.boards.reconcile(None).unwrap();
    assert!(names(&dir).is_empty(), "a link cover owns no file");
}
