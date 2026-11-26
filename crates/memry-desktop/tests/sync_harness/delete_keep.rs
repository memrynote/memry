//! A pulled delete over a body log with a blob that does not replay, through the shell's wiring
//! ([`SyncWiring`] attached to a real `Session`), against the real Worker. The delete keeps the
//! text of the note's vault file, as Electron does (`keep-unseen-text.ts:46-52`, #5343). The file
//! is reached only through the vault folder `SyncWiring::start` hands the backend
//! (`.with_vault_root(open.path)`): without it the pull falls back to the text of the blobs that
//! replay, which `extract_text` writes without inline marks, and no core or driver-level test
//! can tell.

use std::sync::Arc;
use std::time::{Duration, Instant};

use memry_core::api::errors::StorageError;
use memry_core::api::vault::Vault;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crdt::epoch::HeldBody;
use memry_core::sync::driver::{DriverConfig, SyncDriver};
use memry_core::sync::state::PassTrigger;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::registry::config::AppConfig;
use memry_desktop::registry::vaults::VaultRegistry;
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::vault::consumer::VaultTier;
use zeroize::Zeroizing;

use super::account::{CODE, EMAIL, install};
use super::binding::{attach, new_account, wait_for_binding, wiring_with_tier};
use super::{Online, Server, device_key};
use memry_desktop::account::binding::BindingState;

const FILE: &str = "Plans.md";
const WAIT: Duration = Duration::from_secs(25);

/// Polls `until` on a worker thread's pace, up to [`WAIT`].
async fn eventually<T>(what: &str, mut until: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(found) = until() {
            return found;
        }
        assert!(Instant::now() < deadline, "never saw {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The contents of the inbox's captures.
fn captures(vault: &Vault) -> Vec<String> {
    vault
        .db_handle()
        .call_blocking(|conn| {
            let failed = |error: rusqlite::Error| StorageError::Failed {
                what: error.to_string(),
            };
            let mut statement = conn
                .prepare("SELECT content FROM inbox_items")
                .map_err(failed)?;
            let rows = statement.query_map([], |row| row.get(0)).map_err(failed)?;
            rows.collect::<Result<_, _>>().map_err(failed)
        })
        .expect("the captures")
}

/// A pulled delete over a note with unsent text and one undecodable server blob keeps the vault
/// file's markdown, with its inline marks, not the plain text of the blobs that replay. Red
/// without `.with_vault_root(open.path.clone())` in `SyncWiring::start`: the kept text is then
/// `bold text typed`, with no marks.
#[tokio::test(flavor = "multi_thread")]
async fn a_pulled_delete_over_a_bad_blob_keeps_the_text_of_the_vault_file() {
    let mut server = Server::start();

    // The account's first device: a bare core vault, bound once the app's vault is known.
    let a_store = device_key::with_device_key();
    let (_a_dir, a, phrase) = new_account(&mut server, a_store.clone(), EMAIL).await;

    // The second device: the shell's wiring over a vault holding a note's file.
    let b_store = device_key::without_device_key();
    let (_b_dir, b) = install(&server, b_store.clone());
    b.request_otp(EMAIL.into()).await.unwrap();
    server.otp(EMAIL, CODE);
    assert!(
        b.verify_otp(CODE.into())
            .await
            .unwrap()
            .needs_recovery_input
    );
    b.link_via_recovery(phrase).await.expect("linked");
    let b = Arc::new(b);

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(FILE), "**bold** text\n").unwrap();
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(dir.path().join("vaults.json"))));
    let session = Session::new(registry);
    let tier = VaultTier::new(b_store.clone());
    tier.set_identity(NotesIdentity::new(b_store.clone()));
    tier.register(&session);
    session.open(&root, OpenSource::Select).expect("the vault");
    let open = session.current().unwrap();

    // The account already knows the vault's uuid, so the binding proves ownership and binds a
    // vault that has files without asking (`decide`, `vault-account-binding.ts:79-110`).
    let vault_id = open.vault.id();
    b.session()
        .register_vault(vault_id.clone(), "Mine".into())
        .await
        .expect("the vault is on the account");
    let (b_wiring, b_changes) = wiring_with_tier(&b, &b_store, &session, Some(tier));
    attach(&session, &b_wiring).await;
    wait_for_binding(&b_changes, &BindingState::Bound).await;
    let note = eventually("the note of the file", || {
        let rows = open.vault.note_files().list_paths().unwrap();
        rows.into_iter()
            .find(|(_, path)| path == FILE)
            .map(|(id, _)| id)
    })
    .await;
    let supervisor = session.sync_supervisor().expect("a supervisor");
    for _ in 0..2 {
        assert!(supervisor.sync_now().await.success);
    }

    // A pulls the note and its body.
    let a_dir = tempfile::tempdir().unwrap();
    let data = a_dir.path().join("vault/.memry/core");
    std::fs::create_dir_all(&data).unwrap();
    let peer = Vault::open("peer".into(), data.to_string_lossy().into_owned()).unwrap();
    peer.set_at_rest_key(Some(Zeroizing::new([5u8; 32])))
        .unwrap();
    peer.bind_server_vault(&vault_id).unwrap();
    let driver: SyncDriver = peer
        .sync_driver(
            a.shared_session(),
            Arc::new(Online),
            DriverConfig::desktop(),
            Vec::new(),
            Vec::new(),
        )
        .await
        .expect("the driver");
    for _ in 0..2 {
        driver
            .run_pass(PassTrigger::Explicit)
            .await
            .expect("not paused");
    }
    assert!(
        peer.notes().blocks(note.clone()).unwrap().is_some(),
        "A holds B's body"
    );

    // B types on, without the file taking it, and its log gets one blob no build decodes.
    let blocks = open.vault.notes().blocks(note.clone()).unwrap().unwrap();
    let block_id = blocks.iter().find_map(|b| b.id.clone()).expect("a block");
    let typed = BlockEdit::ReplaceText {
        block_id,
        text: "bold text typed".into(),
        base: None,
    };
    let writer = open.vault.notes_writer(b_store.clone()).unwrap();
    assert!(writer.edit_block(note.clone(), typed).unwrap());
    let doc = note.clone();
    open.vault
        .db_handle()
        .call_blocking(move |conn| {
            HeldBody::never_purged(conn, &doc)
                .and_then(|held| held.append_server_update(1_000_000, &[0xff; 4], 1))
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("bytes no build decodes");

    // A deletes the note; B pulls the signed delete through its wiring.
    peer.notes_writer(a_store.clone())
        .unwrap()
        .delete(note.clone())
        .unwrap();
    driver
        .run_pass(PassTrigger::Explicit)
        .await
        .expect("not paused");
    let _ = supervisor.sync_now().await;
    let kept = eventually("the kept text", || {
        let kept = captures(&open.vault);
        (!kept.is_empty()).then_some(kept)
    })
    .await;

    assert_eq!(kept.len(), 1, "{kept:?}");
    assert!(
        kept[0].contains("**bold** text"),
        "the file's markdown, not the blobs' plain text: {:?}",
        kept[0]
    );
    assert!(
        !kept[0].contains("typed"),
        "the file never took the typing: {:?}",
        kept[0]
    );
}
