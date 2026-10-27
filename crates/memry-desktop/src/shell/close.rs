//! Work other steps hang on the closing of the main window, after the renderer flushed and
//! before the window is destroyed (Step 14 (#3531) registers the per-note close snapshots).

use std::sync::{Arc, Mutex, PoisonError};

use super::shutdown::StepFuture;

pub type CloseHook = Arc<dyn Fn() -> StepFuture + Send + Sync>;

#[derive(Default)]
pub struct CloseHooks {
    hooks: Mutex<Vec<(&'static str, CloseHook)>>,
}

impl CloseHooks {
    pub fn register(&self, name: &'static str, hook: CloseHook) {
        self.hooks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((name, hook));
    }

    /// Runs every hook in registration order. A failing hook does not stop the rest; each
    /// failure comes back as `name: message`, so the window can still close and the caller
    /// reports them.
    pub async fn run_all(&self) -> Vec<String> {
        let hooks = self
            .hooks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let mut failures = Vec::new();
        for (name, hook) in hooks {
            if let Err(error) = hook().await {
                failures.push(format!("{name}: {error}"));
            }
        }
        failures
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook(log: &Arc<Mutex<Vec<&'static str>>>, label: &'static str, ok: bool) -> CloseHook {
        let log = log.clone();
        Arc::new(move || {
            let log = log.clone();
            Box::pin(async move {
                log.lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(label);
                if ok { Ok(()) } else { Err("broke".to_owned()) }
            })
        })
    }

    #[tokio::test]
    async fn hooks_run_in_order_and_a_failure_does_not_stop_the_rest() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let hooks = CloseHooks::default();
        hooks.register("first", hook(&log, "first", true));
        hooks.register("second", hook(&log, "second", false));
        hooks.register("third", hook(&log, "third", true));
        let failures = hooks.run_all().await;
        assert_eq!(failures, ["second: broke"]);
        assert_eq!(
            *log.lock().unwrap_or_else(PoisonError::into_inner),
            ["first", "second", "third"]
        );
    }
}
