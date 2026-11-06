//! A restart of the watcher and the consumer on new exclude patterns (`VaultTier::rewatch`,
//! Step 13m-7b-3) against the close of its vault: a close never leaves an open behind, and a
//! restart that could not start the watcher is tried again by the next.

use std::time::Duration;

use super::late_close::{Gate, WAIT, eventually, two_with};
use crate::session::OpenSource;
use crate::vault::config::settings::{SettingsError, update_vault_settings};
use crate::vault::config::{VaultConfigPatch, read_vault_config};
use crate::vault::consumer::{Applied, Hold};

/// A close that arrives while a restart is between its stop and its start waits for the
/// restart, then stops what it started: nothing keeps the vault, which opens again at once.
#[test]
fn a_close_during_a_restart_stops_what_the_restart_started() {
    let t = two_with(WAIT);
    let opened = t.session.open(&t.b, OpenSource::Select).unwrap();
    let vault = opened.vault.vault.clone();
    let start = Gate::at(&t.tier, Hold::WatcherStart);
    std::thread::scope(|s| {
        let restart = s.spawn(|| t.tier.rewatch(&vault, &mut || {}));
        start.wait_reached();
        let clears = Gate::at(&t.tier, Hold::StopClears);
        let close = s.spawn(|| t.session.close());
        // Room for a close that does not wait to read the open and reach its clearing.
        std::thread::sleep(Duration::from_millis(300));
        start.release();
        restart.join().unwrap().unwrap();
        clears.release();
        close.join().unwrap();
    });
    drop((vault, opened));
    t.session
        .open(&t.b, OpenSource::Select)
        .expect("nothing holds the vault after its close");
    t.session.close();
}

/// A restart that finds its open stopped by a close, the slot not cleared yet, starts nothing.
#[test]
fn a_restart_after_a_close_stopped_the_open_starts_nothing() {
    let t = two_with(WAIT);
    let mut facts = t.tier.subscribe();
    let opened = t.session.open(&t.b, OpenSource::Select).unwrap();
    let vault = opened.vault.vault.clone();
    eventually("the open walk's end", || {
        matches!(facts.try_recv(), Ok(Applied::Indexed { .. })).then_some(())
    });
    let clears = Gate::at(&t.tier, Hold::StopClears);
    std::thread::scope(|s| {
        let close = s.spawn(|| t.session.close());
        clears.wait_reached();
        t.tier.rewatch(&vault, &mut || {}).unwrap();
        // A watcher started now would rescan, and its consumer walk and end with `Indexed`.
        std::thread::sleep(Duration::from_millis(1500));
        let started: Vec<_> = std::iter::from_fn(|| facts.try_recv().ok()).collect();
        assert!(started.is_empty(), "{started:?}");
        clears.release();
        close.join().unwrap();
    });
    drop((vault, opened));
    t.session
        .open(&t.b, OpenSource::Select)
        .expect("nothing holds the vault after its close");
    t.session.close();
}

/// A pattern change whose watcher could not start is saved and sent, and answers that the
/// vault is unwatched; the next change starts the watcher, and an outside edit reaches its
/// note again. The watcher fails only on a
/// folder that is gone, and Windows cannot move a folder whose database is open.
#[cfg(unix)]
#[test]
fn a_restart_that_could_not_start_the_watcher_is_tried_again() {
    let t = two_with(WAIT);
    let opened = t.session.open(&t.b, OpenSource::Select).unwrap();
    let vault = opened.vault.vault.clone();
    let id = eventually("b's note", || {
        vault
            .note_files()
            .by_path("n.md")
            .unwrap()
            .filter(|row| row.content_hash.is_some())
            .map(|row| row.note_id)
    });
    let (root, aside) = (t.b.clone(), t.b.with_extension("aside"));
    let moved = (root.clone(), aside.clone());
    t.tier.hold_at(Hold::WatcherStart, move || {
        std::fs::rename(&moved.0, &moved.1).unwrap();
    });
    let excludes = |patterns: &[&str]| VaultConfigPatch {
        exclude_patterns: Some(patterns.iter().map(|p| (*p).to_owned()).collect()),
        ..VaultConfigPatch::default()
    };
    let mut heard = None;
    let refused = update_vault_settings(
        &root,
        Some((&vault, &t.tier)),
        excludes(&["archive"]),
        |settings| heard = Some(settings.clone()),
    );
    std::fs::rename(&aside, &root).unwrap();
    assert!(
        matches!(refused, Err(SettingsError::Unwatched(_))),
        "{refused:?}"
    );
    // Saved and sent all the same.
    assert_eq!(heard.unwrap().exclude_patterns, ["archive"]);
    assert_eq!(read_vault_config(&root).exclude_patterns, ["archive"]);
    update_vault_settings(&root, Some((&vault, &t.tier)), excludes(&[]), |_| {}).unwrap();

    std::thread::sleep(Duration::from_millis(500));
    std::fs::write(root.join("n.md"), "edited outside\n").unwrap();
    eventually("the outside edit", || {
        let blocks = vault.notes().blocks(id.clone()).unwrap()?;
        blocks
            .iter()
            .any(|b| {
                b.inline
                    .iter()
                    .any(|run| run.text.contains("edited outside"))
            })
            .then_some(())
    });
    drop((vault, opened));
    t.session.close();
}
