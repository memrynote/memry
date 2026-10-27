//! Pure shell decisions (window bounds, and the later menu, scheme and permission rules). This
//! module never depends on `tauri`; the adapters in `apps/desktop-tauri/src-tauri` apply them.

pub mod bounds;
pub mod close;
pub mod crash_dumps;
pub mod deep_link;
pub mod flush;
pub mod gpu_guard;
pub mod heartbeat;
pub mod install_layout;
pub mod notifications;
pub mod shutdown;
pub mod stall;
pub mod tray;
