//! A vault close whose OS watch is slow to stop, as notify's FSEvents stop is while fseventsd
//! is slow (#3784). The close lets the vault go without waiting for that stop, and the watch
//! still stopping reports nothing into the vault opened next.
//!
//! The close hooks get the session's own deadline, so a slow runner cannot make a close that
//! nothing blocks overrun it.

use std::time::Duration;

use memry_core::crdt::body_edit::BlockEdit;
use tokio::sync::broadcast::Receiver;

use super::late_close::{Gate, Two, eventually, two_with};
use super::*;
use crate::session::{HOOK_DEADLINE, OpenSource};
use crate::vault::consumer::Hold;

/// Nothing holds the vault once the close returns, and it opens again, while its OS watch has
/// not stopped yet.
#[test]
fn a_vault_whose_os_watch_is_slow_to_stop_opens_again_at_once() {
    let t = two_with(HOOK_DEADLINE);
    let gate = Gate::at(&t.tier, Hold::OsWatchStop);
    let (vault, _) = open_b(&t);
    let closed = Arc::downgrade(&vault);
    drop(vault);

    t.session.close();
    gate.wait_reached();
    if let Err(error) = t.session.open(&t.b, OpenSource::Select) {
        panic!("the vault did not open again: {error:?}");
    }
    assert_eq!(closed.strong_count(), 0, "the close kept the vault");
    gate.release();
    t.session.close();
}

/// An edit scheduled while the vault closes, after its watcher and consumer stopped, is in
/// the file once the close returns: the write-back's last passes do not wait for the OS watch
/// to stop.
#[test]
fn a_close_writes_its_last_edit_without_waiting_for_the_os_watch_to_stop() {
    let t = two_with(HOOK_DEADLINE);
    let gate = Gate::at(&t.tier, Hold::OsWatchStop);
    let (vault, id) = open_b(&t);
    let (tier, store) = (t.tier.clone(), t.store.clone());
    t.tier.hold_at(Hold::ConsumerStopped, move || {
        let blocks = vault.notes().blocks(id.clone()).unwrap().unwrap();
        let edit = BlockEdit::SetText {
            block_id: blocks.iter().find_map(|b| b.id.clone()).unwrap(),
            text: "typed as the vault closed".into(),
        };
        let writer = vault.notes_writer(store).unwrap();
        assert!(writer.edit_block(id.clone(), edit).unwrap());
        tier.schedule(&id);
    });

    t.session.close();
    assert_eq!(
        std::fs::read_to_string(t.b.join("n.md")).unwrap(),
        "typed as the vault closed\n",
        "the close did not write the edit scheduled as it closed"
    );
    gate.wait_reached();
    gate.release();
}

/// A file written into a closed vault while its OS watch is still stopping reaches no fact
/// and no row, while the vault opened since reports its own new file.
#[test]
fn an_os_watch_still_stopping_reports_nothing_into_the_next_vault() {
    let t = two_with(HOOK_DEADLINE);
    let mut facts = t.tier.subscribe();
    let gate = Gate::at(&t.tier, Hold::OsWatchStop);
    t.session.open(&t.a, OpenSource::Select).unwrap();
    t.session.close();
    gate.wait_reached();
    let vault = t
        .session
        .open(&t.b, OpenSource::Select)
        .unwrap()
        .vault
        .vault;

    std::fs::write(t.a.join("late.md"), "written in A after it closed\n").unwrap();
    std::fs::write(t.b.join("live.md"), "written in B\n").unwrap();
    let mut seen = Vec::new();
    eventually("B's new file", || {
        seen.extend(drain(&mut facts));
        names(&seen, "live.md").then_some(())
    });
    // A fact about A's file would have come with B's: the same debounce and grace.
    std::thread::sleep(Duration::from_secs(1));
    seen.extend(drain(&mut facts));
    assert!(
        !names(&seen, "late.md"),
        "A's closed watch reported: {seen:?}"
    );
    assert!(vault.note_files().by_path("late.md").unwrap().is_none());
    gate.release();
    drop(vault);
    t.session.close();
}

/// Opens `b` and waits for its note, which it returns with the vault.
fn open_b(t: &Two) -> (Arc<Vault>, String) {
    let vault = t
        .session
        .open(&t.b, OpenSource::Select)
        .unwrap()
        .vault
        .vault;
    let id = eventually("B's note", || {
        vault
            .note_files()
            .by_path("n.md")
            .unwrap()
            .filter(|row| row.content_hash.is_some())
            .map(|row| row.note_id)
    });
    (vault, id)
}

fn drain(facts: &mut Receiver<Applied>) -> Vec<Applied> {
    std::iter::from_fn(|| facts.try_recv().ok()).collect()
}

fn names(facts: &[Applied], rel: &str) -> bool {
    facts.iter().any(|fact| format!("{fact:?}").contains(rel))
}
