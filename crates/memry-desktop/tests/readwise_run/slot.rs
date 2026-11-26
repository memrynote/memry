//! The open vault's run service across opens, switches and closes (`readwise::slot`), on a
//! real session. The services are the rig's: none has a first import, so a started one never
//! runs, and a stopped one answers a Sync now with `Closing`.
//!
//! | Test                                                                  | Electron                 |
//! | --------------------------------------------------------------------- | ------------------------ |
//! | a switch stops the old vault's runs and starts the new vault's        | `runtime-effects.ts` stop/start |
//! | a late launch build, built or failed, leaves the new vault's runs     | -                        |
//! | a late launch build after a close holds nothing; the reopen waits     | -                        |
//! | a close leaves the slot empty                                         | `stop()`                 |

use std::fs;

use memry_desktop::readwise::scheduler::{ReadwiseRuns, SyncNowError};
use memry_desktop::readwise::slot::ReadwiseSlot;
use memry_desktop::session::{OpenSource, OpenVault, SessionError};

use super::schedule::{Rig, rig};
use super::*;

/// The rig's vault open, a slot attached as the shell attaches it, and the services its
/// builder hands out in order (`None` once they run out: a failed build).
struct Lane {
    r: Rig,
    slot: Arc<ReadwiseSlot>,
    built: Arc<Mutex<Vec<Arc<ReadwiseRuns>>>>,
}

fn lane() -> Lane {
    let r = rig("dev-a", Box::new(|| false));
    let slot = Arc::new(ReadwiseSlot::default());
    let built: Arc<Mutex<Vec<Arc<ReadwiseRuns>>>> = Arc::default();
    let handed = Arc::clone(&built);
    slot.attach(
        &r.v.e.session,
        Arc::new(move |_: &OpenVault| {
            let mut handed = handed.lock().unwrap();
            (!handed.is_empty()).then(|| handed.remove(0))
        }),
    );
    Lane { r, slot, built }
}

impl Lane {
    /// The next vault open builds `runs`.
    fn next_build(&self, runs: &Arc<ReadwiseRuns>) {
        self.built.lock().unwrap().push(Arc::clone(runs));
    }

    fn open(&self) -> OpenVault {
        self.r.v.e.session.current().expect("a vault is open")
    }

    fn switch_to_b(&self) {
        let b = self.r.v.e._dir.path().join("b");
        fs::create_dir_all(&b).unwrap();
        self.r.v.e.session.replace(&b, OpenSource::Switch).unwrap();
    }

    fn holds(&self, runs: &Arc<ReadwiseRuns>) -> bool {
        self.slot
            .current()
            .is_some_and(|held| Arc::ptr_eq(&held, runs))
    }
}

impl Drop for Lane {
    fn drop(&mut self) {
        // The tick threads block on the rig's runtime, which drops with the rig.
        self.slot.clear();
    }
}

fn stopped(runs: &ReadwiseRuns) -> bool {
    matches!(runs.sync_now(), Err(SyncNowError::Closing))
}

#[test]
fn a_switch_stops_the_old_vaults_runs_and_starts_the_new_vaults() {
    let l = lane();
    let (a, b) = (l.r.service(), l.r.service());
    l.slot
        .settle(&l.r.v.e.session, &l.open(), Some(Arc::clone(&a)));
    assert!(l.holds(&a), "the launch build");

    l.next_build(&b);
    l.switch_to_b();
    assert!(stopped(&a), "the switch stopped A's runs");
    assert!(l.holds(&b), "and holds B's");
}

#[test]
fn a_late_launch_build_built_or_failed_leaves_the_new_vaults_runs() {
    let l = lane();
    let launch_a = l.open();
    let b = l.r.service();
    l.next_build(&b);
    l.switch_to_b();

    let late = l.r.service();
    l.slot.settle(&l.r.v.e.session, &launch_a, Some(late));
    assert!(l.holds(&b), "a late build for A replaced B's runs");
    l.slot.settle(&l.r.v.e.session, &launch_a, None);
    assert!(l.holds(&b), "a late failed build for A stopped B's runs");
}

/// The launch build holds the vault's handle, and the session never opens a second live handle
/// for one vault, so a reopen during the build is refused rather than racing it.
#[test]
fn a_late_launch_build_after_a_close_holds_nothing_and_the_reopen_waits_for_it() {
    let mut l = lane();
    let launch = l.open();
    l.r.v.e.close();
    assert!(matches!(
        l.r.v.e.session.open(&l.r.v.e.vault, OpenSource::Select),
        Err(SessionError::Held(_))
    ));

    l.slot
        .settle(&l.r.v.e.session, &launch, Some(l.r.service()));
    assert!(l.slot.current().is_none(), "runs on the closed handle");
}

#[test]
fn a_close_leaves_the_slot_empty() {
    let mut l = lane();
    let a = l.r.service();
    l.slot
        .settle(&l.r.v.e.session, &l.open(), Some(Arc::clone(&a)));
    l.r.v.e.close();
    assert!(l.slot.current().is_none());
    assert!(stopped(&a));
}
