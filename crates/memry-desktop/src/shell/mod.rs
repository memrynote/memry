//! Pure shell decisions (window bounds, caption hit tests, navigation input). This module never
//! depends on `tauri`; the adapters in `apps/desktop-tauri/src-tauri` apply them.

pub mod bounds;
pub mod caption;
pub mod close;
pub mod flush;
pub mod heartbeat;
pub mod nav_input;
pub mod shutdown;
