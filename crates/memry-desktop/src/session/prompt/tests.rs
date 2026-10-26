use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::session::fixture::*;

struct Answer(bool, AtomicUsize);

impl Asker for Answer {
    fn confirm_repair(&self, _data_db: &Path) -> bool {
        self.1.fetch_add(1, Ordering::SeqCst);
        self.0
    }
}

fn damaged_vault(f: &Fixture) -> (PathBuf, String) {
    let vault = f.vault("v");
    let opened = f.session.open(&vault, OpenSource::Select).expect("open");
    put_meta(&opened, "keep", "me");
    drop(opened);
    f.session.close();
    let path = data_db(&vault);
    let mut bytes = std::fs::read(&path).expect("read");
    bytes[..64].copy_from_slice(&[0xAB; 64]);
    std::fs::write(&path, &bytes).expect("damage");
    let digest = sha(&path);
    (vault, digest)
}

#[test]
fn repair_opens_the_rebuilt_vault_and_keeps_the_damaged_file() {
    let f = fixture();
    let (vault, before) = damaged_vault(&f);
    let prompt = RecoveryPrompt::default();
    let asker = Answer(true, AtomicUsize::new(0));
    let opened = prompt
        .open_with_offer(&f.session, &asker, &vault, || {
            f.session.open(&vault, OpenSource::Select)
        })
        .expect("opens after repair");
    assert!(f.session.status().is_open);
    drop(opened);
    assert_eq!(asker.1.load(Ordering::SeqCst), 1);
    let kept = std::fs::read_dir(vault.join(".memry/core"))
        .expect("dir")
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("data.db.corrupt-")
        })
        .map(|e| sha(&e.path()))
        .collect::<Vec<_>>();
    assert_eq!(kept, vec![before], "the damaged database is the backup");
}

#[test]
fn not_now_leaves_the_file_and_the_registry_alone_and_asks_once() {
    let f = fixture();
    let (vault, before) = damaged_vault(&f);
    let prompt = RecoveryPrompt::default();
    let asker = Answer(false, AtomicUsize::new(0));
    for _ in 0..2 {
        let outcome = prompt.open_with_offer(&f.session, &asker, &vault, || {
            f.session.open(&vault, OpenSource::Select)
        });
        assert!(matches!(outcome, Err(SessionError::Corrupt { .. })));
    }
    assert_eq!(asker.1.load(Ordering::SeqCst), 1, "once per app session");
    assert_eq!(sha(&data_db(&vault)), before);
    assert_eq!(
        f.session.registry().current().as_deref(),
        Some(&*vault.to_string_lossy())
    );
}

#[test]
fn a_healthy_vault_is_never_asked_about() {
    let f = fixture();
    let vault = f.vault("v");
    let prompt = RecoveryPrompt::default();
    let asker = Answer(true, AtomicUsize::new(0));
    prompt
        .open_with_offer(&f.session, &asker, &vault, || {
            f.session.open(&vault, OpenSource::Select)
        })
        .expect("open");
    assert_eq!(asker.1.load(Ordering::SeqCst), 0);
}

#[test]
fn a_damage_signal_on_the_open_vault_repairs_and_reopens_once() {
    let f = fixture();
    let vault = f.vault("v");
    let opened = f.session.open(&vault, OpenSource::Select).expect("open");
    put_meta(&opened, "keep", "me");
    drop(opened);
    let prompt = RecoveryPrompt::default();
    let asker = Answer(true, AtomicUsize::new(0));
    let outcome = prompt
        .offer_for_open_vault(&f.session, &asker)
        .expect("offered");
    assert!(outcome.is_ok());
    assert!(f.session.status().is_open);
    assert!(
        prompt.offer_for_open_vault(&f.session, &asker).is_none(),
        "the second signal of the same session is not offered again"
    );
    assert_eq!(asker.1.load(Ordering::SeqCst), 1);
}
