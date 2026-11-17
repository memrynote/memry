//! The secrets phase over a real `KeyringStore` and `DeviceIdentityStore` on an in-memory test
//! keychain, and a synthetic `secure-secrets.json` read through `read_all_secrets`. Electron's
//! legacy keytar items live in the same test keychain, as they do on a real machine, so every
//! test can prove they and the safeStorage file are byte-identical afterwards.

use std::collections::BTreeMap;
use std::fs;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use keyring_core::Error;
use memry_core::crypto::{keys, sodium};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use tempfile::TempDir;
use zeroize::Zeroizing;

use super::*;
use crate::electron_import::ElectronProfile;
use crate::electron_import::profile::{HostOs, ProfileEnv, locate_profile};
use crate::electron_import::secrets::keytar::is_keytar_service;
use crate::electron_import::secrets::{
    FixedKeySource, KeySourceError, KeytarSource, read_all_secrets,
};
use crate::seams::secure_store::tests::fake::{Fake, Rig, rig_with};

const MASTER: [u8; 32] = [3; 32];
const OTHER_MASTER: [u8; 32] = [4; 32];
const DSK: SecureStoreKey = SecureStoreKey::DeviceSigningKey;

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn device_key(seed: u8) -> (Vec<u8>, String) {
    let (public, secret) = sodium::sign_seed_keypair(&[seed; 32]).unwrap();
    (secret.to_vec(), b64(&public))
}

fn seal(prefix: &[u8], key: &[u8; 16], plain: &str) -> String {
    use aes::cipher::{BlockModeEncrypt, KeyIvInit, block_padding::Pkcs7};
    let body = cbc::Encryptor::<aes::Aes128>::new(key.into(), (&[0x20_u8; 16]).into())
        .encrypt_padded_vec::<Pkcs7>(plain.as_bytes());
    b64(&[prefix, &body].concat())
}

fn pbkdf2(password: &[u8]) -> [u8; 16] {
    let mut key = [0_u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1, &mut key);
    key
}

/// Linux `v10`: the fixed key, so no key source is asked.
fn v10(plain: &str) -> String {
    seal(b"v10", &pbkdf2(b"peanuts"), plain)
}

/// Linux `v11`: the Secret Service password of the app name.
fn v11(password: &str, plain: &str) -> String {
    seal(b"v11", &pbkdf2(password.as_bytes()), plain)
}

/// Electron's legacy keytar items, read from the test keychain this app also writes to.
struct SharedKeytar(Fake);

impl KeytarSource for SharedKeytar {
    fn list(&self) -> Result<Vec<(String, String)>, KeySourceError> {
        let data = self.0.data.lock().unwrap();
        Ok(data
            .keys()
            .filter(|(service, _)| is_keytar_service(service))
            .cloned()
            .collect())
    }

    fn read(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<String>>, KeySourceError> {
        Ok(self
            .0
            .stored(service, account)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .map(Zeroizing::new))
    }
}

type Items = BTreeMap<(String, String), Vec<u8>>;

struct World {
    rig: Rig,
    profile_dir: TempDir,
    app_dir: TempDir,
    profile: ElectronProfile,
    keys: FixedKeySource,
}

fn world_with(store: &serde_json::Value, keytar: &[(&str, &str, &str)]) -> World {
    let rig = rig_with(None, Duration::from_secs(5), false);
    let profile_dir = tempfile::tempdir().unwrap();
    fs::write(
        profile_dir.path().join("secure-secrets.json"),
        serde_json::to_vec(store).unwrap(),
    )
    .unwrap();
    for (service, account, value) in keytar {
        rig.fake.put(service, account, value.as_bytes());
    }
    let env = ProfileEnv {
        app_data: profile_dir.path().to_owned(),
        override_dir: Some(profile_dir.path().to_owned()),
        host: HostOs::Linux,
    };
    let profile = locate_profile(&env).unwrap().unwrap();
    World {
        rig,
        profile_dir,
        app_dir: tempfile::tempdir().unwrap(),
        profile,
        keys: FixedKeySource::default(),
    }
}

/// A signed-in Electron install: the sync secrets and two provider secrets in its safeStorage
/// file, the master key's legacy keytar copy and a capture token only in keytar.
fn world() -> World {
    let (dsk, _) = device_key(9);
    let store = serde_json::json!({"version": 1, "entries": {
        "com.memry.sync": {
            "master-key": v10(&b64(&MASTER)),
            "device-signing-key": v10(&b64(&dsk)),
            "access-token": v10(&b64(b"jwt-access")),
            "refresh-token": v10(&b64(b"jwt-refresh")),
        },
        "com.memry.readwise": {"readwise-token:/v": v10("rw-token")},
        "memry.voice-transcription": {"openai": v10("sk-voice")},
    }});
    world_with(
        &store,
        &[
            ("com.memry.sync", "master-key", &b64(&MASTER)),
            ("com.memry.capture", "pairing-token", "cap-token"),
        ],
    )
}

fn evidence() -> SecretsEvidence {
    SecretsEvidence {
        account_key_verifier: Some(keys::account_key_verifier(&MASTER).unwrap()),
        vaults: vec![VaultEvidence {
            device_public_key: Some(device_key(9).1),
            ..VaultEvidence::default()
        }],
    }
}

impl World {
    fn identity(&self) -> DeviceIdentityStore {
        DeviceIdentityStore::with_probe(&self.rig.store, self.app_dir.path(), || false)
    }

