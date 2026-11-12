//! Tauri clones and drops tao's `EventLoopWindowTarget` on worker threads: every `AppHandle`,
//! `Webview` and IPC responder carries one inside tauri-runtime-wry's unsafe-`Send` `Context`.
//! On Windows the target holds the event loop's runner. Upstream tao counts it with a non-atomic
//! `Rc`, so concurrent clones and drops lose updates, free the runner under the running loop,
//! and the app dies with 0xC0000005 in `EventLoopRunner::reset_runner` (#3967,
//! tauri-apps/tauri#15408). `crates/Cargo.toml` patches tao to an `Arc`; this test is red,
//! by a crash of the test process, against a tao that counts with `Rc`.
#![cfg(windows)]

use std::sync::Barrier;
use std::thread;

use tao::event_loop::{EventLoopBuilder, EventLoopWindowTarget};
use tao::platform::windows::EventLoopBuilderExtWindows;

/// Moves a clone to a worker as tauri-runtime-wry's `Context` does.
struct OffThread(EventLoopWindowTarget<()>);

// SAFETY: the same promise tauri-runtime-wry makes for its `Context`, the one this test checks:
// the worker only clones and drops the target, never uses the runner it points to.
unsafe impl Send for OffThread {}

const WORKERS: usize = 8;
const ROUNDS: usize = 200_000;

#[test]
fn the_runner_outlives_clones_dropped_on_worker_threads() {
    let event_loop = EventLoopBuilder::<()>::new().with_any_thread(true).build();
    let target: &EventLoopWindowTarget<()> = &event_loop;
    let start = Barrier::new(WORKERS + 1);
    thread::scope(|scope| {
        for _ in 0..WORKERS {
            let held = OffThread(target.clone());
            let start = &start;
            scope.spawn(move || {
                start.wait();
                for _ in 0..ROUNDS {
                    drop(held.0.clone());
                }
                drop(held);
            });
        }
        start.wait();
        for _ in 0..ROUNDS {
            drop(target.clone());
        }
    });

    // A count that lost updates reaches zero under the handles still held: the next clone trips
    // the standard library's check (0xC0000409) or the freed runner corrupts the heap. Dropping
    // the loop takes the last handle.
    drop(target.clone());
    drop(event_loop);
}
