//! Unit tests of the linking service's in-memory state.

use super::*;

/// The link's store holds the master key and nothing else, and never reads one back: the
/// link cannot leave a device key or token in memory, nor read the keychain through it.
#[test]
fn the_held_key_takes_only_the_master_key() {
    let held = HeldKey::default();
    for key in [
        SecureStoreKey::DeviceSigningKey,
        SecureStoreKey::AccessToken,
        SecureStoreKey::RefreshToken,
        SecureStoreKey::SetupToken,
    ] {
        assert!(held.set(key, vec![1; 32]).is_err(), "{key:?}");
    }
    assert_eq!(held.take(), None);

    held.set(SecureStoreKey::MasterKey, vec![2; 32]).unwrap();
    assert_eq!(held.get(SecureStoreKey::MasterKey).unwrap(), None);
    assert_eq!(
        held.take().as_deref().map(Vec::as_slice),
        Some(&[2; 32][..])
    );
    assert_eq!(held.take(), None, "taken once");
}

/// A choice the user never makes is forgotten, key and all, once its session expires; a
/// choice of a later session is not.
#[tokio::test(start_paused = true)]
async fn an_unpicked_choice_is_forgotten_when_it_expires() {
    let slot = Arc::<Mutex<Option<PendingChoice>>>::default();
    let choice = |id: &str, ttl: i64| PendingChoice {
        session_id: id.into(),
        master: Zeroizing::new(vec![1; 32]),
        vaults: vec![],
        expires_at: now_s() + ttl,
    };
    hold_choice(&slot, choice("first", 60));
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert!(lock(&slot).is_some(), "still pending");
    tokio::time::sleep(Duration::from_secs(40)).await;
    assert!(lock(&slot).is_none(), "expired");

    hold_choice(&slot, choice("old", 10));
    hold_choice(&slot, choice("new", 600));
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert_eq!(
        lock(&slot).as_ref().map(|p| p.session_id.as_str()),
        Some("new")
    );
}

/// VERIFY-4711 Low 2: a choice that ran out while its provisioning failed is dropped, key and
/// all; one still live is put back.
#[tokio::test(start_paused = true)]
async fn a_failed_choice_comes_back_only_while_its_session_lives() {
    let slot = Arc::<Mutex<Option<PendingChoice>>>::default();
    let choice = |expires_at: i64| PendingChoice {
        session_id: "s".into(),
        master: Zeroizing::new(vec![1; 32]),
        vaults: vec![],
        expires_at,
    };
    restore_choice(&slot, choice(now_s() - 1));
    assert!(lock(&slot).is_none(), "an expired choice is dropped");
    restore_choice(&slot, choice(now_s() + 60));
    assert!(lock(&slot).is_some(), "a live one is back");
    tokio::time::sleep(Duration::from_secs(62)).await;
    assert!(lock(&slot).is_none(), "and still forgotten when it expires");
}

/// VERIFY-4711 Low 1: a new sign-in ends the previous account's link and vault choice.
#[tokio::test]
async fn a_new_sign_in_forgets_the_pending_choice() {
    let session = memry_core::api::auth::AuthSession::new(
        Arc::new(crate::seams::transport::Unavailable("offline".into())),
        Arc::new(HeldKey::default()),
        "https://sync.invalid".into(),
        "desktop".into(),
        super::super::device::descriptor("1.0.0"),
        None,
    )
    .unwrap();
    let linking = Linking::new(session.device_approver());
    hold_choice(
        &linking.choice,
        PendingChoice {
            session_id: "s".into(),
            master: Zeroizing::new(vec![1; 32]),
            vaults: vec!["v".into()],
            expires_at: now_s() + 600,
        },
    );
    linking.forget_pending().await;
    assert!(lock(&linking.choice).is_none());
    assert!(linking.new_device.lock().await.is_none());
}

#[test]
fn a_vault_folder_stays_in_the_picked_folder() {
    let parent = Path::new("/picked");
    assert_eq!(
        vault_folder(parent, "0b9f3c8e-5d4a-4c1e").unwrap(),
        parent.join("memry-vault-0b9f3c8e")
    );
    for id in ["", "../../..", "..", "a/b", "a\\b", "x.y", " id"] {
        assert!(vault_folder(parent, id).is_err(), "{id:?}");
    }
}
