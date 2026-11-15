//! Ports of `vault-account-binding.test.ts` (`decideVaultBinding`, `isChoiceAllowed`,
//! `folderHasFiles`).

use super::*;

fn base() -> BindingInputs {
    BindingInputs {
        binding: None,
        user_id: "user-b".into(),
        local_vault_uuid: "local-vault".into(),
        has_local_content: true,
        has_foreign_history: false,
        account_vaults: Some(Vec::new()),
    }
}

fn bound(user: &str, mode: BindingMode) -> Option<StoredBinding> {
    Some(StoredBinding {
        user_id: user.into(),
        mode,
    })
}

fn vault(id: &str) -> AccountVault {
    AccountVault {
        vault_uuid: id.into(),
        name: None,
    }
}

const START: Decision = Decision::Start { bind: false };
const BIND: Decision = Decision::Start { bind: true };

#[test]
fn the_binding_table() {
    let foreign = Decision::Hold(BindingState::Foreign);
    let cases: Vec<(&str, BindingInputs, Decision)> = vec![
        (
            "already bound to this account",
            BindingInputs {
                binding: bound("user-b", BindingMode::Sync),
                ..base()
            },
            START,
        ),
        (
            "bound to another account, even empty",
            BindingInputs {
                binding: bound("user-a", BindingMode::Sync),
                has_local_content: false,
                ..base()
            },
            foreign.clone(),
        ),
        (
            "this account kept it local",
            BindingInputs {
                binding: bound("user-b", BindingMode::Local),
                ..base()
            },
            Decision::Hold(BindingState::LocalOnly),
        ),
        (
            "empty binds without asking, even offline",
            BindingInputs {
                has_local_content: false,
                account_vaults: None,
                ..base()
            },
            BIND,
        ),
        (
            "ownership cannot be checked",
            BindingInputs {
                account_vaults: None,
                ..base()
            },
            Decision::Hold(BindingState::Unknown),
        ),
        (
            "an older version's vault the account knows",
            BindingInputs {
                has_foreign_history: true,
                account_vaults: Some(vec![vault("local-vault")]),
                ..base()
            },
            BIND,
        ),
        (
            "another session's history on an unknown vault",
            BindingInputs {
                has_foreign_history: true,
                account_vaults: Some(vec![vault("account-vault")]),
                ..base()
            },
            foreign,
        ),
        (
            "local content asks, offering a vault to merge",
            BindingInputs {
                account_vaults: Some(vec![vault("account-vault"), vault("other")]),
                ..base()
            },
            Decision::Hold(BindingState::NeedsDecision {
                account_vault_count: 2,
                merge_target: Some(MergeTarget {
                    vault_uuid: "account-vault".into(),
                    name: None,
                }),
            }),
        ),
        (
            "an empty account asks with nothing to merge into",
            base(),
            Decision::Hold(BindingState::NeedsDecision {
                account_vault_count: 0,
                merge_target: None,
            }),
        ),
        (
            "another account only kept it local",
            BindingInputs {
                binding: bound("user-a", BindingMode::Local),
                has_local_content: false,
                ..base()
            },
            BIND,
        ),
    ];
    for (name, input, want) in cases {
        assert_eq!(decide(&input), want, "{name}");
    }
}

#[test]
fn which_choices_each_state_takes() {
    use BindingChoice::{Local, Merge, Sync};
    let needs = |target: Option<&str>| BindingState::NeedsDecision {
        account_vault_count: 1,
        merge_target: target.map(|t| MergeTarget {
            vault_uuid: t.into(),
            name: None,
        }),
    };
    for state in [
        BindingState::Foreign,
        BindingState::Bound,
        BindingState::Unknown,
    ] {
        for choice in [Sync, Merge, Local] {
            assert!(!is_choice_allowed(&state, choice), "{state:?} {choice:?}");
        }
    }
    assert!(!is_choice_allowed(&needs(None), Merge));
    assert!(is_choice_allowed(&needs(None), Sync));
    assert!(is_choice_allowed(&needs(None), Local));
    assert!(is_choice_allowed(&needs(Some("v")), Merge));
    assert!(is_choice_allowed(&BindingState::LocalOnly, Sync));
    assert!(!is_choice_allowed(&BindingState::LocalOnly, Local));
    assert!(!is_choice_allowed(&BindingState::LocalOnly, Merge));
}

#[test]
fn the_stored_json_is_electrons() {
    let json = serde_json::to_string(&StoredBinding {
        user_id: "u1".into(),
        mode: BindingMode::Sync,
    })
    .unwrap();
    assert_eq!(json, r#"{"userId":"u1","mode":"sync"}"#);
    let local: StoredBinding = serde_json::from_str(r#"{"userId":"u1","mode":"local"}"#).unwrap();
    assert_eq!(local.mode, BindingMode::Local);
    assert!(serde_json::from_str::<StoredBinding>(r#"{"userId":"u1","mode":"other"}"#).is_err());
}

#[test]
fn folders_and_app_state_are_empty_and_a_nested_note_is_content() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".memry/core")).unwrap();
    std::fs::write(dir.path().join(".memry/core/data.db"), b"x").unwrap();
    std::fs::create_dir_all(dir.path().join("notes/deep")).unwrap();
    assert!(!folder_has_files(dir.path()));
    std::fs::write(dir.path().join("notes/deep/a.md"), b"# a").unwrap();
    assert!(folder_has_files(dir.path()));
}
