//! Pure shell decisions (window bounds, caption hit tests, navigation input). This module never
//! depends on `tauri`; the adapters in `apps/desktop-tauri/src-tauri` apply them.

pub mod accelerator;
pub mod autostart;
pub mod bounds;
pub mod caption;
pub mod close;
pub mod crash_dumps;
pub mod deep_link;
pub mod drop_stage;
pub mod external;
pub mod file_open;
pub mod file_serve;
pub mod file_service;
pub mod flush;
pub mod frame_nav;
pub mod gpu_guard;
pub mod heartbeat;
pub mod install_layout;
pub mod local_scheme;
pub mod loopback;
pub mod loopback_route;
pub mod menu_spec;
pub mod menu_table;
#[path = "menu_table.generated.rs"]
pub mod menu_table_generated;
pub mod nav_input;
pub mod notifications;
pub mod permissions;
pub mod power;
pub mod shortcut;
pub mod shutdown;
pub mod spell;
pub mod stall;
pub mod tray;
pub mod tray_host;
