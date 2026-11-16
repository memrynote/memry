//! The account vault directory against the real Worker (`sync/vault-directory.ts`): a vault
//! that becomes `Bound` is registered with the account and listed under its decrypted name, an
//! account without a plan registers nothing until it gets one (402, retried on the next
//! refresh), and a vault deleted from the account leaves the server and the registry.

use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::account::binding::BindingState;
use memry_desktop::account::{AccountError, AccountService};
use memry_desktop::session::Session;

use super::account::{CODE, EMAIL, install};
use super::binding::{attach, detach, new_account, open_session, wait_for_binding, wiring};
use super::{Server, device_key};

/// The account's vault ids as the server lists them (`GET /sync/vaults`).
async fn server_vaults(account: &AccountService) -> Vec<String> {
    let rows = account.session().vault_directory().await.expect("the list");
    rows.into_iter().map(|row| row.summary.id).collect()
}

/// Binds the open vault for `account` and returns its server vault id.
async fn bind(
    account: &Arc<AccountService>,
    store: &Arc<dyn SecureStore>,
    session: &Session,
) -> String {
    let (wiring, _) = wiring(account, store, session);
    attach(session, &wiring).await;
    wait_for_binding(&wiring, &BindingState::Bound).await;
    detach(session).await;
    let open = session.current().expect("open");
    open.vault.server_vault_id().unwrap().expect("bound")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bound_vault_is_registered_listed_by_name_and_deleted_from_the_account() {
    let mut server = Server::start();
    let store = device_key::with_device_key();
    let (_dir, account, _) = new_account(&mut server, store.clone(), EMAIL).await;
    let vault_dir = tempfile::tempdir().unwrap();
    let session = open_session(&vault_dir);
    let uuid = bind(&account, &store, &session).await;
    let open_path = session.current().unwrap().path;

    account
        .refresh_vault_directory(session.registry(), true)
        .await;
    assert_eq!(server_vaults(&account).await, vec![uuid.clone()]);
    let parent = tempfile::tempdir().unwrap();
    let listed = account.list_account_vaults(session.registry(), parent.path());
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0].vault_uuid, uuid);
    assert_eq!(listed[0].name.as_deref(), Some("Mine"), "decrypted");
    assert_eq!(
        listed[0].local_path.as_deref(),
        Some(open_path.to_string_lossy().as_ref())
    );

    assert!(matches!(
        account.delete_account_vault(&session, &uuid).await,
        Err(AccountError::DeleteOpenVault)
    ));
    assert_eq!(server_vaults(&account).await, vec![uuid.clone()], "kept");

    session.close();
    account
        .delete_account_vault(&session, &uuid)
        .await
        .expect("deleted");
    assert!(server_vaults(&account).await.is_empty());
    assert!(
        session.registry().stored().is_empty(),
        "the local entry is forgotten, so no refresh registers it again"
    );
    assert!(open_path.is_dir(), "files kept");
    account
        .refresh_vault_directory(session.registry(), true)
        .await;
    assert!(server_vaults(&account).await.is_empty());
    assert!(
        account
            .list_account_vaults(session.registry(), parent.path())
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_account_without_a_plan_registers_nothing_until_it_gets_one() {
    let mut server = Server::start();
    let store = device_key::with_device_key();
    let (_dir, account) = install(&server, store.clone());
    account.request_otp(EMAIL.into()).await.expect("a code");
    server.otp(EMAIL, CODE);
    assert!(account.verify_otp(CODE.into()).await.unwrap().needs_setup);
    account.setup_new_account().await.expect("setup");
    account.confirm_recovery_phrase(true).unwrap();
    let account = Arc::new(account);
    let vault_dir = tempfile::tempdir().unwrap();
    let session = open_session(&vault_dir);
    let uuid = bind(&account, &store, &session).await;

    // The 402 is logged and the pass goes on (`vault-directory.ts` self-registration).
    account
        .refresh_vault_directory(session.registry(), true)
        .await;
    assert!(server_vaults(&account).await.is_empty());
    let parent = tempfile::tempdir().unwrap();
    assert!(
        account
            .list_account_vaults(session.registry(), parent.path())
            .is_empty()
    );

    server.entitle(EMAIL);
    account
        .refresh_vault_directory(session.registry(), true)
        .await;
    assert_eq!(server_vaults(&account).await, vec![uuid]);
}
