//! The supervisor's snapshot pushes on a paused tokio clock: the 2 s due check runs a pass that
//! ends with the push, and the shutdown step pushes what is pending unless an update installs.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio::time::{Instant, sleep};

use super::super::triggers::SNAPSHOT_TICK;
use super::rig::{Rig, settle};

#[tokio::test(start_paused = true)]
async fn a_due_snapshot_runs_a_pass_that_pushes_it() {
    let rig = Rig::new();
    let _supervisor = rig.start().await;
    settle().await;
    let passes = rig.passes();
    rig.backend
        .driver
        .snapshot_due
        .store(true, Ordering::SeqCst);
    sleep(SNAPSHOT_TICK).await;
    settle().await;
    assert_eq!(rig.passes(), passes + 1, "the due check runs one pass");
    assert_eq!(rig.backend.driver.snapshot_rounds.load(Ordering::SeqCst), 1);
    sleep(SNAPSHOT_TICK * 3).await;
    settle().await;
    assert_eq!(rig.passes(), passes + 1, "nothing due, no pass");
}

#[tokio::test(start_paused = true)]
async fn final_snapshots_reach_the_open_driver_and_skip_a_paused_one() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    settle().await;
    supervisor
        .final_snapshots(Instant::now() + Duration::from_secs(2))
        .await;
    assert_eq!(rig.backend.driver.final_rounds.load(Ordering::SeqCst), 1);
    supervisor.set_paused(true).await.unwrap();
    supervisor
        .final_snapshots(Instant::now() + Duration::from_secs(2))
        .await;
    assert_eq!(
        rig.backend.driver.final_rounds.load(Ordering::SeqCst),
        1,
        "a paused vault pushes nothing"
    );
}