    fn run(
        &self,
        evidence: &SecretsEvidence,
        mode: SecretsMode,
    ) -> Result<SecretsOutcome, SecretsError> {
        let keytar = SharedKeytar(self.rig.fake.share());
        let report = read_all_secrets(&self.profile, &self.keys, &keytar).unwrap();
        import_secrets(&report, evidence, mode, &self.rig.store, &self.identity())
    }

    fn items(&self, own: bool) -> Items {
        self.rig
            .fake
            .data
            .lock()
            .unwrap()
            .iter()
            .filter(|((service, _), _)| service.starts_with(SERVICE) == own)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Electron's whole secret state: the safeStorage file and every keychain item outside this
    /// app's namespace.
    fn electron(&self) -> (Vec<u8>, Items) {
        let file = fs::read(self.profile_dir.path().join("secure-secrets.json")).unwrap();
        (file, self.items(false))
    }

    fn own(&self, service: &str, account: &str) -> Option<Vec<u8>> {
        self.rig.fake.stored(service, account)
    }
}

fn item(service: &str, account: &str, value: &[u8]) -> ((String, String), Vec<u8>) {
    ((service.to_owned(), account.to_owned()), value.to_vec())
}

#[test]
fn every_secret_lands_in_this_app_s_namespace_and_electron_s_store_is_byte_identical() {
    let w = world();
    let before = w.electron();
    let outcome = w.run(&evidence(), SecretsMode::Full).unwrap();

    assert_eq!(w.electron(), before);
    let (dsk, _) = device_key(9);
    let expected: Items = [
        item(SERVICE, "master-key", b64(&MASTER).as_bytes()),
        item(SERVICE, "access-token", b64(b"jwt-access").as_bytes()),
        item(SERVICE, "refresh-token", b64(b"jwt-refresh").as_bytes()),
        item(SERVICE, "device-signing-key", &dsk),
        item(
            "com.memrynote.memry.readwise",
            "readwise-token:/v",
            b"rw-token",
        ),
        item(
            "com.memrynote.memry.voice-transcription",
            "openai",
            b"sk-voice",
        ),
        item("com.memrynote.memry.capture", "pairing-token", b"cap-token"),
    ]
    .into_iter()
    .collect();
    assert_eq!(w.items(true), expected);
    assert_eq!(outcome.written, 7);
    assert_eq!(outcome.verified, Verified::AccountKeyVerifier);
    assert_eq!(outcome.device_key, DeviceKey::Adopted);
    assert!(!outcome.sign_in_required);
    assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
    assert_eq!(
        w.identity().get(DSK).unwrap(),
        Some(dsk),
        "a restart reads it"
    );
    assert_eq!(
        w.rig.store.get(SecureStoreKey::MasterKey).unwrap(),
        Some(MASTER.to_vec())
    );
}

#[test]
fn a_rerun_after_a_finished_run_writes_nothing() {
    let w = world();
    w.run(&evidence(), SecretsMode::Full).unwrap();
    let own = w.items(true);
    let writes = w.rig.fake.writes.load(std::sync::atomic::Ordering::SeqCst);
    let outcome = w.run(&evidence(), SecretsMode::Full).unwrap();
    assert_eq!((outcome.written, outcome.present), (0, 7));
    assert_eq!(outcome.device_key, DeviceKey::AlreadyHeld);
    assert_eq!(w.items(true), own);
    assert_eq!(
        w.rig.fake.writes.load(std::sync::atomic::Ordering::SeqCst),
        writes
    );
}

#[test]
fn a_master_key_that_misses_the_account_verifier_writes_nothing() {
    let w = world();
    let before = w.electron();
    let mut evidence = evidence();
    evidence.account_key_verifier = Some(keys::account_key_verifier(&OTHER_MASTER).unwrap());
    assert_eq!(
        w.run(&evidence, SecretsMode::Full),
        Err(SecretsError::KeyVerifierMismatch)
    );
    assert!(w.items(true).is_empty());
    assert_eq!(w.electron(), before);
}

#[test]
fn without_an_account_verifier_the_first_vault_verifier_decides() {
    let vault_row = |master: &[u8]| VaultEvidence {
        vault_id: Some("vault-1".to_owned()),
        key_verifier: Some(
            keys::local_vault_key_verifier(&keys::derive_vault_key(master).unwrap(), "vault-1")
                .unwrap(),
        ),
        device_public_key: Some(device_key(9).1),
        inline_ai_reenter: false,
    };
    let unbound = VaultEvidence::default();
    let w = world();
    let wrong = SecretsEvidence {
        account_key_verifier: None,
        vaults: vec![unbound.clone(), vault_row(&OTHER_MASTER)],
    };
    assert_eq!(
        w.run(&wrong, SecretsMode::Full),
        Err(SecretsError::KeyVerifierMismatch)
    );
    assert!(w.items(true).is_empty());
    let right = SecretsEvidence {
        account_key_verifier: None,
        vaults: vec![unbound, vault_row(&MASTER)],
    };
    let outcome = w.run(&right, SecretsMode::Full).unwrap();
    assert_eq!(outcome.verified, Verified::VaultKeyVerifier);
}

#[test]
fn a_device_key_that_is_not_the_registered_one_is_device_key_mismatch_and_writes_nothing() {
    let w = world();
    let before = w.electron();
    let mut evidence = evidence();
    evidence.vaults.push(VaultEvidence {
        device_public_key: Some(device_key(8).1),
        ..VaultEvidence::default()
    });
    assert_eq!(
        w.run(&evidence, SecretsMode::Full),
        Err(SecretsError::DeviceKeyMismatch)
    );
    assert!(w.items(true).is_empty());
    assert_eq!(w.electron(), before);
}

#[test]
fn a_profile_with_its_own_device_key_rolls_back_only_what_this_run_wrote() {
    let w = world();
    let before = w.electron();
    let own_device = device_key(5).0;
    w.rig.fake.put(SERVICE, "device-signing-key", &own_device);
    // Found in place with Electron's value: not this run's write, so the rollback keeps it.
    w.rig.fake.put(
        "com.memrynote.memry.readwise",
        "readwise-token:/v",
        b"rw-token",
    );
    let found = w.items(true);

    assert_eq!(
        w.run(&evidence(), SecretsMode::Full),
        Err(SecretsError::TargetOccupied {
            kind: "device signing key"
        })
    );
    assert_eq!(
        w.items(true),
        found,
        "the sync and generic writes were removed"
    );
    assert_eq!(w.electron(), before);
    assert_eq!(w.identity().get(DSK).unwrap(), Some(own_device));
}

#[test]
fn another_master_key_in_this_app_is_never_overwritten() {
    let w = world();
    w.rig
        .store
        .set(SecureStoreKey::MasterKey, OTHER_MASTER.to_vec())
        .unwrap();
    let found = w.items(true);
    assert_eq!(
        w.run(&evidence(), SecretsMode::Full),
        Err(SecretsError::TargetOccupied { kind: "master key" })
    );
    assert_eq!(w.items(true), found);
}

#[test]
fn a_provider_secret_already_set_in_this_app_is_kept_and_listed() {
    let w = world();
    w.rig.fake.put(
        "com.memrynote.memry.readwise",
        "readwise-token:/v",
        b"newer",
    );
    let outcome = w.run(&evidence(), SecretsMode::Full).unwrap();
    assert_eq!(
        w.own("com.memrynote.memry.readwise", "readwise-token:/v"),
        Some(b"newer".to_vec())
    );
    assert_eq!(
        outcome.skipped,
        [SkippedSecret {
            service: "com.memrynote.memry.readwise".to_owned(),
            account: "readwise-token:/v".to_owned(),
            reason: SkipReason::KeptExisting,
        }]
    );
}

/// A keychain that answers writes but not reads: a slot it cannot read may hold another value,
/// so nothing is written blind.
#[test]
fn a_keychain_that_cannot_be_read_fails_before_any_write() {
    let w = world();
    let before = w.electron();
    let keytar = SharedKeytar(w.rig.fake.share());
    let report = read_all_secrets(&w.profile, &w.keys, &keytar).unwrap();
    *w.rig.fake.fail_reads.lock().unwrap() = Some(|| Error::NoStorageAccess("locked".into()));
    let result = import_secrets(
        &report,
        &evidence(),
        SecretsMode::Full,
        &w.rig.store,
        &w.identity(),
    );
    assert_eq!(
        result,
        Err(SecretsError::Keychain(SecureStoreError::Locked))
    );
    *w.rig.fake.fail_reads.lock().unwrap() = None;
    assert!(w.items(true).is_empty());
    assert_eq!(w.electron(), before);
    assert_eq!(
        w.rig.fake.writes.load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

fn locked_world() -> World {
    let (dsk, _) = device_key(9);
    let store = serde_json::json!({"version": 1, "entries": {
        "com.memry.sync": {
            "master-key": v11("secret-service-pw", &b64(&MASTER)),
            "device-signing-key": v11("secret-service-pw", &b64(&dsk)),
        },
        "com.memry.readwise": {"readwise-token:/v": v10("rw-token")},
    }});
    let mut w = world_with(&store, &[]);
    w.keys.denied = true;
    w
}

#[test]
fn an_unreadable_entry_stops_the_phase_and_retry_succeeds_once_the_key_source_answers() {
    let mut w = locked_world();
    let before = w.electron();
    let Err(SecretsError::Unreadable(unreadable)) = w.run(&evidence(), SecretsMode::Full) else {
        panic!("an unreadable master key stops the phase");
    };
    assert_eq!(unreadable.len(), 2);
    assert!(
        unreadable
            .iter()
            .all(|u| u.service == "com.memry.sync" && u.reason == UnreadableReason::KeySourceDenied)
    );
    assert!(
        w.items(true).is_empty(),
        "nothing is written, the master key is never minted"
    );

    w.keys.denied = false;
    for name in &w.profile.app_names.0 {
        w.keys
            .passwords
            .insert((*name).to_owned(), b"secret-service-pw".to_vec());
    }
    let outcome = w.run(&evidence(), SecretsMode::Full).unwrap();
    assert_eq!(outcome.device_key, DeviceKey::Adopted);
    assert_eq!(
        w.rig.store.get(SecureStoreKey::MasterKey).unwrap(),
        Some(MASTER.to_vec())
    );
    assert_eq!(w.electron(), before);
}

#[test]
fn sign_in_again_skips_the_sync_secrets_and_keeps_the_provider_secrets() {
    let w = locked_world();
    let before = w.electron();
    let outcome = w.run(&evidence(), SecretsMode::SignInAgain).unwrap();
    let expected: Items = [item(
        "com.memrynote.memry.readwise",
        "readwise-token:/v",
        b"rw-token",
    )]
    .into_iter()
    .collect();
    assert_eq!(w.items(true), expected);
    assert!(outcome.sign_in_required);
    assert_eq!(outcome.device_key, DeviceKey::Skipped);
    assert_eq!(outcome.verified, Verified::Skipped);
    assert_eq!(outcome.skipped.len(), 2);
    assert_eq!(
        w.identity().get(DSK).unwrap(),
        None,
        "no identity was adopted"
    );
    assert_eq!(w.electron(), before);

    let w = world();
    w.run(&evidence(), SecretsMode::SignInAgain).unwrap();
    let services: Vec<_> = w
        .items(true)
        .into_keys()
        .map(|(service, _)| service)
        .collect();
    assert!(
        !services.iter().any(|s| s == SERVICE),
        "readable sync secrets are skipped too"
    );
    assert_eq!(services.len(), 3);
}

mod input;
