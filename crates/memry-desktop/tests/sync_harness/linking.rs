//! Device linking against the real Worker (`sync/linking-service.ts`, chapter 03): one profile
//! shows the code and approves, a second profile signed in by email code scans it. The approver's
//! master key reaches the new device's keychain only after the key is proven to be the account's,
//! the account's vaults arrive with it, and a removed device is refused by the server.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use memry_core::api::errors::{ApiError, AuthError};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::account::{
    AccountError, AccountService, LinkPoll, VaultChoice, dormant_vault_folder_name,
};
use memry_desktop::registry::config::AppConfig;
use memry_desktop::registry::vaults::VaultRegistry;
use memry_desktop::session::Session;
use tokio::sync::oneshot;

use super::account::{EMAIL, install, sign_in};
use super::{Server, device_key};

const HOME: &str = "0b9f3c8e-5d4a-4c1e-9a7b-2f6e8d1c3a50";
const WORK: &str = "7e2d1a6c-9b3f-4e8a-8c5d-4a1f0e9b7d21";

/// The approver: a new account, set up and confirmed, with a paid plan and `vaults` on it.
async fn approver(
    server: &mut Server,
    vaults: &[&str],
) -> (tempfile::TempDir, AccountService, Arc<dyn SecureStore>) {
    let store = device_key::with_device_key();
    let (dir, account) = install(server, store.clone());
    assert!(sign_in(server, &account).await.needs_setup);
    account.setup_new_account().await.expect("setup");
    account.confirm_recovery_phrase(true).unwrap();
    server.entitle(EMAIL);
    for (at, id) in vaults.iter().enumerate() {
        account
            .session()
            .register_vault((*id).to_owned(), format!("Vault {at}"))
            .await
            .expect("the vault is on the account");
    }
    (dir, account, store)
}

/// The new device: its own keychain (no device key yet), signed in by email code and asked for the
/// phrase, with a session that has `open` as its vault.
async fn new_device(
    server: &mut Server,
    open: bool,
) -> (
    tempfile::TempDir,
    Arc<AccountService>,
    Arc<dyn SecureStore>,
    Session,
) {
    let store = device_key::without_device_key();
    let (dir, account) = install(server, store.clone());
    let verified = sign_in(server, &account).await;
    assert!(verified.needs_recovery_input, "{verified:?}");
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(dir.path().join("vaults.json"))));
    let session = Session::new(registry);
    if open {
        session
            .create(dir.path(), "Mine")
            .expect("a vault of its own");
    }
    (dir, Arc::new(account), store, session)
}

