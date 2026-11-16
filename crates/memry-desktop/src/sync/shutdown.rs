//! The `stop-sync-runtime` shutdown step: the open vault's pending snapshots go out within
//! [`final_snapshot_push_timeout`] (skipped while an update installs, `runtime.ts`
//! `pushAllSnapshots`), then no status reaches a closing window and the supervisor stops (its
//! running pass aborted) before `close-vault`.

use std::sync::Arc;

use crate::session::Session;
use crate::shell::shutdown::{StepFn, final_snapshot_push_timeout};

pub fn stop_sync_runtime(session: Session) -> StepFn {
    Arc::new(move |ctx, deadline| {
        let session = session.clone();
        Box::pin(async move {
            let budget = final_snapshot_push_timeout(deadline.remaining());
            if !ctx.installing_update
                && !budget.is_zero()
                && let Some(supervisor) = session.sync_supervisor()
            {
                supervisor
                    .final_snapshots(tokio::time::Instant::now() + budget)
                    .await;
            }
            tokio::task::spawn_blocking(move || {
                session.begin_shutdown();
                session.detach_sync();
            })
            .await
            .map_err(|error| format!("stop-sync-runtime: {error}"))
        })
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;
    use crate::registry::{AppConfig, VaultRegistry};
    use crate::session::SupervisorFactory;
    use crate::shell::shutdown::{
        ShutdownContext, ShutdownReason, ShutdownRegistry, run_shutdown_sequence,
    };

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn the_step_detaches_sync_in_a_registry_run() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("app")).unwrap();
        let config = AppConfig::load(dir.path().join("app").join("memry-config.json"));
        let session = Session::new(VaultRegistry::new(Arc::new(config)));
        let built = Arc::new(AtomicUsize::new(0));
        let factory: SupervisorFactory = {
            let built = Arc::clone(&built);
            Arc::new(move |_, _| {
                built.fetch_add(1, Ordering::SeqCst);
                None
            })
        };
        session.attach_sync(factory);

        let steps = ShutdownRegistry::default();
        steps
            .register("stop-sync-runtime", stop_sync_runtime(session.clone()))
            .unwrap();
        let ctx = ShutdownContext {
            installing_update: false,
            reason: ShutdownReason::Quit,
        };
        run_shutdown_sequence(&steps.steps(), ctx, Duration::from_secs(8), &|_| {})
            .await
            .expect("the sequence runs");

        let vault = dir.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        session
            .open(&vault, crate::session::OpenSource::Select)
            .unwrap();
        assert_eq!(
            built.load(Ordering::SeqCst),
            0,
            "after the step no supervisor is built"
        );
        assert!(session.sync_supervisor().is_none());
    }
}
