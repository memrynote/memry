use std::sync::atomic::{AtomicBool, Ordering};

use super::*;

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<String>>,
}

impl Recorder {
    fn push(&self, event: impl Into<String>) {
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(event.into());
    }
    fn events(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
    fn has(&self, event: &str) -> bool {
        self.events().iter().any(|e| e == event)
    }
}

struct FakeEffects(Arc<Recorder>);

impl ShutdownEffects for FakeEffects {
    fn step_started(&self, step: &str) {
        self.0.push(format!("start:{step}"));
    }
    fn mark_failure(&self, failure: ShutdownFailure, step: Option<&str>) {
        self.0
            .push(format!("failure:{failure:?}:{}", step.unwrap_or("-")));
    }
    fn clear_marker(&self) {
        self.0.push("clear");
    }
    fn exit_clean(&self) {
        self.0.push("exit_clean");
    }
    fn terminate(&self) {
        self.0.push("terminate");
    }
}

struct FakeHook {
    install: AtomicBool,
    log: Arc<Recorder>,
}

impl UpdateApplyHook for FakeHook {
    fn disable_install_on_quit(&self) {
        self.log.push("hook:disable");
    }
    fn enable_install_on_quit(&self) {
        self.log.push("hook:enable");
    }
    fn install_requested(&self) -> bool {
        self.install.load(Ordering::SeqCst)
    }
    fn apply_and_restart(&self) {
        self.log.push("hook:apply_and_restart");
    }
    fn apply_on_quit(&self) {
        self.log.push("hook:apply_on_quit");
    }
}

fn setup() -> (Arc<ShutdownCore>, Arc<Recorder>, Arc<dyn ShutdownEffects>) {
    let log = Arc::new(Recorder::default());
    let effects: Arc<dyn ShutdownEffects> = Arc::new(FakeEffects(log.clone()));
    (Arc::new(ShutdownCore::default()), log, effects)
}

fn records(log: &Arc<Recorder>, label: &'static str) -> StepFn {
    let log = log.clone();
    Arc::new(move |_, _| {
        let log = log.clone();
        Box::pin(async move {
            log.push(format!("ran:{label}"));
            Ok(())
        })
    })
}

fn hangs() -> StepFn {
    Arc::new(|_, _| Box::pin(std::future::pending()))
}

fn fails(message: &'static str) -> StepFn {
    Arc::new(move |_, _| Box::pin(async move { Err(message.to_owned()) }))
}

#[test]
fn constants_and_step_order_are_the_contract() {
    assert_eq!(BUDGET, Duration::from_millis(8000));
    assert_eq!(HARD_BACKSTOP, Duration::from_millis(10_000));
    assert_eq!(LAST_CHANCE, Duration::from_millis(1500));
    assert_eq!(FINAL_SNAPSHOT_PUSH, Duration::from_millis(2000));
    assert_eq!(CLOSE_VAULT_RESERVE, Duration::from_millis(2000));
    assert_eq!(TELEMETRY_FLUSH, Duration::from_millis(1000));
    assert_eq!(DATABASE_CLOSE_RESERVE, Duration::from_millis(1000));
    assert_eq!(WRITEBACK_FLUSH, Duration::from_millis(2000));
    assert_eq!(
        LAST_CHANCE_STEPS,
        ["flush-activity-log", "flush-writebacks"]
    );
    assert_eq!(
        ShutdownReason::SessionEnd.budget(),
        Duration::from_millis(4000)
    );
    assert_eq!(ShutdownReason::Quit.budget(), BUDGET);
    assert_eq!(
        STEP_ORDER,
        [
            "flush-windows",
            "flush-writebacks",
            "flush-activity-log",
            "close-snapshots",
            "stop-schedulers",
            "stop-capture-server",
            "stop-chat-server",
            "stop-utility-processes",
            "stop-sync-runtime",
            "close-vault",
            "flush-telemetry",
        ]
    );
}

#[test]
fn every_step_name_is_a_valid_crash_marker_token() {
    for name in STEP_ORDER {
        let b = name.as_bytes();
        assert!(b.len() <= 40 && b[0].is_ascii_lowercase(), "{name}");
        assert!(
            b.iter()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        );
    }
}

#[test]
fn deadline_arithmetic_leaves_room_for_the_steps_behind() {
    let ms = Duration::from_millis;
    assert_eq!(final_snapshot_push_timeout(ms(8000)), ms(2000));
    assert_eq!(final_snapshot_push_timeout(ms(3000)), ms(1000));
    assert_eq!(final_snapshot_push_timeout(ms(2000)), ms(0));
    assert_eq!(final_snapshot_push_timeout(ms(500)), ms(0));
    assert_eq!(close_vault_drain_timeout(ms(8000)), ms(5000));
    assert_eq!(close_vault_drain_timeout(ms(3500)), ms(2500));
    assert_eq!(close_vault_drain_timeout(ms(1000)), ms(0));
    assert_eq!(writeback_flush_timeout(ms(8000)), ms(2000));
    assert_eq!(writeback_flush_timeout(ms(3000)), ms(1500));
    assert_eq!(writeback_flush_timeout(LAST_CHANCE), ms(750));
    assert_eq!(writeback_flush_timeout(ms(0)), ms(0));
    // A session-end flush that takes its whole share leaves the final push nothing.
    let after_flush = SESSION_END_BUDGET - writeback_flush_timeout(SESSION_END_BUDGET);
    assert_eq!(final_snapshot_push_timeout(after_flush), ms(0));
}

#[tokio::test(start_paused = true)]
async fn a_cap_never_outlives_the_deadline() {
    let deadline = Deadline::after(Duration::from_millis(1000));
    assert_eq!(
        deadline.cap(Duration::from_millis(400)),
        Duration::from_millis(400)
    );
    tokio::time::advance(Duration::from_millis(800)).await;
    assert_eq!(
        deadline.cap(Duration::from_millis(400)),
        Duration::from_millis(200)
    );
    tokio::time::advance(Duration::from_millis(900)).await;
    assert_eq!(deadline.remaining(), Duration::ZERO);
}

#[test]
fn an_unknown_step_name_is_refused() {
    let (core, log, _) = setup();
    assert!(
        core.registry
            .register("stop-everything", records(&log, "x"))
            .is_err()
    );
    assert!(
        core.registry
            .register("close-vault", records(&log, "x"))
            .is_ok()
    );
}

#[tokio::test]
async fn steps_run_in_step_order_whatever_the_registration_order() {
    let (core, log, effects) = setup();
    for name in [
        "flush-telemetry",
        "close-vault",
        "flush-windows",
        "stop-schedulers",
    ] {
        core.registry.register(name, records(&log, name)).unwrap();
    }
    core.run(ShutdownReason::Quit, &effects).await;
    let ran: Vec<_> = log
        .events()
        .into_iter()
        .filter(|e| e.starts_with("start:"))
        .collect();
    assert_eq!(
        ran,
        [
            "start:flush-windows",
            "start:stop-schedulers",
            "start:close-vault",
            "start:flush-telemetry"
        ]
    );
}

#[tokio::test]
async fn owners_sharing_a_step_name_all_run_even_when_one_fails() {
    let (core, log, effects) = setup();
    core.registry
        .register("stop-schedulers", records(&log, "a"))
        .unwrap();
    core.registry
        .register("stop-schedulers", fails("boom"))
        .unwrap();
    core.registry
        .register("stop-schedulers", records(&log, "b"))
        .unwrap();
    core.run(ShutdownReason::Quit, &effects).await;
    assert!(log.has("ran:a") && log.has("ran:b"));
    assert!(log.has("failure:CleanupError:-"));
}

#[tokio::test]
async fn a_clean_quit_clears_the_marker_and_exits_without_failure() {
    let (core, log, effects) = setup();
    core.registry
        .register("close-vault", records(&log, "close"))
        .unwrap();
    core.run(ShutdownReason::Quit, &effects).await;
    let events = log.events();
    assert_eq!(events.last().map(String::as_str), Some("exit_clean"));
    assert!(log.has("clear"));
    assert!(
        !events
            .iter()
            .any(|e| e.starts_with("failure") || e == "terminate")
    );
}

#[tokio::test]
async fn a_quit_with_no_work_finishes_well_under_300_ms() {
    let (core, _log, effects) = setup();
    let started = std::time::Instant::now();
    core.run(ShutdownReason::Quit, &effects).await;
    assert!(started.elapsed() < Duration::from_millis(300));
}

#[tokio::test(start_paused = true)]
async fn a_hung_step_is_named_and_the_process_is_forced_out() {
    let (core, log, effects) = setup();
    core.registry
        .register("flush-writebacks", records(&log, "writebacks"))
        .unwrap();
    core.registry
        .register("stop-sync-runtime", hangs())
        .unwrap();
    core.registry
        .register("close-vault", records(&log, "close"))
        .unwrap();
    core.run(ShutdownReason::Quit, &effects).await;
    let events = log.events();
    assert!(log.has("failure:Timeout:stop-sync-runtime"));
    assert_eq!(events.last().map(String::as_str), Some("terminate"));
    assert!(!log.has("clear") && !log.has("exit_clean"));
    // Durable work still runs after the budget: write-backs, then the vault the wedge sat before.
    let after_failure = events
        .iter()
        .position(|e| e.starts_with("failure"))
        .unwrap();
    let tail = &events[after_failure..];
    assert!(tail.contains(&"ran:writebacks".to_owned()));
    assert!(tail.contains(&"ran:close".to_owned()));
}

#[tokio::test(start_paused = true)]
async fn the_step_after_a_spent_budget_never_starts() {
    let (core, log, effects) = setup();
    core.registry.register("flush-windows", hangs()).unwrap();
    core.registry
        .register("stop-schedulers", records(&log, "late"))
        .unwrap();
    core.run(ShutdownReason::Quit, &effects).await;
    assert!(!log.has("start:stop-schedulers"));
    assert!(log.has("failure:Timeout:flush-windows"));
}

#[tokio::test(start_paused = true)]
async fn a_wedged_close_vault_is_not_closed_a_second_time() {
    let (core, log, effects) = setup();
    core.registry.register("close-vault", hangs()).unwrap();
    core.run(ShutdownReason::Quit, &effects).await;
    assert!(log.has("failure:Timeout:close-vault"));
    assert_eq!(
        log.events()
            .iter()
            .filter(|e| *e == "start:close-vault")
            .count(),
        1
    );
}

#[tokio::test(start_paused = true)]
async fn the_last_chance_flush_is_itself_bounded() {
    let (core, log, effects) = setup();
    core.registry.register("flush-windows", hangs()).unwrap();
    core.registry.register("flush-writebacks", hangs()).unwrap();
    core.run(ShutdownReason::Quit, &effects).await;
    assert_eq!(log.events().last().map(String::as_str), Some("terminate"));
}

/// The activity log's flush is a few appended lines; the write-back's passes are not, so they
/// run second and cannot starve it.
#[tokio::test(start_paused = true)]
async fn the_last_chance_flushes_the_activity_log_before_the_write_back() {
    let (core, log, effects) = setup();
    core.registry
        .register("flush-windows", fails("renderer gone"))
        .unwrap();
    core.registry.register("flush-writebacks", hangs()).unwrap();
    core.registry
        .register("flush-activity-log", records(&log, "activity"))
        .unwrap();
    core.run(ShutdownReason::Quit, &effects).await;
    assert!(log.has("ran:activity"));
    assert_eq!(log.events().last().map(String::as_str), Some("terminate"));
}

#[tokio::test]
async fn a_failing_step_marks_cleanup_failure_and_still_runs_the_durable_flushes() {
    let (core, log, effects) = setup();
    core.registry
        .register("flush-windows", fails("renderer gone"))
        .unwrap();
    core.registry
        .register("flush-writebacks", records(&log, "writebacks"))
        .unwrap();
    core.run(ShutdownReason::Quit, &effects).await;
    assert!(log.has("failure:CleanupError:-"));
    assert!(log.has("ran:writebacks"));
    assert_eq!(log.events().last().map(String::as_str), Some("terminate"));
}

#[tokio::test]
async fn a_pending_install_replaces_the_exit_on_a_clean_quit() {
    let (core, log, effects) = setup();
    core.set_update_hook(Arc::new(FakeHook {
        install: AtomicBool::new(true),
        log: log.clone(),
    }));
    core.run(ShutdownReason::Quit, &effects).await;
    assert!(log.has("clear") && log.has("hook:apply_and_restart"));
    assert!(!log.has("exit_clean"));
}

#[tokio::test(start_paused = true)]
async fn a_pending_install_survives_a_forced_exit() {
    let (core, log, effects) = setup();
    core.set_update_hook(Arc::new(FakeHook {
        install: AtomicBool::new(true),
        log: log.clone(),
    }));
    core.registry
        .register("stop-sync-runtime", hangs())
        .unwrap();
    core.run(ShutdownReason::Quit, &effects).await;
    assert!(log.has("hook:apply_and_restart"));
    assert!(!log.has("terminate"));
}

#[tokio::test]
async fn steps_learn_that_an_update_is_installing() {
    let (core, log, effects) = setup();
    core.set_update_hook(Arc::new(FakeHook {
        install: AtomicBool::new(true),
        log: log.clone(),
    }));
    let seen = log.clone();
    core.registry
        .register(
            "stop-sync-runtime",
            Arc::new(move |ctx, _| {
                let seen = seen.clone();
                Box::pin(async move {
                    seen.push(format!("installing:{}", ctx.installing_update));
                    Ok(())
                })
            }),
        )
        .unwrap();
    core.run(ShutdownReason::Quit, &effects).await;
    assert!(log.has("installing:true"));
}

#[test]
fn the_hard_backstop_records_the_timeout_and_ends_the_process_without_the_runtime() {
    let (core, log, effects) = setup();
    core.arm_backstop(Duration::from_millis(30), effects);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !log.has("terminate") && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(log.events(), ["failure:Timeout:-", "terminate"]);
}

#[tokio::test]
async fn a_finished_quit_disarms_the_backstop() {
    let (core, log, effects) = setup();
    core.arm_backstop(Duration::from_millis(150), effects.clone());
    core.run(ShutdownReason::Quit, &effects).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(!log.has("terminate"));
    assert!(!log.events().iter().any(|e| e.starts_with("failure")));
}

#[tokio::test]
async fn the_sequence_reports_each_step_start_before_it_runs() {
    let (core, log, effects) = setup();
    let order = log.clone();
    core.registry
        .register(
            "close-vault",
            Arc::new(move |_, _| {
                let order = order.clone();
                Box::pin(async move {
                    order.push("ran");
                    Ok(())
                })
            }),
        )
        .unwrap();
    core.run(ShutdownReason::Quit, &effects).await;
    let events = log.events();
    let start = events
        .iter()
        .position(|e| e == "start:close-vault")
        .unwrap();
    let ran = events.iter().position(|e| e == "ran").unwrap();
    assert!(start < ran);
}

#[test]
fn an_exit_request_right_after_the_last_window_closed_is_the_window_systems() {
    let now = std::time::Instant::now();
    assert!(is_implicit_exit(Some(now)));
    assert!(!is_implicit_exit(None));
    let long_ago = now.checked_sub(IMPLICIT_EXIT_WINDOW * 2).expect("instant");
    assert!(!is_implicit_exit(Some(long_ago)));
}
