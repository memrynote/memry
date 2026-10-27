//! Pure shell decisions (window bounds, and the later menu, scheme and permission rules). This
//! module never depends on `tauri`; the adapters in `apps/desktop-tauri/src-tauri` apply them.

pub mod bounds;
pub mod heartbeat;
