//! Prints what `DesktopReachability` reports, with the time since start: the first state, then
//! every change. For the interface-toggle check on each OS (turn the network off and on while it
//! runs; each change prints once, about 2 s after the OS reports it).
//!
//! `cargo run -p memry-desktop --example reachability_watch [-- <seconds>]` (default 60)

use std::sync::Arc;
use std::time::{Duration, Instant};

use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_desktop::seams::reachability::DesktopReachability;

struct Print(Instant);

impl ReachabilityObserver for Print {
    fn on_change(&self, reachable: Reachable) {
        println!("{:>7.2}s  {reachable:?}", self.0.elapsed().as_secs_f64());
    }
}

#[tokio::main]
async fn main() {
    let seconds = std::env::args()
        .nth(1)
        .and_then(|arg| arg.parse().ok())
        .unwrap_or(60);
    let start = Instant::now();
    let reachability = DesktopReachability::start(&tokio::runtime::Handle::current());
    tokio::time::sleep(Duration::from_millis(500)).await;
    println!(
        "{:>7.2}s  {:?} (start)",
        start.elapsed().as_secs_f64(),
        reachability.current()
    );
    reachability.observe(Arc::new(Print(start)));
    tokio::time::sleep(Duration::from_secs(seconds)).await;
}
