//! The background-execution seam, FR-028 and research R5.
//!
//! iOS decides when a background task runs and how long it lasts, and it warns
//! shortly before it kills one. The core cannot observe either, so both cross
//! this seam — and `on_expiring` is the important half: a sync pass that is
//! killed mid-write must have already committed whatever it acknowledged
//! (data-model §D.6).

use crate::api::errors::BackgroundError;

#[uniffi::export(with_foreign)]
pub trait BackgroundExec: Send + Sync {
    /// Asks the platform to schedule a refresh no sooner than `earliest_ms`
    /// from now. A request, not a guarantee: iOS may run it later, or never.
    fn schedule_refresh(&self, earliest_ms: u64) -> Result<(), BackgroundError>;

    fn cancel_refresh(&self) -> Result<(), BackgroundError>;

    /// Begins a bounded task and returns its handle, so the core can finish a
    /// durable write rather than being suspended halfway through one.
    fn begin_task(&self, name: String) -> Result<String, BackgroundError>;

    fn end_task(&self, handle: String);
}

/// The core's side of the same seam: what the shell calls when the platform
/// tells it something changed.
///
/// `on_foreground` debounces deliberately. tokio's timers fire **late and all at
/// once** after a suspension, so a resume that let every pending timer run
/// immediately would launch several sync passes into the same cursor
/// (research R5).
#[uniffi::export(with_foreign)]
pub trait LifecycleObserver: Send + Sync {
    fn on_background(&self);
    fn on_foreground(&self);
    /// The platform is about to kill the current background task.
    fn on_expiring(&self);
}
