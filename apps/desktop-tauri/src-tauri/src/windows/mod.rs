//! Windows of the app: the registry that names them, the main window and its bounds, the one
//! window-event dispatcher, first-paint reveal, zoom, the preboot and startup-error windows, and
//! the sticky and its edge tab, and the PDF export's print window.

pub mod bounds_store;
pub mod chrome;
pub mod close;
pub mod edge_tab;
pub mod events;
#[cfg(target_os = "macos")]
pub mod mac_window;
pub mod main_window;
pub mod nav_input;
pub mod pdf_print;
pub mod preboot;
pub mod registry;
pub mod reveal;
pub mod scripts;
pub mod startup_error;
pub mod sticky;
#[cfg(windows)]
pub mod win32_caption;
pub mod zoom;

pub use main_window::create_main;

pub const MAIN_LABEL: &str = "main";
