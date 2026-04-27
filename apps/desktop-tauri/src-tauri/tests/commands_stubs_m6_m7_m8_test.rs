use memry_desktop_tauri_lib::app_state::AppState;
use memry_desktop_tauri_lib::auth::linking::PendingLinkingRegistry;
use memry_desktop_tauri_lib::auth::AuthRuntime;
use memry_desktop_tauri_lib::commands::stubs_m6_m7_m8::{
    notes_get_file_inner, notes_open_external_inner, notes_reveal_in_finder_inner,
};
use memry_desktop_tauri_lib::crdt::CrdtRuntime;
use memry_desktop_tauri_lib::db::note_metadata::{self, NoteMetadataRow};
use memry_desktop_tauri_lib::db::Db;
use memry_desktop_tauri_lib::keychain::{KeychainStore, MemoryKeychain};
use memry_desktop_tauri_lib::vault::VaultRuntime;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

fn fresh_state() -> AppState {
    let db = Db::open_memory().expect("memory db must open");
    let root = std::env::temp_dir().join(format!("memry-stubs-test-{}", nanoid::nanoid!(12)));
    let vault = Arc::new(VaultRuntime::open_for_test(root).expect("test vault must open"));
    let keychain: Arc<dyn KeychainStore> = Arc::new(MemoryKeychain::new());
    let auth = Arc::new(AuthRuntime::new(keychain));
    let linking = Arc::new(PendingLinkingRegistry::new());
    AppState::new(db, vault, auth, linking, Arc::new(CrdtRuntime::new()))
}

fn seed_file_note(state: &AppState, id: &str, relative_path: &str) {
    let root = state.vault.require_current().expect("vault root");
    let absolute_path = root.join(relative_path);
    std::fs::create_dir_all(absolute_path.parent().expect("file parent")).unwrap();
    std::fs::write(&absolute_path, b"pdfdata").unwrap();

    state
        .db
        .with_conn(|conn| {
            note_metadata::upsert(
                conn,
                &NoteMetadataRow {
                    id: id.to_string(),
                    path: relative_path.to_string(),
                    title: "Spec PDF".to_string(),
                    emoji: None,
                    file_type: "pdf".to_string(),
                    mime_type: Some("application/pdf".to_string()),
                    file_size: Some(7),
                    attachment_id: None,
                    attachment_references: None,
                    local_only: false,
                    sync_policy: "default".to_string(),
                    journal_date: None,
                    property_definition_names: None,
                    clock: None,
                    synced_at: None,
                    created_at: "2026-04-26T10:00:00Z".to_string(),
                    modified_at: "2026-04-26T11:00:00Z".to_string(),
                },
            )
        })
        .unwrap();
}

#[test]
fn notes_get_file_returns_non_markdown_file_metadata() {
    let state = fresh_state();
    seed_file_note(&state, "file-1", "Assets/spec.pdf");

    let metadata = notes_get_file_inner(&state, "file-1")
        .unwrap()
        .expect("file metadata");

    assert_eq!(metadata.id, "file-1");
    assert_eq!(metadata.path, "Assets/spec.pdf");
    assert_eq!(metadata.title, "Spec PDF");
    assert_eq!(metadata.file_type, "pdf");
    assert_eq!(metadata.mime_type.as_deref(), Some("application/pdf"));
    assert_eq!(metadata.file_size, Some(7));
    assert_eq!(metadata.created, "2026-04-26T10:00:00Z");
    assert_eq!(metadata.modified, "2026-04-26T11:00:00Z");
    assert_eq!(
        Path::new(&metadata.absolute_path),
        state
            .vault
            .require_current()
            .unwrap()
            .join("Assets/spec.pdf")
    );
}

#[test]
fn notes_open_external_delegates_absolute_vault_path_to_shell_seam() {
    let state = fresh_state();
    seed_file_note(&state, "file-1", "Assets/spec.pdf");
    let opened = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let opened_for_call = Arc::clone(&opened);

    notes_open_external_inner(&state, "file-1", |path| {
        opened_for_call.lock().unwrap().push(path.to_path_buf());
        Ok(())
    })
    .unwrap();

    assert_eq!(
        opened.lock().unwrap().as_slice(),
        &[state
            .vault
            .require_current()
            .unwrap()
            .join("Assets/spec.pdf")]
    );
}

#[test]
fn notes_reveal_in_finder_delegates_absolute_vault_path_to_shell_seam() {
    let state = fresh_state();
    seed_file_note(&state, "file-1", "Assets/spec.pdf");
    let revealed = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let revealed_for_call = Arc::clone(&revealed);

    notes_reveal_in_finder_inner(&state, "file-1", |path| {
        revealed_for_call.lock().unwrap().push(path.to_path_buf());
        Ok(())
    })
    .unwrap();

    assert_eq!(
        revealed.lock().unwrap().as_slice(),
        &[state
            .vault
            .require_current()
            .unwrap()
            .join("Assets/spec.pdf")]
    );
}
