//! Which paths the watcher looks at: the `ignored` function of the chokidar options in
//! `vault/watcher.ts`, over vault-relative `/` paths.
//!
//! Ignored: any name starting with a dot (`.memry`, `.git`, `.obsidian`, editor temp files),
//! the vault root's `attachments` folder (the app's own; a nested one is the user's, #3161), and
//! any folder or file named like an exclude pattern. Electron matched the pattern against the
//! absolute path, so a vault that itself sat inside a folder named `node_modules` ignored
//! everything; matching the relative path does not.

use super::super::file_types::{is_canvas_file_path, is_supported_path};
use super::super::layout::ATTACHMENTS_DIR;

pub struct WatchFilter {
    exclude: Vec<String>,
}

impl WatchFilter {
    pub fn new(exclude: Vec<String>) -> Self {
        Self { exclude }
    }

    /// Whether `rel` or any folder above it is ignored.
    pub fn ignores(&self, rel: &str) -> bool {
        let mut first = true;
        for name in rel.split('/') {
            if name.starts_with('.') {
                return true;
            }
            // The root attachments folder, or a file named so at the root.
            if first && name == ATTACHMENTS_DIR {
                return true;
            }
            first = false;
            if self.exclude.iter().any(|pattern| pattern == name) {
                return true;
            }
        }
        // A pattern with a separator (`vendor/cache`) names a path, not a name.
        let framed = format!("/{rel}/");
        self.exclude
            .iter()
            .any(|p| p.contains('/') && framed.contains(&format!("/{p}/")))
    }

    /// A file the index takes: a supported type. Canvas documents are watched in Electron
    /// only so a removal becomes a canvas delete, which is the canvas step's.
    pub fn takes_file(&self, rel: &str) -> bool {
        !self.ignores(rel) && is_supported_path(rel) && !is_canvas_file_path(rel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter() -> WatchFilter {
        WatchFilter::new(vec!["node_modules".into(), "vendor/cache".into()])
    }

    #[test]
    fn hidden_excluded_and_the_root_attachments_folder_are_ignored() {
        let f = filter();
        for rel in [
            ".memry/core/data.db",
            "notes/.hidden.md",
            ".git/x.md",
            "attachments/a.png",
            "node_modules/p/readme.md",
            "a/node_modules/x.md",
            "vendor/cache/x.md",
            "a/vendor/cache/deep/x.md",
        ] {
            assert!(f.ignores(rel), "{rel}");
        }
        for rel in [
            "notes/a.md",
            "notes/attachments/b.md",
            "vendor/other.md",
            "node_modules_not.md",
        ] {
            assert!(!f.ignores(rel), "{rel}");
        }
    }

    #[test]
    fn only_supported_non_canvas_files_are_taken() {
        let f = filter();
        assert!(f.takes_file("a.md"));
        assert!(f.takes_file("img/p.PNG"));
        assert!(!f.takes_file("a.txt"));
        assert!(!f.takes_file("canvases/c.excalidraw"));
    }
}
