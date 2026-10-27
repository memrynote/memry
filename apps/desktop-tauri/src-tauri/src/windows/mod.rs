//! Windows of the app: the registry that names them, the main window and its bounds, the one
//! window-event dispatcher, first-paint reveal and zoom.

pub mod bounds_store;
pub mod chrome;
pub mod events;
pub mod main_window;
pub mod nav_input;
pub mod registry;
pub mod reveal;
pub mod scripts;
#[cfg(windows)]
pub mod win32_caption;
pub mod zoom;

pub use main_window::create_main;

pub const MAIN_LABEL: &str = "main";
