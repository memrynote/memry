//! Telemetry: the same event schema, opt-out and crash-marker behavior as the Electron app
//! (`apps/desktop/src/main/telemetry`). `telemetry.json` keeps the install id and opt-out flags,
//! a crash-durable journal keeps queued events, and every request goes through `http::client`.

pub mod config;
pub mod crash;
pub mod diagnostics;
pub mod events;
pub mod journal;
pub mod main_warning;
pub mod service;
pub mod time;

pub use config::TelemetryConfig;
pub use crash::{CrashMarker, CrashReport};
pub use events::{TelemetryEvent, sanitize_dimensions, sanitize_failure};
pub use service::{Context, FlushReason, FlushResult, Sender, Service};
