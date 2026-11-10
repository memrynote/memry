//! The open vault's notices (Step 14l, #3531): raised by what detects the state, through a
//! real vault session, tier and identity, and gone with the state or the vault.

#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::vault::config::config_path;
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::notices::{KeptRemoval, LISTED, Listed, VaultNotice, VaultNotices};
use memry_desktop::vault::watch::hit_watch_limit;
use vault_env::{Env, env, indexed};

fn noticing_env() -> (Env, Arc<VaultNotices>) {
    let (e, notices, _) = noticing_env_with_store();
    (e, notices)
}

fn noticing_env_with_store() -> (Env, Arc<VaultNotices>, Arc<dyn SecureStore>) {
    let notices = VaultNotices::new();
    let board = notices.clone();
    let mut kept = None;
    let e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::noticing(store, board))
    });
    notices.register(&e.session);
    (e, notices, kept.expect("the store"))
}

fn row_id(e: &Env, path: &str) -> String {
    e.rows()
        .into_iter()
        .find(|(_, p)| p == path)
        .map(|(id, _)| id)
        .expect("a row")
}

fn absolute(e: &Env, path: &str) -> String {
    e.vault.join(path).to_string_lossy().into_owned()
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

/// Every open starts with an empty board and finds its notices again; a close empties it, and
/// the next open is told apart from the last.
#[test]
fn a_notice_lasts_as_long_as_its_vault_is_open() {
    let (mut e, notices) = noticing_env();
    e.write(".memry/config.json", "{ \"journalFolder\": ");
    e.open();
    e.facts_until(indexed);
    assert_eq!(notices.list(), vec![unreadable(&e.vault)]);
    let first = notices.read().open;
    e.close();
    assert!(notices.list().is_empty(), "{:?}", notices.list());

    e.write(".memry/config.json", "{}");
    e.open();
    e.facts_until(indexed);
    assert!(notices.list().is_empty(), "{:?}", notices.list());
    assert_ne!(
        notices.read().open,
        first,
        "a window would keep what it closed"
    );
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

/// The Linux inotify limit hit as the vault opens: the vault still opens with its watcher,
/// shows the notice, and an outside edit made after the open reaches its note with the rescan
/// the limit owes (no folder is watched, so no OS event brings it).
#[test]
fn a_watch_limit_at_the_open_shows_and_rescans() {
    let (mut e, notices) = noticing_env();
    e.write("a.md", "A\n");
    hit_watch_limit(&e.vault);
    e.open();
    e.facts_until(indexed);
    until("the watch limit notice", || {
        notices.list() == vec![VaultNotice::WatchLimit]
    });

    e.write("a.md", "A, edited outside\n");
    e.facts_until(|fact| matches!(fact, Applied::Changed { path, .. } if path == "a.md"));
}

/// A file named like a note whose text is not the file's stays a file and is listed; once its
/// text is the note's again, the next ask names it and the notice goes.
#[test]
fn an_undecided_file_is_listed_until_it_is_named() {
    let (mut e, notices) = noticing_env();
    e.write("x.md", "Mine\n");
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, "x.md");
    let lost = id.clone();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute("DELETE FROM note_file_hashes WHERE note_id = ?1", [&lost])
                .unwrap();
            conn.execute("DELETE FROM note_files WHERE note_id = ?1", [&lost])
                .unwrap();
            Ok(())
        })
        .unwrap();
    e.close();
    e.write("x.md", "Another text\n");
    e.open();
    e.facts_until(indexed);
    assert_eq!(
        notices.list(),
        vec![VaultNotice::UndecidedFiles {
            paths: vec![absolute(&e, "x.md")],
            more: false
        }]
    );

    e.write("x.md", "Mine\n");
    e.facts_until(|f| matches!(f, Applied::Added { note_id, .. } if *note_id == id));
    assert!(notices.list().is_empty(), "{:?}", notices.list());
}

