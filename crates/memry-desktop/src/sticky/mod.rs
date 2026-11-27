//! The sticky capture window's rules (`apps/desktop/src/main/stickies/`), free of Tauri: where
//! it opens, how tall it may grow, which draft a shortcut or an unfold opens, where the edge tab
//! shows, and where a send puts the text. The window adapters are `windows/{sticky,edge_tab}.rs`
//! of `apps/desktop-tauri`.

pub mod drafts;
pub mod edge_tab;
pub mod geometry;
pub mod send;
pub mod session;
pub mod task_input;
pub mod text;
pub mod undo;