/// Scans the approver's code, compares the six digits on both sides, approves, and polls until
/// the link is approved. Returns the poll's answer and the background finalize's outcome.
async fn link(
    approver: &AccountService,
    device: &Arc<AccountService>,
    session: &Session,
) -> (
    String,
    LinkPoll,
    oneshot::Receiver<Result<String, AccountError>>,
) {
    let qr = approver.generate_linking_qr().await.expect("a code");
    let scan = device.link_via_qr(qr.qr_data).await.expect("the scan");
    assert_eq!(scan.session_id, qr.session_id);
    let sas = approver
        .linking_sas(&qr.session_id)
        .await
        .expect("the approver's code");
    assert_eq!(sas, scan.verification_code, "both sides show one code");
    approver
        .approve_linking(&qr.session_id)
        .await
        .expect("the approval");

    for _ in 0..40 {
        let (sender, finalized) = oneshot::channel();
        let poll = device
            .complete_linking_qr(session, &qr.session_id, move |outcome| {
                let _ = sender.send(outcome);
            })
            .await
            .expect("a poll");
        match poll {
            LinkPoll::Waiting | LinkPoll::RateLimited => {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            linked @ LinkPoll::Linked { .. } => return (qr.session_id, linked, finalized),
        }
    }
    panic!("the link was never approved");
}

fn master(store: &Arc<dyn SecureStore>) -> Option<Vec<u8>> {
    store
        .get(SecureStoreKey::MasterKey)
        .expect("a readable store")
}

fn bound(session: &Session) -> Option<String> {
    let open = session.current().expect("an open vault");
    open.vault.server_vault_id().expect("the binding")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_scanned_code_brings_the_accounts_key_and_vault_and_a_removed_device_is_refused() {
    let mut server = Server::start();
    let (_a_dir, a, a_store) = approver(&mut server, &[HOME]).await;
    let (_b_dir, b, b_store, session) = new_device(&mut server, true).await;

    let (_, poll, finalized) = link(&a, &b, &session).await;

    assert_eq!(poll, LinkPoll::Linked { vaults: None });
    let device_id = tokio::time::timeout(Duration::from_secs(30), finalized)
        .await
        .expect("the finalize ends")
        .expect("it reports")
        .expect("the device registers");
    assert_eq!(master(&b_store), master(&a_store), "the account's key");
    assert_eq!(bound(&session).as_deref(), Some(HOME), "the open vault");
    let info = b.info();
    assert!(info.signed_in, "{info:?}");
    assert_eq!(info.device_id.as_deref(), Some(device_id.as_str()));
    let listed = a.devices().await;
    assert!(
        listed.devices.iter().any(|d| d.id == device_id),
        "{listed:?}"
    );

    let error = b.remove_device(device_id.clone()).await.unwrap_err();
    assert!(
        matches!(error, AccountError::CannotRemoveCurrentDevice),
        "{error:?}"
    );
    a.remove_device(device_id.clone())
        .await
        .expect("the approver removes it");

    let refused = b.session().devices().await.unwrap_err();
    assert!(
        matches!(
            refused,
            AuthError::Api {
                source: ApiError::DeviceRevoked { .. }
            }
        ),
        "{refused:?}"
    );
}

/// The approver holds a key that is not the account's (its verifier does not match the server's).
/// The new device registers nothing and keeps no key: the SAS proves the channel, not the key.
#[tokio::test(flavor = "multi_thread")]
async fn a_key_that_is_not_the_accounts_is_refused_and_nothing_is_registered() {
    let mut server = Server::start();
    let (_a_dir, a, a_store) = approver(&mut server, &[]).await;
    a_store
        .set(SecureStoreKey::MasterKey, vec![3u8; 32])
        .unwrap();
    let (_b_dir, b, b_store, session) = new_device(&mut server, false).await;

    let (_, poll, finalized) = link(&a, &b, &session).await;

    assert_eq!(poll, LinkPoll::Linked { vaults: None });
    let error = tokio::time::timeout(Duration::from_secs(30), finalized)
        .await
        .expect("the finalize ends")
        .expect("it reports")
        .unwrap_err();
    assert!(
        matches!(error, AccountError::LinkedKeyMismatch),
        "{error:?}"
    );
    assert_eq!(master(&b_store), None, "no key is kept");
    let info = b.info();
    assert!(!info.signed_in && info.device_id.is_none(), "{info:?}");
    assert!(b.session().registered_device_id().is_err());
}

/// Two account vaults: the key waits for the user's pick. A pick whose primary is not among the
/// selected keeps the choice; the next pick provisions the primary beside the open vault, opens
/// it bound to the account's vault, and registers the device.
#[tokio::test(flavor = "multi_thread")]
async fn a_vault_choice_waits_for_a_valid_pick_and_opens_the_primary_bound() {
    let mut server = Server::start();
    let (_a_dir, a, a_store) = approver(&mut server, &[HOME, WORK]).await;
    let (b_dir, b, b_store, session) = new_device(&mut server, true).await;
    let mine = session.current().expect("its own vault").path;

    let (session_id, poll, _finalized) = link(&a, &b, &session).await;

    let LinkPoll::Linked {
        vaults: Some(mut vaults),
    } = poll
    else {
        panic!("a choice: {poll:?}");
    };
    vaults.sort();
    let mut expected = vec![HOME.to_owned(), WORK.to_owned()];
    expected.sort();
    assert_eq!(vaults, expected);
    assert_eq!(master(&b_store), None, "the key waits in memory");
    let parent = b_dir.path().join("linked");
    let choice = |selected: &[&str], primary: &str| VaultChoice {
        session_id: session_id.clone(),
        parent_folder: parent.to_string_lossy().into_owned(),
        selected: selected.iter().map(|id| (*id).to_owned()).collect(),
        primary: primary.to_owned(),
    };

    let refused = b
        .finalize_vault_choice(&session, choice(&[HOME], WORK))
        .await
        .unwrap_err();
    assert!(
        matches!(refused, AccountError::VaultChoice(_)),
        "{refused:?}"
    );
    assert!(!parent.exists(), "nothing provisioned");

    let device_id = b
        .finalize_vault_choice(&session, choice(&[WORK, HOME], WORK))
        .await
        .expect("the kept choice")
        .expect("the device registers");

    let opened = session.current().expect("the primary is open");
    assert_eq!(opened.path, parent.join(dormant_vault_folder_name(WORK)));
    assert_eq!(bound(&session).as_deref(), Some(WORK));
    assert!(
        Path::new(&mine).join(".memry").exists(),
        "its own vault stays"
    );
    assert_eq!(master(&b_store), master(&a_store));
    assert_eq!(b.info().device_id.as_deref(), Some(device_id.as_str()));
}
