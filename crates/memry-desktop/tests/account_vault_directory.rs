//! The account vault directory (#3536 A5), ported from `sync/vault-directory.test.ts`: the
//! cached list, self-registration of the vaults this account syncs, icon last writer wins and
//! deleting a vault from the account. Real `memry-config.json`, real vault folders, the scripted
//! server of `account_service`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use memry_core::api::crypto::{decrypt_vault_icon, encrypt_vault_icon, encrypt_vault_name};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::account::vault_directory::{REFRESH_THROTTLE, suggest_vault_folder};
use memry_desktop::account::{AccountError, AccountService, device};
use memry_desktop::registry::VaultRegistry;
use memry_desktop::registry::config::{AppConfig, ConfigError};
use memry_desktop::registry::vault_icon::{self, StoredVaultIcon};
use memry_desktop::session::{OpenSource, Session};
use serde_json::{Value, json};

use crate::account_service::{Keychain, MASTER, Script, access_token};

pub(crate) struct Fixture {
    pub(crate) dir: tempfile::TempDir,
    pub(crate) script: Arc<Script>,
    pub(crate) config: Arc<AppConfig>,
    pub(crate) registry: VaultRegistry,
    pub(crate) account: AccountService,
}

/// Signed in as user `u` with the master key.
pub(crate) fn fixture() -> Fixture {
    fixture_with(true)
}

fn fixture_with(signed_in: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let config = Arc::new(AppConfig::load(dir.path().join("memry-config.json")));
    let keychain = Arc::new(Keychain::holding_keys(Some(MASTER)));
    if signed_in {
        keychain
            .set(
                SecureStoreKey::AccessToken,
                access_token("server-device").into_bytes(),
            )
            .unwrap();
        keychain
            .set(SecureStoreKey::RefreshToken, b"refresh".to_vec())
            .unwrap();
    }
    let script = Arc::new(Script::default());
    let account = AccountService::new(
        script.clone(),
        keychain,
        "https://sync.test".into(),
        device::descriptor("1.0.0"),
        config.clone(),
    )
    .unwrap();
    Fixture {
        registry: VaultRegistry::new(config.clone()),
        dir,
        script,
        config,
        account,
    }
}

impl Fixture {
    /// A registry entry with a real folder; `binding` is `(userId, mode)`.
    pub(crate) fn local(
        &self,
        name: &str,
        uuid: Option<&str>,
        binding: Option<(&str, &str)>,
    ) -> PathBuf {
        let path = self.dir.path().join(name.to_lowercase());
        std::fs::create_dir_all(path.join(".memry")).unwrap();
        let mut entry = json!({
            "path": path.to_string_lossy(), "name": name, "noteCount": 0, "taskCount": 0,
            "lastOpened": "", "isDefault": false,
        });
        if let Some(uuid) = uuid {
            entry["vaultUuid"] = json!(uuid);
        }
        if let Some((user, mode)) = binding {
            entry["accountBinding"] = json!({ "userId": user, "mode": mode });
        }
        self.config
            .update(|c| {
                let list = c.entry("vaults").or_insert_with(|| json!([]));
                list.as_array_mut().unwrap().push(entry);
                Ok::<_, ConfigError>(())
            })
            .unwrap();
        path
    }

    fn cache(&self) -> Value {
        self.config.read(|c| {
            c.get("sync")
                .and_then(|s| s.get("accountVaultsCache"))
                .cloned()
                .unwrap_or(Value::Null)
        })
    }

    fn posts(&self) -> Vec<Value> {
        self.requests("POST", "/sync/vaults")
    }

    fn requests(&self, method: &str, path: &str) -> Vec<Value> {
        self.script
            .requests()
            .into_iter()
            .filter(|(m, p, _)| m == method && p == path)
            .map(|(_, _, body)| body)
            .collect()
    }

    async fn refresh(&self) -> bool {
        self.account
            .refresh_vault_directory(&self.registry, true)
            .await
    }
}

fn server_vault(uuid: &str, name: Option<&str>, item_count: i64) -> Value {
    let mut row = json!({ "vaultUuid": uuid, "itemCount": item_count, "createdAt": 1000 });
    if let Some(name) = name {
        let sealed = encrypt_vault_name(&MASTER, uuid, name).unwrap();
        row["encryptedName"] = json!(sealed.ciphertext);
        row["nameNonce"] = json!(sealed.nonce);
    }
    row
}

