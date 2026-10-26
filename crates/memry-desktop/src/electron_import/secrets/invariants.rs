//! The report never says less than the profile holds without saying so, never asks a key source
//! twice for one key, and never turns a failure into "missing".

use std::cell::RefCell;
use std::collections::BTreeMap;

use super::tests::FixedKeytar;
use super::*;
use crate::electron_import::profile::{LEGACY_APP_NAME, MEMRYNOTE_APP_NAME};
use crate::electron_import::tests::macos_fixture;

/// Answers per app name and records every query.
#[derive(Default)]
struct Scripted {
    answers: BTreeMap<&'static str, Result<Option<Vec<u8>>, KeySourceError>>,
    asked: RefCell<Vec<String>>,
}

impl ChromiumKeySource for Scripted {
    fn password(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
        self.asked.borrow_mut().push(name.to_owned());
        self.answers
            .get(name)
            .cloned()
            .unwrap_or(Ok(None))
            .map(|v| v.map(Zeroizing::new))
    }

    fn windows_key(
        &self,
        _: &ElectronProfile,
    ) -> Result<Option<Zeroizing<[u8; 32]>>, KeySourceError> {
        Ok(None)
    }
}

fn recorded(f: &crate::electron_import::tests::Fixture) -> Vec<u8> {
    f.expected.macos_password.clone().unwrap().into_bytes()
}

#[test]
fn the_second_app_name_is_not_asked_when_the_first_decrypts_everything() {
    let f = macos_fixture("new");
    let (Some(&first), Some(&second)) =
        (f.profile.app_names.0.first(), f.profile.app_names.0.get(1))
    else {
        panic!("two app name candidates");
    };
    let keys = Scripted {
        answers: BTreeMap::from([
            (first, Ok(Some(recorded(&f)))),
            (second, Err(KeySourceError::Denied)),
        ]),
        ..Scripted::default()
    };
    let report = read_all_secrets(&f.profile, &keys, &NoKeytar).unwrap();
    assert!(report.unreadable.is_empty(), "{:?}", report.unreadable);
    assert_eq!(*keys.asked.borrow(), [first]);
}

#[test]
fn each_key_is_asked_once_however_many_entries_need_it() {
    let f = macos_fixture("new");
    let keys = Scripted {
        answers: BTreeMap::from([(MEMRYNOTE_APP_NAME, Err(KeySourceError::Denied))]),
        ..Scripted::default()
    };
    read_all_secrets(&f.profile, &keys, &NoKeytar).unwrap();
    let asked = keys.asked.borrow();
    assert_eq!(asked.iter().filter(|n| *n == MEMRYNOTE_APP_NAME).count(), 1);
    assert_eq!(asked.iter().filter(|n| *n == LEGACY_APP_NAME).count(), 1);
}

#[test]
fn a_denied_name_outranks_a_wrong_key_on_the_other_name() {
    let f = macos_fixture("new");
    let keys = Scripted {
        answers: BTreeMap::from([
            (MEMRYNOTE_APP_NAME, Ok(Some(b"wrong".to_vec()))),
            (LEGACY_APP_NAME, Err(KeySourceError::Denied)),
        ]),
        ..Scripted::default()
    };
    let report = read_all_secrets(&f.profile, &keys, &NoKeytar).unwrap();
    assert!(!report.unreadable.is_empty());
    assert!(
        report
            .unreadable
            .iter()
            .all(|u| u.reason == UnreadableReason::KeySourceDenied)
    );
}

#[test]
fn a_failing_key_source_is_failed_with_its_message_never_missing() {
    let f = macos_fixture("new");
    let keys = Scripted {
        answers: BTreeMap::from([
            (
                MEMRYNOTE_APP_NAME,
                Err(KeySourceError::Failed("timed out after 5s".into())),
            ),
            (LEGACY_APP_NAME, Ok(None)),
        ]),
        ..Scripted::default()
    };
    let report = read_all_secrets(&f.profile, &keys, &NoKeytar).unwrap();
    assert!(!report.unreadable.is_empty());
    for u in &report.unreadable {
        assert_eq!(u.reason, UnreadableReason::KeySourceFailed);
        assert_eq!(u.detail.as_deref(), Some("timed out after 5s"));
    }
}

/// Counts reads and can fail either step.
struct Tracking {
    inner: FixedKeytar,
    reads: RefCell<Vec<String>>,
    list_error: Option<KeySourceError>,
    read_error: Option<KeySourceError>,
}

impl KeytarSource for Tracking {
    fn list(&self) -> Result<Vec<(String, String)>, KeySourceError> {
        match &self.list_error {
            Some(error) => Err(error.clone()),
            None => self.inner.list(),
        }
    }

    fn read(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<String>>, KeySourceError> {
        self.reads.borrow_mut().push(format!("{service}/{account}"));
        match &self.read_error {
            Some(error) => Err(error.clone()),
            None => self.inner.read(service, account),
        }
    }
}

fn tracking(read_error: Option<KeySourceError>, list_error: Option<KeySourceError>) -> Tracking {
    Tracking {
        inner: FixedKeytar(vec![
            ("com.memry.sync", "master-key", "from-keytar"),
            ("com.memry.sync", "extra", "only-keytar"),
        ]),
        reads: RefCell::default(),
        list_error,
        read_error,
    }
}

fn recorded_keys(f: &crate::electron_import::tests::Fixture) -> Scripted {
    Scripted {
        answers: BTreeMap::from([
            (MEMRYNOTE_APP_NAME, Ok(Some(recorded(f)))),
            (LEGACY_APP_NAME, Ok(Some(recorded(f)))),
        ]),
        ..Scripted::default()
    }
}

#[test]
fn keytar_secrets_are_read_only_for_items_nothing_decrypted() {
    let f = macos_fixture("new");
    let keytar = tracking(None, None);
    let report = read_all_secrets(&f.profile, &recorded_keys(&f), &keytar).unwrap();
    assert_eq!(*keytar.reads.borrow(), ["com.memry.sync/extra"]);
    assert_eq!(report.get("com.memry.sync", "extra"), Some("only-keytar"));
    assert_eq!(
        report.get("com.memry.sync", "master-key"),
        Some("fixture-master-key-aGVsbG8=")
    );
}

#[test]
fn a_keytar_listing_failure_keeps_every_decrypted_entry_and_is_reported() {
    let f = macos_fixture("new");
    let keytar = tracking(None, Some(KeySourceError::Failed("keychain broke".into())));
    let report = read_all_secrets(&f.profile, &recorded_keys(&f), &keytar).unwrap();
    assert!(report.unreadable.is_empty());
    assert!(report.get("com.memry.sync", "master-key").is_some());
    assert!(report.keytar_error.unwrap().contains("keychain broke"));
}

#[test]
fn a_keytar_read_failure_makes_that_item_unreadable_and_keeps_the_rest() {
    let f = macos_fixture("new");
    let keytar = tracking(Some(KeySourceError::Denied), None);
    let report = read_all_secrets(&f.profile, &recorded_keys(&f), &keytar).unwrap();
    assert!(report.get("com.memry.sync", "master-key").is_some());
    assert_eq!(
        report.unreadable,
        [UnreadableSecret {
            service: "com.memry.sync".into(),
            account: "extra".into(),
            reason: UnreadableReason::KeySourceDenied,
            detail: None,
        }]
    );
}
