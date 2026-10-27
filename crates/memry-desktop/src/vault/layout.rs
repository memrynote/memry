//! Folder and file names inside a vault. Shared with the Electron app, so none of these
//! changes without a migration of existing vaults.

/// The app's own folder: config, databases, icons, activity log.
pub const MEMRY_DIR: &str = ".memry";
/// The app's attachment storage. Only the vault root's folder of this name is the app's: a
/// nested folder of the same name is the user's own and holds ordinary notes (#3161).
pub const ATTACHMENTS_DIR: &str = "attachments";
/// Canvas documents.
pub const CANVAS_DIR: &str = "canvases";
/// `.excalidraw`, the extension of a canvas document.
pub const CANVAS_FILE_EXT: &str = ".excalidraw";

/// `DEFAULT_CONFIG.excludePatterns` of `init.ts`.
pub const DEFAULT_EXCLUDE_PATTERNS: [&str; 5] =
    [".git", "node_modules", ".trash", ".obsidian", MEMRY_DIR];
