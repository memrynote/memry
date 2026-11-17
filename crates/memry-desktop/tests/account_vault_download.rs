//! Downloading an account vault (#3536 A5b), ported from `downloadRemoteVault`
//! (`sync/vault-directory.ts:266-318`): the registered copy opens instead of a second download,
//! else a folder named after the vault is made, bound to the account's vault id and registered
//! without closing the open vault. Real `memry-config.json`, real vault folders, a real session.

use memry_desktop::account::AccountError;
use memry_desktop::account::vault_directory::DownloadTarget;
use memry_desktop::registry::config::ConfigError;
use memry_desktop::session::OpenSource;
use serde_json::json;

use crate::account_vault_directory::{fixture, with_session};

fn cache(f: &crate::account_vault_directory::Fixture, vaults: serde_json::Value) {
    f.config
        .update(|c| {
            c.insert(
                "sync".into(),
                json!({ "accountVaultsCache": { "fetchedAt": 1, "vaults": vaults } }),
            );
            Ok::<_, ConfigError>(())
        })
        .unwrap();
}

#[test]
fn a_download_makes_a_named_vault_bound_to_the_account_and_keeps_the_open_vault() {
    let f = fixture();
    cache(
        &f,
        json!([{ "vaultUuid": "uuid-work", "name": "Work Notes", "itemCount": 3 }]),
    );
    let open = f.dir.path().join("open");
    std::fs::create_dir_all(&open).unwrap();
    let session = with_session(&f);
    session.open(&open, OpenSource::Select).unwrap();
    let parent = f.dir.path().join("Memry");

    let target = f
        .account
        .prepare_vault_download(&session, "uuid-work", &parent)
        .unwrap();

    let folder = parent.join("work-notes");
    assert_eq!(target, DownloadTarget::Provisioned(folder.clone()));
    assert_eq!(
        session.current().unwrap().path,
        open,
        "the open vault stays"
    );
    let row = f
        .registry
        .get(&folder.to_string_lossy())
        .expect("registered");
    assert_eq!(row.vault_uuid.as_deref(), Some("uuid-work"));

    session.switch(&folder).unwrap();
    let opened = session.current().unwrap();
    assert_eq!(opened.path, folder);
    assert_eq!(
        opened.vault.server_vault_id().unwrap().as_deref(),
        Some("uuid-work")
    );
    let row = f.registry.get(&folder.to_string_lossy()).unwrap();
    assert_eq!(row.vault_uuid.as_deref(), Some("uuid-work"), "kept at open");
}

#[test]
fn a_registered_copy_opens_instead_of_a_second_download() {
    let f = fixture();
    cache(&f, json!([{ "vaultUuid": "uuid-work", "name": "Work" }]));
    let local = f.local("Elsewhere", Some("uuid-work"), Some(("u", "sync")));
    let session = with_session(&f);
    let parent = f.dir.path().join("Memry");

    let target = f
        .account
        .prepare_vault_download(&session, "uuid-work", &parent)
        .unwrap();

    assert_eq!(target, DownloadTarget::Existing(local));
    assert!(!parent.exists(), "no second folder");
    assert_eq!(f.registry.stored().len(), 1);
}

#[test]
fn without_a_cached_name_the_folder_is_named_after_the_id() {
    let f = fixture();
    let session = with_session(&f);
    let parent = f.dir.path().join("Memry");

    let target = f
        .account
        .prepare_vault_download(&session, "abcdefgh-1234", &parent)
        .unwrap();

    assert_eq!(
        target,
        DownloadTarget::Provisioned(parent.join("memry-vault-abcdefgh"))
    );
}

/// The id names the folder when the vault has no name: one that is not an id would leave the
/// folder the user picked.
#[test]
fn an_id_that_is_not_one_is_refused_and_makes_nothing() {
    let f = fixture();
    let session = with_session(&f);
    let parent = f.dir.path().join("pick").join("Memry");

    for id in ["../../evil", "", "a/b", "uuid work"] {
        let error = f
            .account
            .prepare_vault_download(&session, id, &parent)
            .unwrap_err();
        assert!(
            matches!(error, AccountError::InvalidVaultId),
            "{id}: {error}"
        );
    }
    assert!(!f.dir.path().join("pick").exists());
    assert!(!f.dir.path().join("evil").exists());
    assert!(f.registry.stored().is_empty());
}

#[test]
fn a_folder_that_cannot_be_made_fails_and_registers_nothing() {
    let f = fixture();
    let session = with_session(&f);
    let parent = f.dir.path().join("a-file");
    std::fs::write(&parent, "not a folder").unwrap();

    let error = f
        .account
        .prepare_vault_download(&session, "uuid-work", &parent)
        .unwrap_err();

    assert!(matches!(error, AccountError::VaultDownload(_)), "{error}");
    assert!(f.registry.stored().is_empty());
    assert_eq!(std::fs::read_to_string(&parent).unwrap(), "not a folder");
}
