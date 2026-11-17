//! The phase against Electron data that is not in the shape it expects: unlisted keytar items,
//! values not in Electron's format, accounts of another device, unknown services, collisions.

use super::*;

#[test]
fn sync_accounts_of_another_device_and_unknown_services_are_skipped() {
    let store = serde_json::json!({"version": 1, "entries": {
        "com.memry.sync": {"master-key-A": v10(&b64(&MASTER))},
        "org.other": {"x": v10("y")},
    }});
    let w = world_with(&store, &[]);
    let outcome = w
        .run(&SecretsEvidence::default(), SecretsMode::Full)
        .unwrap();
    assert!(w.items(true).is_empty());
    assert_eq!(outcome.verified, Verified::NoMasterKey);
    assert_eq!(outcome.device_key, DeviceKey::NotInElectron);
    let reasons: Vec<_> = outcome.skipped.iter().map(|s| s.reason).collect();
    assert_eq!(
        reasons,
        [SkipReason::OtherDevice, SkipReason::UnknownService]
    );
}

#[test]
fn a_device_key_that_is_not_an_ed25519_secret_key_is_malformed() {
    let mut bad = device_key(9).0;
    bad[40] ^= 1;
    let store = serde_json::json!({"version": 1, "entries": {
        "com.memry.sync": {"device-signing-key": v10(&b64(&bad))},
    }});
    let w = world_with(&store, &[]);
    assert_eq!(
        w.run(&SecretsEvidence::default(), SecretsMode::Full),
        Err(SecretsError::Malformed {
            kind: "device signing key"
        })
    );
    assert!(w.items(true).is_empty());
}

/// A keytar that cannot list its items, as a Secret Service that will not answer.
struct UnlistedKeytar;

impl KeytarSource for UnlistedKeytar {
    fn list(&self) -> Result<Vec<(String, String)>, KeySourceError> {
        Err(KeySourceError::Failed("no answer".to_owned()))
    }

    fn read(&self, _: &str, _: &str) -> Result<Option<Zeroizing<String>>, KeySourceError> {
        Ok(None)
    }
}

#[test]
fn unlisted_keytar_items_stop_the_phase_and_sign_in_again_reports_them() {
    let w = world();
    let before = w.electron();
    let report = read_all_secrets(&w.profile, &w.keys, &UnlistedKeytar).unwrap();
    let run = |mode| import_secrets(&report, &evidence(), mode, &w.rig.store, &w.identity());
    assert!(matches!(
        run(SecretsMode::Full),
        Err(SecretsError::KeytarUnlisted(_))
    ));
    assert!(w.items(true).is_empty());
    let outcome = run(SecretsMode::SignInAgain).unwrap();
    assert!(outcome.keytar_unlisted);
    assert_eq!(w.electron(), before);
}

#[test]
fn a_sync_secret_not_in_electron_s_format_is_malformed_and_writes_nothing() {
    let cases = [
        ("access-token", v10("not base64!"), "access token"),
        (
            "device-signing-key",
            v10(&b64(&[7; 16])),
            "device signing key",
        ),
    ];
    for (account, value, kind) in cases {
        let store = serde_json::json!({"version": 1, "entries": {
            "com.memry.sync": {"refresh-token": v10(&b64(b"jwt-refresh")), account: value},
        }});
        let w = world_with(&store, &[]);
        assert_eq!(
            w.run(&SecretsEvidence::default(), SecretsMode::Full),
            Err(SecretsError::Malformed { kind })
        );
        assert!(w.items(true).is_empty(), "{account}");
    }
}

#[test]
fn two_electron_services_with_one_target_keep_the_first_and_list_the_other() {
    let store = serde_json::json!({"version": 1, "entries": {
        "com.memry.calendar": {"token": v10("first")},
        "memry.calendar": {"token": v10("second")},
    }});
    let w = world_with(&store, &[]);
    let outcome = w
        .run(&SecretsEvidence::default(), SecretsMode::Full)
        .unwrap();
    assert_eq!(
        w.own("com.memrynote.memry.calendar", "token"),
        Some(b"first".to_vec())
    );
    assert_eq!(
        outcome.skipped,
        [SkippedSecret {
            service: "memry.calendar".to_owned(),
            account: "token".to_owned(),
            reason: SkipReason::Collision,
        }]
    );
}
