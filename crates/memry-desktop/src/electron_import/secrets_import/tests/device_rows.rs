//! The device key against the vaults' current-device rows: only the rows of Electron's own
//! device id count, since a vault not open at sign-out keeps the previous session's row.

use super::*;

#[test]
fn a_previous_session_s_row_in_another_vault_is_not_compared() {
    let w = world();
    let mut evidence = evidence();
    evidence
        .vaults
        .push(registered("device-before-sign-out", 8));
    let outcome = w.run(&evidence, SecretsMode::Full).unwrap();
    assert_eq!(outcome.device_key, DeviceKey::Adopted);
    assert!(outcome.device_checked);
}

#[test]
fn a_row_of_electron_s_device_id_with_another_key_is_device_key_mismatch() {
    let w = world();
    let before = w.electron();
    let evidence = SecretsEvidence {
        vaults: vec![
            registered("device-before-sign-out", 9),
            registered(DEVICE_ID, 8),
        ],
        ..evidence()
    };
    assert_eq!(
        w.run(&evidence, SecretsMode::Full),
        Err(SecretsError::DeviceKeyMismatch)
    );
    assert_eq!(w.writes(), 0);
    assert_eq!(w.electron(), before);
}

#[test]
fn without_electron_s_device_id_only_the_last_open_vault_is_compared() {
    let w = world();
    let last_open = |index| SecretsEvidence {
        device_id: None,
        current_vault: Some(index),
        vaults: vec![
            registered("device-before-sign-out", 8),
            registered(DEVICE_ID, 9),
        ],
        ..evidence()
    };
    assert_eq!(
        w.run(&last_open(0), SecretsMode::Full),
        Err(SecretsError::DeviceKeyMismatch)
    );
    assert_eq!(w.writes(), 0);
    let outcome = w.run(&last_open(1), SecretsMode::Full).unwrap();
    assert_eq!(outcome.device_key, DeviceKey::Adopted);
    assert!(outcome.device_checked);
}

#[test]
fn with_no_registered_row_of_electron_s_device_the_key_is_taken_unchecked() {
    for evidence in [
        SecretsEvidence {
            vaults: vec![
                registered("device-before-sign-out", 8),
                VaultEvidence::default(),
            ],
            ..evidence()
        },
        SecretsEvidence {
            device_id: None,
            current_vault: None,
            ..evidence()
        },
    ] {
        let w = world();
        let outcome = w.run(&evidence, SecretsMode::Full).unwrap();
        assert_eq!(outcome.device_key, DeviceKey::Adopted);
        assert!(!outcome.device_checked, "{evidence:?}");
    }
}
