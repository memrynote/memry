//! The write-back end to end, over a real session, the shipped tier and its watcher: an edit
//! reaches the file, an outside edit reaches the body, and no scheduled edit waits out a quit,
//! whichever way the app quits. The single-pass rules and the timing are the unit tests in
//! `src/vault/writeback/tests/`.

mod device_key;
mod vault_env;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::shell::shutdown::{Deadline, SESSION_END_BUDGET};
use memry_desktop::shell::shutdown::{
    ShutdownCore, ShutdownEffects, ShutdownReason, StepFn, UpdateApplyHook,
};
use memry_desktop::telemetry::crash::ShutdownFailure;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::writeback::DEBOUNCE;
use vault_env::{Creates, Env, QUIET, WAIT, creates, edit_in_app, env, indexed};

/// A vault holding one note, `n.md` ("first words"), whose file the document holds.
fn one_note() -> (Env, Arc<Creates>, String) {
    let identity = Mutex::new(None);
    let mut e = env(|store| {
        let made = creates(store);
        *identity.lock().unwrap() = Some(made.clone());
        Some(made)
    });
    let identity = identity.into_inner().unwrap().unwrap();
    e.write("n.md", "first words\n");
    e.open();
    e.facts_until(indexed);
    let id = e.rows()[0].0.clone();
    // The watcher's start settles before the test edits the file.
    std::thread::sleep(Duration::from_millis(300));
    (e, identity, id)
}

/// Parks the consumer inside the offer of a new file, with the rows' lane held: a pass waits
/// for the lane until [`Creates::release`].
fn park_the_consumer(e: &Env, identity: &Creates) {
    identity.hold();
    e.write("parked.md", "parked\n");
    let deadline = std::time::Instant::now() + WAIT;
    while !identity
        .offered
        .lock()
        .unwrap()
        .iter()
        .any(|p| p == "parked.md")
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the new file was never offered"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn watcher_changed(id: &str) -> impl Fn(&Applied) -> bool + '_ {
    move |f| matches!(f, Applied::Changed { note_id, source: ChangeSource::Watcher, .. } if note_id == id)
}

/// The seam Steps 14 and 17 call: an edit made in the app, scheduled the way the editor and
/// the sync driver do, reaches the file, and the watcher takes that write for the app's own.
#[test]
fn a_scheduled_edit_reaches_the_file_and_the_watcher_takes_it_for_the_apps() {
    let (mut e, identity, id) = one_note();
    e.edit_in_app(&identity.store, &id, "typed in the app");
    e.tier.schedule(&id);
    e.facts_until(|f| {
        matches!(f, Applied::Changed { note_id, source: ChangeSource::App, .. } if *note_id == id)
    });
    assert_eq!(e.read("n.md"), "typed in the app\n");
    std::thread::sleep(QUIET);
    let later = e.drain();
    assert!(
        !later.iter().any(|f| matches!(
            f,
            Applied::Changed {
                source: ChangeSource::Watcher,
                ..
            }
        )),
        "the app's write came back as an outside edit: {later:?}"
    );
    let core = e.core();
    e.close();
    // A schedule after the close writes nothing into the closed vault.
    edit_in_app(&core, &identity.store, &id, "typed after the close");
    e.tier.schedule(&id);
    std::thread::sleep(DEBOUNCE + QUIET);
    assert_eq!(e.read("n.md"), "typed in the app\n");
}

#[test]
fn an_outside_edit_reaches_the_body_and_the_replaced_body_is_kept() {
    let (mut e, _, id) = one_note();
    e.write("n.md", "edited outside\n");
    e.facts_until(watcher_changed(&id));
    assert_eq!(e.body(&id), "edited outside");
    let kept = e.versions(&id);
    assert!(kept.iter().any(|v| v.contains("first words")), "{kept:?}");
}

