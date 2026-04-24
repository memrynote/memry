//! IPC command surface exposed to the renderer.
//!
//! At M1 no commands are implemented — the renderer is fed by the JS-side
//! mock router in `src/lib/ipc/mocks/`. M2+ introduces real commands per
//! domain (notes, tasks, crypto, sync, etc.). When a domain's Rust
//! implementation lands, entries are added here and the corresponding
//! mock entry is removed from `src/lib/ipc/invoke.ts`'s realCommands set.

use tauri::Builder;

pub fn register<R: tauri::Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.invoke_handler(tauri::generate_handler![])
}
