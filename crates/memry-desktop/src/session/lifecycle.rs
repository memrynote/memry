use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use super::fixture::*;
use super::projection::{CancelToken, ProjectionEvent};

#[test]
fn lifecycle_open_lays_out_core_and_registers_the_vault() {
    let f = fixture();
    let vault = f.vault("Notes");
    let rx = f.session.subscribe();
    let opened = f.session.open(&vault, OpenSource::Select).expect("open");

    assert!(data_db(&vault).is_file());
    assert!(vault.join(".memry/core/index.db").is_file());
    assert_eq!(
        f.session.status().path.as_deref(),
        Some(&*vault.to_string_lossy())
    );
    assert_eq!(opened.stored.clone().expect("registered").name, "Notes");
    assert_eq!(
        f.session.registry().current().as_deref(),
        Some(&*vault.to_string_lossy())
    );
    let events = drain(&rx);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, SessionEvent::IndexRecovered { .. })),
        "a new index is reported"
    );
    drop(opened);
    f.session.close();
    let rx = f.session.subscribe();
    f.session.open(&vault, OpenSource::Select).expect("reopen");
    assert!(
        !drain(&rx)
            .iter()
            .any(|e| matches!(e, SessionEvent::IndexRecovered { .. }))
    );
}

#[test]
fn lifecycle_hooks_run_in_stage_order_is_open_is_true_before_sync_and_a_failing_hook_keeps_the_vault()
 {
    let f = fixture();
    let log = Arc::new(Mutex::new(Vec::<String>::new()));
    let add = |name: &'static str, stage: OpenStage, fail: bool| {
        let (log, session) = (log.clone(), f.session.clone());
        f.session.on_open(
            name,
            stage,
            Arc::new(move |_| {
                lock(&log).push(format!("{name}:{}", session.status().is_open));
                if fail { Err("boom".into()) } else { Ok(()) }
            }),
        );
    };
    // Registered out of order.
    add("sync", OpenStage::SyncStart, false);
    add("defaults", OpenStage::Defaults, true);
    add("settings", OpenStage::Settings, false);
    add("watcher", OpenStage::Watcher, false);
    let vault = f.vault("v");
    f.session.open(&vault, OpenSource::Select).expect("open");
    assert_eq!(
        *lock(&log),
        [
            "settings:false",
            "watcher:false",
            "defaults:false",
            "sync:true"
        ]
    );
    assert!(
        f.session.status().is_open,
        "the failing hook did not close the vault"
    );
    f.session.close();
}

#[test]
fn lifecycle_close_hooks_run_in_reverse_and_the_vault_drops_after_the_last_one() {
    let f = fixture();
    let order = Arc::new(Mutex::new(Vec::<&str>::new()));
    let weak = Arc::new(Mutex::new(None::<Weak<Vault>>));
    for name in ["first", "second", "third"] {
        let (order, weak) = (order.clone(), weak.clone());
        f.session.on_close(
            name,
            Arc::new(move |view| {
                lock(&order).push(name);
                let mut slot = lock(&weak);
                let alive = slot.get_or_insert_with(|| Arc::downgrade(&view.vault));
                assert!(
                    alive.upgrade().is_some(),
                    "the vault is alive during {name}"
                );
            }),
        );
    }
    f.session
        .open(&f.vault("v"), OpenSource::Select)
        .expect("open");
    f.session.close();
    assert_eq!(*lock(&order), ["third", "second", "first"]);
    let weak = lock(&weak).take().expect("a hook ran");
    assert!(weak.upgrade().is_none(), "dropped once the hooks returned");
}

#[test]
fn lifecycle_after_begin_shutdown_no_status_event_is_emitted() {
    let f = fixture();
    f.session
        .open(&f.vault("v"), OpenSource::Select)
        .expect("open");
    let rx = f.session.subscribe();
    f.session.begin_shutdown();
    f.session.close();
    assert!(statuses(&drain(&rx)).is_empty());
}

#[test]
fn lifecycle_a_close_hook_past_its_deadline_blocks_a_reopen_and_repair_until_it_lets_go() {
    let f = fixture_with(Duration::from_millis(100));
    let release = Arc::new(AtomicBool::new(false));
    let flag = release.clone();
    f.session.on_close(
        "stuck",
        Arc::new(move |view| {
            let _held = view.vault.clone();
            while !flag.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
        }),
    );
    let vault = f.vault("v");
    f.session.open(&vault, OpenSource::Select).expect("open");
    let started = Instant::now();
    f.session.close();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "close did not wait for the hook"
    );
    assert!(matches!(
        f.session.open(&vault, OpenSource::Select),
        Err(SessionError::Held(_))
    ));
    assert!(matches!(
        f.session.repair(&vault),
        Err(SessionError::Held(_))
    ));
    // Another vault is unaffected.
    let other = f.vault("other");
    f.session
        .open(&other, OpenSource::Select)
        .expect("another vault opens");
    f.session.close();
    release.store(true, Ordering::SeqCst);
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        match f.session.open(&vault, OpenSource::Select) {
            Ok(_) => break,
            Err(SessionError::Held(_)) if Instant::now() < end => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(other) => panic!("unexpected {other}"),
        }
    }
}