/// The file is edited outside while an edit made in the app waits for its write. Whichever
/// lands first, the outside edit is the file and the body, and the app's edit is a version.
#[test]
fn an_outside_edit_made_before_the_apps_write_wins_and_the_apps_edit_is_kept() {
    let (mut e, identity, id) = one_note();
    e.edit_in_app(&identity.store, &id, "typed in the app");
    e.tier.schedule(&id);
    e.write("n.md", "edited outside\n");
    e.facts_until(watcher_changed(&id));
    assert!(e.tier.flush(WAIT));
    std::thread::sleep(QUIET);
    assert_eq!(e.read("n.md"), "edited outside\n");
    assert_eq!(e.body(&id), "edited outside");
    let kept = e.versions(&id);
    assert!(
        kept.iter().any(|v| v.contains("typed in the app")),
        "{kept:?}"
    );
}

#[cfg(unix)]
#[test]
fn a_write_back_that_fails_reaches_the_tiers_failure_subscribers() {
    use std::os::unix::fs::PermissionsExt;
    let (e, identity, id) = one_note();
    let mut failures = e.tier.subscribe_failures();
    e.edit_in_app(&identity.store, &id, "typed in the app");
    let path = e.vault.join("n.md");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    e.tier.schedule(&id);
    assert!(e.tier.flush(WAIT));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(failures.try_recv().unwrap().note_id, id);
}

