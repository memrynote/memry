//! The reachability seam, FR-030.
//!
//! A queued wave must drain **on the transition**, not on the next timer.
//! Waiting for a timer is how an app that has been offline in a lift for ten
//! minutes takes another thirty seconds to sync after the doors open.
//!
//! **The core does not drive that today, and this doc used to say it did.**
//! [`Reachability::observe`] has no caller anywhere in the crate: the engine
//! reads [`Reachability::current`] at the top of each pass and nothing ever
//! registers a [`ReachabilityObserver`]. Deciding *when* to run a pass is the
//! shell's, exactly as [`crate::seams`]' hint sink pushes that decision out —
//! so "drains on the transition" is an obligation on the shell wiring
//! `observe`, not a guarantee the core currently meets.
//!
//! What the core does guarantee, and what `tests/offline_reconnect.rs`
//! actually asserts, is the half that makes the shell's job possible: an
//! offline pass makes **no request and removes no row**, and leaves every
//! queued row at `attempt_count` 0 with no backoff — so the shell's first
//! callback after the transition drains the whole wave at once rather than
//! walking a backoff ladder it did not earn.
//!
//! A shell that never calls `observe` still syncs, on its own timer, with the
//! lift delay above. That is the cost, and it is the shell's to pay or avoid.

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