#[test]
fn startup_opens_the_current_vault_and_keeps_it_when_the_failure_may_be_transient() {
    let f = fixture();
    let vault = f.vault("v");
    f.session.open(&vault, OpenSource::Select).expect("open");
    f.session.close();
    let env = crate::launch_env::LaunchEnv::default();
    assert!(matches!(
        f.session.open_startup(&env),
        StartupOutcome::Opened(_)
    ));
    f.session.close();
    // A regular file where `.memry/core` must go: an I/O failure, not a verdict on the vault.
    std::fs::remove_dir_all(vault.join(".memry/core")).expect("rm");
    std::fs::write(vault.join(".memry/core"), b"x").expect("block");
    assert!(matches!(
        f.session.open_startup(&env),
        StartupOutcome::Failed { .. }
    ));
    assert_eq!(
        f.session.registry().current().as_deref(),
        Some(&*vault.to_string_lossy())
    );
}

#[test]
fn startup_forgets_a_vault_that_can_never_open() {
    let f = fixture();
    let vault = f.vault("v");
    f.session.open(&vault, OpenSource::Select).expect("open");
    f.session.close();
    // An Electron-shaped database where the core's belongs.
    std::fs::remove_file(vault.join(".memry/core/data.db")).expect("rm");
    let conn = rusqlite::Connection::open(vault.join(".memry/core/data.db")).expect("db");
    conn.execute_batch("CREATE TABLE __drizzle_migrations (id INTEGER)")
        .expect("seed");
    drop(conn);
    let env = crate::launch_env::LaunchEnv::default();
    assert!(matches!(
        f.session.open_startup(&env),
        StartupOutcome::Failed { .. }
    ));
    assert_eq!(f.session.registry().current(), None);
}

#[test]
fn registered_projectors_run_on_the_open_vault_and_stop_with_it() {
    struct Counting(AtomicUsize, AtomicUsize);
    impl Projector for Counting {
        fn name(&self) -> &str {
            "counting"
        }
        fn handles(&self, _: &ProjectionEvent) -> bool {
            true
        }
        fn project(&self, _: &ProjectionEvent) -> Result<(), String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn rebuild(&self) -> Result<(), String> {
            Ok(())
        }
        fn reconcile(&self, _: &CancelToken) -> Result<(), String> {
            self.1.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    let f = fixture();
    let projector = Arc::new(Counting(AtomicUsize::new(0), AtomicUsize::new(0)));
    f.session.register_projector(projector.clone());
    f.session
        .open(&f.vault("v"), OpenSource::Select)
        .expect("open");
    let runtime = f.session.projections().expect("runtime");
    runtime.publish(ProjectionEvent::TaskUpserted {
        task_id: "t".into(),
    });
    assert!(runtime.flush(Duration::from_secs(5)));
    assert_eq!(projector.0.load(Ordering::SeqCst), 1);
    let end = Instant::now() + Duration::from_secs(5);
    while projector.1.load(Ordering::SeqCst) == 0 && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        projector.1.load(Ordering::SeqCst),
        1,
        "one reconcile pass on open"
    );
    f.session.close();
    assert_eq!(runtime.live_threads(), 0);
    assert!(f.session.projections().is_none());
}

#[test]
fn create_registers_a_new_vault_and_refuses_bad_or_taken_names() {
    let f = fixture();
    let rx = f.session.subscribe();
    let made = f.session.create(f.dir.path(), "Fresh").expect("create");
    assert!(made.vault.path.ends_with("Fresh"));
    assert!(
        drain(&rx)
            .iter()
            .any(|e| matches!(e, SessionEvent::Created { .. }))
    );
    let taken = f.session.create(f.dir.path(), "Fresh");
    assert!(matches!(
        taken,
        Err(CreateOrOpenError::Create(CreateError::AlreadyExists))
    ));
    let bad = f.session.create(f.dir.path(), ".hidden");
    assert!(matches!(
        bad,
        Err(CreateOrOpenError::Create(CreateError::InvalidName))
    ));
}

#[test]
fn remove_closes_the_open_vault_forgets_it_and_keeps_the_folder() {
    let f = fixture();
    let vault = f.vault("v");
    f.session.open(&vault, OpenSource::Select).expect("open");
    f.session.remove(&vault.to_string_lossy()).expect("remove");
    assert!(!f.session.status().is_open);
    assert_eq!(f.session.registry().current(), None);
    assert!(f.session.registry().get(&vault.to_string_lossy()).is_none());
    assert!(data_db(&vault).is_file());
}