/// How the process ended, and what the note's file held at that moment.
type Exits = Arc<Mutex<Vec<(&'static str, String)>>>;

struct Effects {
    file: PathBuf,
    exits: Exits,
}

impl Effects {
    fn record(&self, how: &'static str) {
        let text = std::fs::read_to_string(&self.file).unwrap();
        self.exits.lock().unwrap().push((how, text));
    }
}

impl ShutdownEffects for Effects {
    fn step_started(&self, _: &str) {}
    fn mark_failure(&self, _: ShutdownFailure, _: Option<&str>) {}
    fn clear_marker(&self) {}
    fn exit_clean(&self) {
        self.record("exit_clean");
    }
    fn terminate(&self) {
        self.record("terminate");
    }
}

/// The user chose "restart to update".
struct Update(Arc<Effects>);

impl UpdateApplyHook for Update {
    fn disable_install_on_quit(&self) {}
    fn enable_install_on_quit(&self) {}
    fn install_requested(&self) -> bool {
        true
    }
    fn apply_and_restart(&self) {
        self.0.record("apply_and_restart");
    }
    fn apply_on_quit(&self) {}
}

/// A quit of the app as the shell wires it: the tier's step as `flush-writebacks`, and
/// `extra` for the other steps a test needs.
async fn quit(
    e: &Env,
    reason: ShutdownReason,
    update: bool,
    extra: Vec<(&str, StepFn)>,
) -> Vec<(&'static str, String)> {
    let core = Arc::new(ShutdownCore::default());
    core.registry
        .register("flush-writebacks", e.tier.flush_step())
        .unwrap();
    for (name, step) in extra {
        core.registry.register(name, step).unwrap();
    }
    let exits = Exits::default();
    let effects = Arc::new(Effects {
        file: e.vault.join("n.md"),
        exits: exits.clone(),
    });
    if update {
        core.set_update_hook(Arc::new(Update(effects.clone())));
    }
    let effects: Arc<dyn ShutdownEffects> = effects;
    core.run(reason, &effects).await;
    exits.lock().unwrap().clone()
}

/// The app menu's Quit, Cmd-Q and the Dock's Quit all start the sequence as a `Quit`, a
/// Windows sign-out or shutdown as a `SessionEnd`, and "restart to update" as a `Quit` that
/// starts the installer before its clean exit. An edit scheduled just before is in the file
/// when the process goes, and when the installer starts.
#[tokio::test(flavor = "multi_thread")]
async fn every_way_the_app_quits_writes_the_scheduled_edit_first() {
    let cases: [(_, _, &[&str]); 3] = [
        (ShutdownReason::Quit, false, &["exit_clean"]),
        (ShutdownReason::SessionEnd, false, &["exit_clean"]),
        (
            ShutdownReason::Quit,
            true,
            &["apply_and_restart", "exit_clean"],
        ),
    ];
    for (reason, update, hows) in cases {
        let (e, identity, id) = one_note();
        e.edit_in_app(&identity.store, &id, "typed in the app");
        e.tier.schedule(&id);
        let exits = quit(&e, reason, update, vec![]).await;
        let want: Vec<_> = hows
            .iter()
            .map(|how| (*how, "typed in the app\n".to_owned()))
            .collect();
        assert_eq!(exits, want, "{reason:?}, update {update}");
    }
}

/// A step before the flush wedges and spends the budget. The edit it schedules just before
/// the budget ends is not due until after it, so only the last chance's flush writes it.
#[tokio::test(flavor = "multi_thread")]
async fn a_step_that_wedges_before_the_flush_leaves_it_the_last_chance() {
    let (e, identity, id) = one_note();
    let wedged: StepFn = {
        let (tier, core, store, id) = (
            e.tier.clone(),
            e.core(),
            identity.store.clone() as Arc<dyn SecureStore>,
            id.clone(),
        );
        Arc::new(move |_, deadline| {
            let (tier, core, store, id) = (tier.clone(), core.clone(), store.clone(), id.clone());
            Box::pin(async move {
                let margin = Duration::from_millis(400);
                tokio::time::sleep(deadline.remaining().saturating_sub(margin)).await;
                tokio::task::spawn_blocking(move || {
                    edit_in_app(&core, &store, &id, "typed in the app");
                    tier.schedule(&id);
                })
                .await
                .unwrap();
                std::future::pending().await
            })
        })
    };
    let exits = quit(
        &e,
        ShutdownReason::SessionEnd,
        false,
        vec![("flush-windows", wedged)],
    )
    .await;
    assert_eq!(exits, vec![("terminate", "typed in the app\n".to_owned())]);
}

/// An edit scheduled after the flush step (a late page of sync, a window's last save) is
/// written by the vault close.
#[tokio::test(flavor = "multi_thread")]
async fn an_edit_scheduled_after_the_flush_is_written_by_the_vault_close() {
    let (e, identity, id) = one_note();
    let late: StepFn = {
        let (tier, core, store, id) = (
            e.tier.clone(),
            e.core(),
            identity.store.clone() as Arc<dyn SecureStore>,
            id.clone(),
        );
        Arc::new(move |_, _| {
            edit_in_app(&core, &store, &id, "typed late");
            tier.schedule(&id);
            Box::pin(async { Ok(()) })
        })
    };
    let close: StepFn = {
        let session = e.session.clone();
        Arc::new(move |_, _| {
            let session = session.clone();
            Box::pin(async move {
                tokio::task::spawn_blocking(move || session.close())
                    .await
                    .map_err(|error| error.to_string())
            })
        })
    };
    let exits = quit(
        &e,
        ShutdownReason::Quit,
        false,
        vec![("stop-schedulers", late), ("close-vault", close)],
    )
    .await;
    assert_eq!(exits, vec![("exit_clean", "typed late\n".to_owned())]);
}

/// An edit scheduled while the vault closes (here while the close waits for the consumer) is
/// written before the close ends.
#[test]
fn an_edit_scheduled_while_the_vault_closes_is_written_before_it_closes() {
    let (e, identity, id) = one_note();
    park_the_consumer(&e, &identity);
    e.edit_in_app(&identity.store, &id, "typed while closing");
    let closing = {
        let session = e.session.clone();
        std::thread::spawn(move || session.close())
    };
    std::thread::sleep(Duration::from_millis(500));
    e.tier.schedule(&id);
    identity.release();
    closing.join().unwrap();
    assert_eq!(e.read("n.md"), "typed while closing\n");
}

/// The pass of an edit is already running, waiting for the lane, when the quit starts: the
/// flush waits for it.
#[tokio::test(flavor = "multi_thread")]
async fn a_pass_running_when_the_quit_starts_is_waited_for() {
    let (e, identity, id) = one_note();
    park_the_consumer(&e, &identity);
    e.edit_in_app(&identity.store, &id, "typed in the app");
    e.tier.schedule(&id);
    std::thread::sleep(DEBOUNCE + Duration::from_millis(300));
    let releasing = {
        let identity = identity.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            identity.release();
        })
    };
    let exits = quit(&e, ShutdownReason::Quit, false, vec![]).await;
    releasing.join().unwrap();
    assert_eq!(exits, vec![("exit_clean", "typed in the app\n".to_owned())]);
}

