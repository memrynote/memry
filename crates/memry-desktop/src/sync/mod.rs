//! The sync supervisor of the open vault: when passes run, whether sync may start, and the status
//! the renderer shows. The passes themselves are `memry_core::sync::driver::SyncDriver`'s.

pub mod backend;
pub mod error_category;
mod frames;
pub mod gate;
pub mod realtime;
pub mod result;
mod run_loop;
pub mod shutdown;
pub mod signals;
pub mod status;
pub mod supervisor;
pub mod triggers;

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    /// Desktop runs sync on its own tokio runtime (`apps/desktop-tauri/AGENTS.md` `## Sync`), never
    /// on the core's iOS runtime. Built from parts so this file does not match itself.
    #[test]
    fn no_core_runtime_in_desktop() {
        let banned = [
            ["memry_core::api::", "runtime"].concat(),
            ["Background", "Exec"].concat(),
            ["Lifecycle", "Observer"].concat(),
            ["Runtime", "Host"].concat(),
        ];
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        rust_files(&root.join("src"), &mut files);
        rust_files(
            &root.join("../../apps/desktop-tauri/src-tauri/src"),
            &mut files,
        );
        assert!(files.len() > 100, "the scan found the sources");
        let hits: Vec<String> = files
            .iter()
            .flat_map(|file| {
                let text = std::fs::read_to_string(file).unwrap();
                banned
                    .iter()
                    .filter(|name| text.contains(name.as_str()))
                    .map(|name| format!("{}: {name}", file.display()))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(hits.is_empty(), "{hits:#?}");
    }
}
