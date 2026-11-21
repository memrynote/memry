//! Startup work the first frame does not depend on, run once the main window is on screen
//! (`apps/desktop/src/main/post-reveal.ts`). The reveal arms the drain; the queue runs
//! `POST_REVEAL_DELAY_MS` later, so it does not compete with the renderer's own boot calls.

use std::collections::HashSet;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// The reveal means the page can paint, not that it finished booting: its IPC round trips keep
/// the app busy for a few hundred milliseconds more (`post-reveal.ts:15-19`).
pub const POST_REVEAL_DELAY_MS: u64 = 1_000;

type Task = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct State {
    queue: Vec<(String, Task)>,
    started: HashSet<String>,
    scheduled: bool,
    drained: bool,
}

/// The queue. The app uses the one behind [`once_window_shown`] and [`on_window_shown`].
#[derive(Default)]
pub struct PostReveal {
    state: Mutex<State>,
}

impl PostReveal {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `task` once the drain has run, at once when it already has. `name` is the
    /// at-most-once key: a name that started never runs again, and registering a queued name
    /// again replaces its task in its place (`post-reveal.ts:53`, a `Map.set`).
    pub fn register(&self, name: &str, task: impl FnOnce() + Send + 'static) {
        let mut state = self.lock();
        if state.started.contains(name) {
            return;
        }
        // Behind a task the drain has not started yet, a registration queues: running it here
        // would start it ahead of tasks registered before it.
        if state.drained && state.queue.is_empty() {
            state.started.insert(name.to_owned());
            drop(state);
            run(name, Box::new(task));
            return;
        }
        match state.queue.iter_mut().find(|(queued, _)| queued == name) {
            Some(slot) => slot.1 = Box::new(task),
            None => state.queue.push((name.to_owned(), Box::new(task))),
        }
    }

    /// Arms the drain: it runs after `delay` unless `shutting_down` is true by then. Repeat
    /// calls are no-ops. A shutdown inside the delay leaves the queue undrained for good, so
    /// nothing registered later starts either (`post-reveal.ts:61-64`).
    pub fn schedule(
        self: &Arc<Self>,
        delay: impl Future<Output = ()> + Send + 'static,
        shutting_down: impl FnOnce() -> bool + Send + 'static,
    ) {
        {
            let mut state = self.lock();
            if state.scheduled {
                return;
            }
            state.scheduled = true;
        }
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            delay.await;
            if shutting_down() {
                return;
            }
            this.drain();
        });
    }

    /// Starts the queued tasks in registration order. Each leaves the queue only when it
    /// starts, so `register` sees whether any task is still waiting.
    fn drain(&self) {
        self.lock().drained = true;
        loop {
            let (name, task) = {
                let mut state = self.lock();
                if state.queue.is_empty() {
                    return;
                }
                let (name, task) = state.queue.remove(0);
                state.started.insert(name.clone());
                (name, task)
            };
            run(&name, task);
        }
    }
}

/// A panicking task logs and never stops the tasks after it.
fn run(name: &str, task: Task) {
    if catch_unwind(AssertUnwindSafe(task)).is_err() {
        tracing::warn!(scope = "Startup", "deferred startup task failed: {name}");
    }
}

fn global() -> &'static Arc<PostReveal> {
    static QUEUE: LazyLock<Arc<PostReveal>> = LazyLock::new(Arc::default);
    &QUEUE
}

/// Registers startup work to run once the main window is visible. The task starts work and
/// returns; it runs on the async runtime, or on the caller's thread once the drain has run.
pub fn once_window_shown(name: &str, task: impl FnOnce() + Send + 'static) {
    global().register(name, task);
}

/// Called by the reveal: drains the queue `POST_REVEAL_DELAY_MS` later.
pub fn on_window_shown() {
    // The timer is built inside the spawned task: the reveal runs on the event loop thread,
    // outside the tokio runtime, where `tokio::time::sleep` panics.
    global().schedule(
        async { tokio::time::sleep(Duration::from_millis(POST_REVEAL_DELAY_MS)).await },
        crate::startup::shutdown_started,
    );
}