/// A flush that cannot finish (its pass waits for the lane) gives up at its share of the
/// budget, and the steps behind it still run with the rest.
#[tokio::test(flavor = "multi_thread")]
async fn a_flush_that_cannot_finish_leaves_the_steps_behind_it_their_share() {
    let (e, identity, id) = one_note();
    park_the_consumer(&e, &identity);
    e.edit_in_app(&identity.store, &id, "typed in the app");
    e.tier.schedule(&id);
    let left: Arc<Mutex<Option<Duration>>> = Arc::default();
    let later: StepFn = {
        let left = left.clone();
        Arc::new(move |_, deadline: Deadline| {
            *left.lock().unwrap() = Some(deadline.remaining());
            Box::pin(async { Ok(()) })
        })
    };
    quit(
        &e,
        ShutdownReason::SessionEnd,
        false,
        vec![("close-snapshots", later)],
    )
    .await;
    identity.release();
    let left = left
        .lock()
        .unwrap()
        .expect("the step behind the flush never ran");
    assert!(
        left >= SESSION_END_BUDGET / 2 - Duration::from_millis(300),
        "{left:?} left of {SESSION_END_BUDGET:?}"
    );
}

fn app_changed(id: &str) -> impl Fn(&Applied) -> bool + '_ {
    move |f| matches!(f, Applied::Changed { note_id, source: ChangeSource::App, .. } if note_id == id)
}

/// The app ended before an edit's pass ran (here the edit was never scheduled, as when the
/// process dies inside the debounce): the next open writes the file.
#[test]
fn an_edit_whose_pass_never_ran_reaches_the_file_when_the_vault_opens_again() {
    let (mut e, identity, id) = one_note();
    e.write("ghost.md", "`<!--ghost-->`\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "ghost.md"));
    std::thread::sleep(Duration::from_millis(5));
    e.edit_in_app(&identity.store, &id, "typed before the crash");
    e.close();
    assert_eq!(e.read("n.md"), "first words\n");

    e.open();
    e.facts_until(app_changed(&id));
    assert_eq!(e.read("n.md"), "typed before the crash\n");
    std::thread::sleep(DEBOUNCE + QUIET);
    let later = e.drain();
    assert!(
        !later.iter().any(|f| matches!(
            f,
            Applied::Changed {
                source: ChangeSource::App,
                ..
            }
        )),
        "the open wrote a file the app did not change: {later:?}"
    );
    assert_eq!(e.read("ghost.md"), "`<!--ghost-->`\n");

    // Nothing is behind any more: the next open writes nothing.
    e.close();
    let mtime = std::fs::metadata(e.vault.join("n.md"))
        .unwrap()
        .modified()
        .unwrap();
    e.open();
    e.facts_until(indexed);
    std::thread::sleep(DEBOUNCE + QUIET);
    let again = e.drain();
    assert!(
        !again.iter().any(|f| matches!(
            f,
            Applied::Changed {
                source: ChangeSource::App,
                ..
            }
        )),
        "{again:?}"
    );
    assert_eq!(
        std::fs::metadata(e.vault.join("n.md"))
            .unwrap()
            .modified()
            .unwrap(),
        mtime
    );
}

/// One stamp, one meaning (review M1): the first edit's pass stamps the row before its own
/// write, so the next open's walk reads the file again (its mtime is later) and finds the
/// hash the row has. That read must not move the stamp past the second edit, whose pass the
/// crash cut short, or the reconcile never sees it.
#[test]
fn a_file_read_again_on_open_keeps_an_edit_its_pass_never_wrote_behind() {
    let (mut e, identity, id) = one_note();
    e.edit_in_app(&identity.store, &id, "first pass wrote this");
    e.tier.schedule(&id);
    e.facts_until(app_changed(&id));
    std::thread::sleep(Duration::from_millis(50));
    e.edit_in_app(&identity.store, &id, "typed before the crash");
    e.close();
    e.open();
    e.facts_until(indexed);
    std::thread::sleep(DEBOUNCE + QUIET);
    assert_eq!(e.read("n.md"), "typed before the crash\n");
}
