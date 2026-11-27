//! The sticky capture window's rules (`apps/desktop/src/main/stickies/`), free of Tauri: where
//! it opens, how tall it may grow, which draft a shortcut or an unfold opens, and where the edge
//! tab shows. The window adapters are `windows/{sticky,edge_tab}.rs` of `apps/desktop-tauri`.

pub mod drafts;
pub mod edge_tab;
pub mod geometry;
pub mod session;
