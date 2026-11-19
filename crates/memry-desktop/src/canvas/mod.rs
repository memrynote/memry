//! Canvases on disk: each canvas is a plain `.excalidraw` file under `<vault>/canvases`, and the
//! vault's shapes library is `canvases/library.excalidrawlib` (Electron's `canvas/scene-file.ts`
//! and `canvas/library-file.ts`). The record and its sync live in
//! [`memry_core::domain::canvas`]; the file text in its `file_format`.

pub mod dirs;
mod files;
pub mod folders;
pub mod library;
pub mod mirror;
pub mod reconcile;
pub mod scene_file;
pub mod service;
pub mod settle;
mod update;
pub mod watch;