fn with_icon(mut row: Value, icon: Option<&str>, at: i64) -> Value {
    let uuid = row["vaultUuid"].as_str().unwrap().to_owned();
    let sealed = icon.map(|i| encrypt_vault_icon(&MASTER, &uuid, i).unwrap());
    row["encryptedIcon"] = json!(sealed.as_ref().map(|s| &s.ciphertext));
    row["iconNonce"] = json!(sealed.as_ref().map(|s| &s.nonce));
    row["iconUpdatedAt"] = json!(at);
    row
}

fn icon(value: Option<&str>, updated_at: i64, pending_sync: bool) -> StoredVaultIcon {
    StoredVaultIcon {
        value: value.map(str::to_owned),
        updated_at,
        pending_sync,
    }
}

fn write_icon(vault: &Path, icon: &StoredVaultIcon) {
    std::fs::write(
        vault.join(".memry/config.json"),
        json!({ "vaultIcon": { "value": icon.value, "updatedAt": icon.updated_at, "pendingSync": icon.pending_sync } })
            .to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn fetches_the_list_decrypts_names_and_caches_it() {
    let f = fixture();
    f.script.answer(
        200,
        json!({ "vaults": [
            server_vault("uuid-a", Some("Alpha"), 12),
            { "vaultUuid": "uuid-x", "itemCount": 1, "createdAt": 1000, "encryptedName": "garbage", "nameNonce": "garbage" },
        ]}),
    );

    f.refresh().await;

    let cache = f.cache();
    assert!(cache["fetchedAt"].as_i64().unwrap() > 0);
    assert_eq!(
        cache["vaults"],
        json!([
            { "vaultUuid": "uuid-a", "name": "Alpha", "itemCount": 12, "createdAt": 1000 },
            { "vaultUuid": "uuid-x", "name": null, "itemCount": 1, "createdAt": 1000 },
        ])
    );
}

#[tokio::test]
async fn registers_bound_vaults_the_server_lacks_or_names_differently() {
    let f = fixture();
    f.local("Alpha", Some("uuid-a"), Some(("u", "sync")));
    f.local("New Name", Some("uuid-b"), Some(("u", "sync")));
    f.local("Same", Some("uuid-c"), Some(("u", "sync")));
    f.local("NoUuid", None, Some(("u", "sync")));
    f.script.answer(
        200,
        json!({ "vaults": [server_vault("uuid-b", Some("Old Name"), 3), server_vault("uuid-c", Some("Same"), 3)] }),
    );
    f.script.answer(200, json!({ "success": true }));
    f.script.answer(200, json!({ "success": true }));

    f.refresh().await;

    let posted: Vec<_> = f
        .posts()
        .iter()
        .map(|b| b["vaultUuid"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(posted, ["uuid-a", "uuid-b"]);
    let body = &f.posts()[0];
    assert!(body["encryptedName"].is_string() && body["nameNonce"].is_string());
}

#[tokio::test]
async fn never_registers_a_vault_this_account_does_not_sync() {
    let f = fixture();
    f.local("Theirs", Some("uuid-theirs"), Some(("user-2", "sync")));
    f.local("Local", Some("uuid-local"), Some(("u", "local")));
    f.local("Legacy", Some("uuid-legacy"), None);
    f.script.answer(200, json!({ "vaults": [] }));

    f.refresh().await;

    assert!(f.posts().is_empty());
}

/// A 402 (no plan, vault limit) skips that vault; the next one still registers.
#[tokio::test]
async fn a_payment_required_registration_is_tolerated() {
    let f = fixture();
    f.local("Alpha", Some("uuid-a"), Some(("u", "sync")));
    f.local("Beta", Some("uuid-b"), Some(("u", "sync")));
    f.script.answer(200, json!({ "vaults": [] }));
    f.script
        .answer(402, json!({ "error": "Active sync subscription required" }));
    f.script.answer(200, json!({ "success": true }));

    f.refresh().await;

    assert_eq!(f.posts().len(), 2);
    assert_eq!(f.cache()["vaults"], json!([]));
}

#[tokio::test(start_paused = true)]
async fn non_forced_refreshes_are_throttled() {
    let f = fixture();
    f.script.answer(200, json!({ "vaults": [] }));
    f.refresh().await;
    assert!(!f.account.refresh_vault_directory(&f.registry, false).await);
    assert_eq!(f.requests("GET", "/sync/vaults").len(), 1);

    f.script.answer(200, json!({ "vaults": [] }));
    f.refresh().await;
    assert_eq!(f.requests("GET", "/sync/vaults").len(), 2, "force skips it");

    tokio::time::advance(REFRESH_THROTTLE + Duration::from_secs(1)).await;
    f.script.answer(200, json!({ "vaults": [] }));
    f.account.refresh_vault_directory(&f.registry, false).await;
    assert_eq!(f.requests("GET", "/sync/vaults").len(), 3);
}

#[tokio::test]
async fn signed_out_is_a_silent_no_op() {
    let f = fixture_with(false);
    f.refresh().await;
    assert!(f.script.requests().is_empty());
    assert_eq!(f.cache(), Value::Null);
}

#[tokio::test]
async fn a_failed_read_keeps_the_last_cache() {
    let f = fixture();
    f.script.answer(
        200,
        json!({ "vaults": [server_vault("uuid-a", Some("Alpha"), 1)] }),
    );
    f.refresh().await;
    f.script.answer(400, json!({ "error": "refused" }));
    f.refresh().await;
    assert_eq!(f.cache()["vaults"][0]["name"], "Alpha");
}

// --- icons ---------------------------------------------------------------------------------

fn synced(f: &Fixture) -> PathBuf {
    f.local("Alpha", Some("uuid-a"), Some(("u", "sync")))
}

#[tokio::test]
async fn pushes_a_pending_local_icon_the_account_lacks() {
    let f = fixture();
    let vault = synced(&f);
    write_icon(&vault, &icon(Some("icon:Book01Icon"), 500, true));
    f.script.answer(
        200,
        json!({ "vaults": [server_vault("uuid-a", Some("Alpha"), 0)] }),
    );
    f.script.answer(200, json!({ "applied": true }));

    assert!(!f.refresh().await);

    let put = &f.requests("PUT", "/sync/vaults/uuid-a/icon")[0];
    assert_eq!(put["iconUpdatedAt"], 500);
    assert_eq!(
        decrypt_vault_icon(
            &MASTER,
            "uuid-a",
            put["encryptedIcon"].as_str().unwrap(),
            put["iconNonce"].as_str().unwrap()
        )
        .as_deref(),
        Some("icon:Book01Icon")
    );
    assert_eq!(
        vault_icon::read(&vault),
        Some(icon(Some("icon:Book01Icon"), 500, false))
    );
}

#[tokio::test]
async fn pushes_a_reset_as_an_empty_envelope() {
    let f = fixture();
    let vault = synced(&f);
    write_icon(&vault, &icon(None, 200, true));
    f.script.answer(
        200,
        json!({ "vaults": [with_icon(server_vault("uuid-a", Some("Alpha"), 0), Some("🌿"), 100)] }),
    );
    f.script.answer(200, json!({ "applied": true }));

    f.refresh().await;

    assert_eq!(
        f.requests("PUT", "/sync/vaults/uuid-a/icon"),
        [json!({ "encryptedIcon": null, "iconNonce": null, "iconUpdatedAt": 200 })]
    );
}

#[tokio::test]
async fn a_failed_push_keeps_the_change_pending() {
    let f = fixture();
    let vault = synced(&f);
    write_icon(&vault, &icon(Some("🌿"), 500, true));
    f.script.answer(
        200,
        json!({ "vaults": [server_vault("uuid-a", Some("Alpha"), 0)] }),
    );
    f.script.answer(404, json!({ "error": "not found" }));

    f.refresh().await;

    assert_eq!(vault_icon::read(&vault), Some(icon(Some("🌿"), 500, true)));
}

#[tokio::test]
async fn adopts_a_newer_account_icon_and_reports_it() {
    let f = fixture();
    let vault = synced(&f);
    write_icon(&vault, &icon(Some("🌿"), 500, true));
    f.script.answer(
        200,
        json!({ "vaults": [with_icon(server_vault("uuid-a", Some("Alpha"), 0), Some("icon:Leaf01Icon"), 900)] }),
    );

    assert!(f.refresh().await, "the windows hear of it");

    assert!(f.requests("PUT", "/sync/vaults/uuid-a/icon").is_empty());
    assert_eq!(
        vault_icon::read(&vault),
        Some(icon(Some("icon:Leaf01Icon"), 900, false))
    );
}

#[tokio::test]
async fn adopts_an_account_reset_over_an_older_local_icon() {
    let f = fixture();
    let vault = synced(&f);
    write_icon(&vault, &icon(Some("🌿"), 500, false));
    f.script.answer(
        200,
        json!({ "vaults": [with_icon(server_vault("uuid-a", Some("Alpha"), 0), None, 900)] }),
    );

    assert!(f.refresh().await);
    assert_eq!(vault_icon::read(&vault), Some(icon(None, 900, false)));
}

#[tokio::test]
async fn keeps_the_local_icon_when_the_account_copy_is_unusable() {
    let f = fixture();
    let vault = synced(&f);
    write_icon(&vault, &icon(Some("🌿"), 500, false));
    let mut garbage = server_vault("uuid-a", Some("Alpha"), 0);
    garbage["encryptedIcon"] = json!("garbage");
    garbage["iconNonce"] = json!("garbage");
    garbage["iconUpdatedAt"] = json!(900);
    // Opens, but is not an icon this build can draw (`VaultIconSchema`).
    let undrawable = with_icon(
        server_vault("uuid-a", Some("Alpha"), 0),
        Some("custom:x"),
        900,
    );
    for row in [garbage, undrawable] {
        f.script.answer(200, json!({ "vaults": [row] }));
        assert!(!f.refresh().await);
        assert_eq!(vault_icon::read(&vault), Some(icon(Some("🌿"), 500, false)));
    }
}

#[tokio::test]
async fn a_server_without_icons_and_an_unbound_vault_touch_nothing() {
    let f = fixture();
    let vault = synced(&f);
    let local = f.local("Kept", Some("uuid-k"), Some(("u", "local")));
    write_icon(&vault, &icon(Some("🌿"), 500, false));
    write_icon(&local, &icon(None, 500, true));
    f.script.answer(
        200,
        json!({ "vaults": [
            server_vault("uuid-a", Some("Alpha"), 0),
            with_icon(server_vault("uuid-k", Some("Kept"), 0), Some("🌿"), 900),
        ]}),
    );

    assert!(!f.refresh().await);
    assert!(f.script.requests().iter().all(|(m, _, _)| m == "GET"));
    assert_eq!(vault_icon::read(&local), Some(icon(None, 500, true)));
}

#[tokio::test]
async fn the_same_change_time_on_both_sides_clears_the_pending_flag() {
    let f = fixture();
    let vault = synced(&f);
    write_icon(&vault, &icon(Some("🌿"), 900, true));
    f.script.answer(
        200,
        json!({ "vaults": [with_icon(server_vault("uuid-a", Some("Alpha"), 0), Some("🌿"), 900)] }),
    );

    assert!(!f.refresh().await);
    assert_eq!(vault_icon::read(&vault), Some(icon(Some("🌿"), 900, false)));
}

// --- list ----------------------------------------------------------------------------------

#[tokio::test]
async fn the_list_joins_the_cache_with_local_copies_and_works_offline() {
    let f = fixture();
    let alpha = f.local("Alpha", Some("uuid-a"), None);
    f.script.answer(
        200,
        json!({ "vaults": [server_vault("uuid-a", Some("Alpha"), 12), server_vault("uuid-b", Some("My Notes"), 4)] }),
    );
    f.refresh().await;
    let parent = f.dir.path().join("parent");

    // No answer is scripted: the list reads only the cache.
    let listed = f.account.list_account_vaults(&f.registry, &parent);

    assert_eq!(listed.len(), 2);
    assert_eq!(
        listed[0].local_path.as_deref(),
        Some(alpha.to_str().unwrap())
    );
    assert_eq!(
        (listed[0].item_count, listed[0].created_at),
        (12, Some(1000))
    );
    assert_eq!(listed[1].local_path, None);
    assert_eq!(listed[1].name.as_deref(), Some("My Notes"));
    assert_eq!(
        listed[1].suggested_path,
        parent.join("my-notes").to_string_lossy()
    );
}

#[tokio::test]
async fn the_list_is_empty_without_a_cache() {
    let f = fixture();
    assert!(
        f.account
            .list_account_vaults(&f.registry, f.dir.path())
            .is_empty()
    );
}

#[test]
fn suggested_folders_slugify_fall_back_and_avoid_collisions() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    assert_eq!(
        suggest_vault_folder("uuid-1234567890", Some("My Vault!"), p),
        p.join("my-vault")
    );
    assert_eq!(
        suggest_vault_folder("abcdefgh-rest", None, p),
        p.join("memry-vault-abcdefgh")
    );
    assert_eq!(
        suggest_vault_folder("abcdefgh-rest", Some("!!!"), p),
        p.join("memry-vault-abcdefgh")
    );
    assert_eq!(
        suggest_vault_folder("u", Some("  a - B_c  "), p),
        p.join("a---b_c")
    );
    std::fs::create_dir_all(p.join("work")).unwrap();
    std::fs::create_dir_all(p.join("work-2")).unwrap();
    assert_eq!(suggest_vault_folder("u", Some("Work"), p), p.join("work-3"));
}

// --- delete --------------------------------------------------------------------------------

pub(crate) fn with_session(f: &Fixture) -> Session {
    Session::new(VaultRegistry::new(f.config.clone()))
}

#[tokio::test]
async fn delete_removes_the_account_vault_and_the_entry_and_keeps_files() {
    let f = fixture();
    let other = f.local("Other", Some("uuid-o"), Some(("u", "sync")));
    std::fs::write(other.join("keep-me.md"), "# keep me\n").unwrap();
    let session = with_session(&f);
    f.script.answer(200, json!({ "success": true }));

    f.account
        .delete_account_vault(&session, "uuid-o")
        .await
        .unwrap();

    assert_eq!(f.requests("DELETE", "/sync/vaults/uuid-o").len(), 1);
    assert!(f.registry.stored().is_empty(), "it cannot register again");
    assert_eq!(
        std::fs::read_to_string(other.join("keep-me.md")).unwrap(),
        "# keep me\n"
    );
}

#[tokio::test]
async fn delete_of_a_cloud_only_vault_succeeds() {
    let f = fixture();
    let session = with_session(&f);
    f.script.answer(200, json!({ "success": true }));
    f.account
        .delete_account_vault(&session, "uuid-cloud")
        .await
        .unwrap();
    assert_eq!(f.requests("DELETE", "/sync/vaults/uuid-cloud").len(), 1);
}

#[tokio::test]
async fn delete_refuses_the_open_vault() {
    let f = fixture();
    let path = f.dir.path().join("open");
    std::fs::create_dir_all(&path).unwrap();
    let session = with_session(&f);
    session.open(&path, OpenSource::Select).unwrap();
    let uuid = f.registry.stored()[0]
        .vault_uuid
        .clone()
        .expect("stamped at open");

    let error = f
        .account
        .delete_account_vault(&session, &uuid)
        .await
        .unwrap_err();

    assert!(matches!(error, AccountError::DeleteOpenVault), "{error}");
    assert!(f.script.requests().is_empty());
    assert_eq!(f.registry.stored().len(), 1);
}

#[tokio::test]
async fn delete_signed_out_is_refused() {
    let f = fixture_with(false);
    f.local("Other", Some("uuid-o"), None);
    let error = f
        .account
        .delete_account_vault(&with_session(&f), "uuid-o")
        .await
        .unwrap_err();
    assert!(matches!(error, AccountError::DeleteSignedOut), "{error}");
    assert_eq!(f.registry.stored().len(), 1);
}

#[tokio::test]
async fn a_failed_delete_keeps_the_local_entry() {
    let f = fixture();
    f.local("Other", Some("uuid-o"), Some(("u", "sync")));
    f.script.answer(400, json!({ "error": "refused" }));
    assert!(
        f.account
            .delete_account_vault(&with_session(&f), "uuid-o")
            .await
            .is_err()
    );
    assert_eq!(f.registry.stored().len(), 1);
}
