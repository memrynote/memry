//! The open vault's notices (Step 14l, #3531): raised by what detects the state, through a
//! real vault session, tier and identity, and gone with the state or the vault.

#[allow(unused_imports)]
use crate::vault_env;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::vault::config::config_path;
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::notices::{VaultNotice, VaultNotices};
use memry_desktop::vault::watch::VaultEvent;
use tokio::sync::broadcast;
use vault_env::{Env, env, indexed};

fn noticing_env() -> (Env, Arc<VaultNotices>) {
    let notices = VaultNotices::new();
    let board = notices.clone();
    let e = env(|store| Some(NotesIdentity::noticing(store, board)));
    notices.register(&e.session);
    (e, notices)
}

fn until(what: &str, holds: impl Fn() -> bool) {
    let deadline = Instant::now() + vault_env::WAIT;
    while !holds() {
        assert!(Instant::now() < deadline, "never: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn unreadable(vault: &Path) -> VaultNotice {
    VaultNotice::ConfigUnreadable {
        path: config_path(vault).to_string_lossy().into_owned(),
    }
}

/// A config that cannot be read shows its notice from the open on, the window that subscribes
/// is told, and the notice goes once a file event finds the config readable again.
#[test]
fn an_unreadable_vault_config_shows_until_it_reads() {
    let (mut e, notices) = noticing_env();
    let mut changed = notices.subscribe();
    e.write(".memry/config.json", "{ \"journalFolder\": ");
    e.write("a.md", "A\n");
    e.open();
    e.facts_until(indexed);
    assert_eq!(notices.list(), vec![unreadable(&e.vault)]);
    assert!(changed.try_recv().is_ok(), "no change was told");

    e.write(".memry/config.json", "{}");
    e.write("b.md", "B\n");
    until("the notice cleared", || notices.list().is_empty());
}

/// Every open starts with an empty board and finds its notices again; a close empties it.
#[test]
fn a_notice_lasts_as_long_as_its_vault_is_open() {
    let (mut e, notices) = noticing_env();
    e.write(".memry/config.json", "{ \"journalFolder\": ");
    e.open();
    e.facts_until(indexed);
    assert_eq!(notices.list(), vec![unreadable(&e.vault)]);
    e.close();
    assert!(notices.list().is_empty(), "{:?}", notices.list());

    e.write(".memry/config.json", "{}");
    e.open();
    e.facts_until(indexed);
    assert!(notices.list().is_empty(), "{:?}", notices.list());
}

/// A report of a vault that is not the open one is dropped, and its late close leaves the open
/// vault's notices alone.
#[test]
fn a_notice_of_another_vault_is_dropped() {
    let notices = VaultNotices::new();
    let (open, other) = (Path::new("/vaults/open"), Path::new("/vaults/other"));
    notices.open(open);
    assert!(!notices.raise(other, VaultNotice::WatchLimit));
    assert!(notices.raise(open, VaultNotice::WatchLimit));
    assert!(
        !notices.raise(open, VaultNotice::WatchLimit),
        "raised twice"
    );
    notices.close(other);
    assert_eq!(notices.list(), vec![VaultNotice::WatchLimit]);
}

/// The watcher's report of the Linux inotify limit shows the notice; any other watcher failure
/// does not.
#[test]
fn the_watch_limit_shows_a_notice() {
    let notices = VaultNotices::new();
    let (facts, receiver) = broadcast::channel(8);
    notices.follow(receiver);
    notices.open(Path::new("/vaults/open"));
    let failed = |limit| {
        Applied::Vault(VaultEvent::WatchFailed {
            message: "watch failed".to_owned(),
            limit,
        })
    };
    facts.send(failed(false)).unwrap();
    facts.send(Applied::Indexed { complete: true }).unwrap();
    facts.send(failed(true)).unwrap();
    until("the watch limit notice", || {
        notices.list() == vec![VaultNotice::WatchLimit]
    });
}
