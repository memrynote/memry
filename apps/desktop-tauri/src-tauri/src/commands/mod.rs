//! IPC command surface exposed to the renderer.
//!
//! Phase F (M2) introduces the first real feature-domain slice — settings —
//! crossing the boundary via `settings_get` / `settings_set` / `settings_list`.
//! Phase G adds a single shell-neutral wrapper (`notify_flush_done`) so the
//! renderer's quit-flush hook does not 404 through the mock router.
//! Every other domain still serves data through the JS-side mock router in
//! `src/lib/ipc/mocks/`. As each domain's Rust implementation lands, declare
//! its module here and add the command names to the `generate_handler!` macro
//! invocation in `lib.rs::run` plus `realCommands` in
//! `src/lib/ipc/invoke.ts`.

pub mod lifecycle;
pub mod settings;
