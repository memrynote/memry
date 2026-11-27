//! Developer tasks for the desktop app, run as `cargo xtask <task>` from `crates/`.
//!
//! - `seed bench`: the benchmark vault ([`seed`], [`bulk_notes`]).
//! - `measure-memory`: the idle memory of the app and its web view processes ([`measure_memory`]).

pub mod bulk_notes;
pub mod measure_memory;
pub mod seed;
pub mod seed_template;
