//! Canvases on disk: each canvas is a plain `.excalidraw` file under `<vault>/canvases`, and the
//! vault's shapes library is `canvases/library.excalidrawlib` (Electron's `canvas/scene-file.ts`
//! and `canvas/library-file.ts`). The record and its sync live in
//! [`memry_core::domain::canvas`]; the file text in its `file_format`.

pub mod assets;
mod files;
pub mod folders;
pub mod library;
pub mod live;
pub mod scene_file;
pub mod service;
mod update;
