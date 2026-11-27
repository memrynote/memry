//! The sticky capture window's rules (`apps/desktop/src/main/stickies/`), free of Tauri: where
//! it opens, how tall it may grow, and which draft a shortcut or an unfold opens. The window
//! adapter is `apps/desktop-tauri/src-tauri/src/windows/sticky.rs`.

pub mod drafts;
pub mod geometry;
pub mod session;