/// A file deleted outside the app whose note has an edit the file never got keeps its note,
/// which is listed at every open while the file is gone, and leaves the list once a file is at
/// its path again, while the vault is open or by the next open.
#[test]
fn a_kept_removal_is_listed_at_every_open_while_its_file_is_gone() {
    let (mut e, notices, store) = noticing_env_with_store();
    e.write("a.md", "Alpha\n");
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, "a.md");
    // An edit stamped in the row's own millisecond is not after it.
    std::thread::sleep(Duration::from_millis(2));
    e.edit_in_app(&store, &id, "typed in the app");
    fs::remove_file(e.vault.join("a.md")).unwrap();
    let kept = VaultNotice::KeptRemovals {
        notes: vec![KeptRemoval {
            note_id: id.clone(),
            path: absolute(&e, "a.md"),
        }],
        more: false,
    };
    until("the kept removal is listed", || {
        notices.list() == vec![kept.clone()]
    });

    e.close();
    e.drain();
    e.open();
    e.facts_until(indexed);
    assert_eq!(notices.list(), vec![kept]);

    e.write("a.md", "Alpha back\n");
    until("the kept removal leaves the list", || {
        notices.list().is_empty()
    });
    assert_eq!(row_id(&e, "a.md"), id, "the note keeps its row");

    e.close();
    e.drain();
    e.open();
    e.facts_until(indexed);
    assert!(notices.list().is_empty(), "{:?}", notices.list());
}

/// A kept note's file that comes back unreadable (not UTF-8) is still back: the note leaves
/// the kept list though its text cannot be read.
#[test]
fn a_kept_removal_leaves_the_list_when_its_file_returns_unreadable() {
    let (mut e, notices, store) = noticing_env_with_store();
    e.write("a.md", "Alpha\n");
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, "a.md");
    // An edit stamped in the row's own millisecond is not after it.
    std::thread::sleep(Duration::from_millis(2));
    e.edit_in_app(&store, &id, "typed in the app");
    fs::remove_file(e.vault.join("a.md")).unwrap();
    until("the kept removal is listed", || !notices.list().is_empty());

    fs::write(e.vault.join("a.md"), b"\xff\xfe not text\n").unwrap();
    until("the kept removal leaves the list", || {
        notices.list().is_empty()
    });
}

/// A kept note's file that comes back after the open listed it, and is deleted again, is
/// listed again while the vault is open: the open's removal does not hide the note's row from
/// the next one.
#[test]
fn a_returned_kept_file_deleted_again_is_listed_again() {
    let (mut e, notices, store) = noticing_env_with_store();
    e.write("a.md", "Alpha\n");
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, "a.md");
    std::thread::sleep(Duration::from_millis(2));
    e.edit_in_app(&store, &id, "typed in the app");
    fs::remove_file(e.vault.join("a.md")).unwrap();
    let kept = VaultNotice::KeptRemovals {
        notes: vec![KeptRemoval {
            note_id: id.clone(),
            path: absolute(&e, "a.md"),
        }],
        more: false,
    };
    until("the kept removal is listed", || {
        notices.list() == vec![kept.clone()]
    });
    e.close();
    e.drain();
    e.open();
    e.facts_until(indexed);
    assert_eq!(notices.list(), vec![kept.clone()]);

    e.write("a.md", "Alpha back\n");
    until("the kept removal leaves the list", || {
        notices.list().is_empty()
    });
    fs::remove_file(e.vault.join("a.md")).unwrap();
    until("the kept removal is listed again", || {
        notices.list() == vec![kept.clone()]
    });
}

/// A list notice names at most [`LISTED`] items and says there were more; it goes with its
/// last listed item only when it listed them all.
#[test]
fn a_list_notice_is_bounded() {
    let notices = VaultNotices::new();
    let root = Path::new("/vaults/open");
    notices.open(root);
    let paths: Vec<String> = (0..=LISTED)
        .map(|n| format!("/vaults/open/{n}.md"))
        .collect();
    assert!(notices.add(root, Listed::Undecided(&paths[0])), "first");
    for path in &paths {
        assert!(!notices.add(root, Listed::Undecided(path)), "raised again");
    }
    let [
        VaultNotice::UndecidedFiles {
            paths: listed,
            more,
        },
    ] = &notices.list()[..]
    else {
        panic!("{:?}", notices.list());
    };
    assert_eq!((listed.len(), *more), (LISTED, true));
    for path in &paths {
        notices.remove(root, Listed::Undecided(path));
    }
    assert_eq!(
        notices.list(),
        vec![VaultNotice::UndecidedFiles {
            paths: Vec::new(),
            more: true
        }],
        "the unlisted files are still undecided"
    );

    let kept = |note_id| Listed::Kept {
        note_id,
        path: "/vaults/open/a.md",
    };
    notices.add(root, kept("a"));
    notices.add(root, kept("b"));
    notices.remove(root, kept("a"));
    notices.remove(root, kept("b"));
    assert_eq!(notices.list().len(), 1, "{:?}", notices.list());
}
