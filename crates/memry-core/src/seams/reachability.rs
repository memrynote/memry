//! The reachability seam, FR-030.
//!
//! The core drains a queued wave **on the transition**, not on the next timer.
//! Waiting for a timer is how an app that has been offline in a lift for ten
//! minutes takes another thirty seconds to sync after the doors open, and it is
//! what `tests/offline_reconnect.rs` asserts against.

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Reachable {
    /// No usable path. Reads keep working; the outbox parks.
    Offline,
    /// A path the core treats as unmetered.
    Wifi,
    /// A cellular path. A first sync's body window narrows here; nothing else
    /// changes, because a user on cellular still expects their notes.
    Cellular,
}

#[uniffi::export(with_foreign)]
pub trait Reachability: Send + Sync {
    fn current(&self) -> Reachable;
    /// Registers the core's observer. The shell calls it on **every**
    /// transition, including Wifi to Cellular, not only on offline to online.
    fn observe(&self, observer: std::sync::Arc<dyn ReachabilityObserver>);
}

#[uniffi::export(with_foreign)]
pub trait ReachabilityObserver: Send + Sync {
    fn on_change(&self, reachable: Reachable);
}
