//! The pinned model files and the directory that holds them on the device.
//!
//! A file reaches its final name only after its sha256 matched the manifest,
//! so a short, damaged or substituted file is never loaded.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub(crate) struct ModelFile {
    pub(crate) path: &'static str,
    pub(crate) size: u64,
    pub(crate) sha256: &'static str,
}

pub(crate) struct Manifest {
    /// A new revision is a new id, and so a new directory.
    pub(crate) id: &'static str,
    pub(crate) base_url: &'static str,
    /// Stored with every vector. Derived from the two ONNX sha256s, so other
    /// weights never serve a vector built by these.
    pub(crate) vector_key: &'static str,
    pub(crate) files: &'static [ModelFile],
}

/// `onnx-community/embeddinggemma-2-ONNX` at commit `daa72c512439`, the q4
/// graph desktop runs. `config.json` is not read, so it is not listed.
pub(crate) const MODEL: Manifest = Manifest {
    id: "embeddinggemma-2-q4-daa72c512439",
    base_url: "https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/",
    vector_key: "embeddinggemma-2-q4-f9eeba97acdd-c3975f2d1ab7",
    files: &[
        ModelFile {
            path: "onnx/model_q4.onnx",
            size: 490_742,
            sha256: "f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9",
        },
        ModelFile {
            path: "onnx/model_q4.onnx_data",
            size: 174_028_800,
            sha256: "c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49",
        },
        ModelFile {
            path: "tokenizer.json",
            size: 32_170_510,
            sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4",
        },
    ],
};

impl Manifest {
    pub(crate) fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.size).sum()
    }
}

const OPT_IN: &str = "opt-in";
const PARTIAL: &str = ".partial";

/// The shell's models directory. The shell creates it; the core owns
/// everything inside it.
#[derive(Clone)]
pub struct ModelDir {
    root: PathBuf,
    manifest: &'static Manifest,
}

/// Proof that every manifest file sits under its final name, which only a
/// matching sha256 grants. The embedder loads nothing else.
pub struct VerifiedModel {
    dir: PathBuf,
}

impl VerifiedModel {
    pub(crate) fn dir(&self) -> &Path {
        &self.dir
    }

    #[cfg(all(test, not(feature = "semantic")))]
    pub(crate) fn assume(dir: PathBuf) -> Self {
        Self { dir }
    }
}

impl ModelDir {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            manifest: &MODEL,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_manifest(root: PathBuf, manifest: &'static Manifest) -> Self {
        Self { root, manifest }
    }

    pub(crate) fn manifest(&self) -> &'static Manifest {
        self.manifest
    }

    pub(crate) fn opted_in(&self) -> bool {
        self.root.join(OPT_IN).exists()
    }

    pub(crate) fn set_opted_in(&self) -> io::Result<()> {
        fs::create_dir_all(&self.root)?;
        fs::write(self.root.join(OPT_IN), [])
    }

    pub fn verified(&self) -> Option<VerifiedModel> {
        self.manifest
            .files
            .iter()
            .all(|file| self.is_final(file))
            .then(|| VerifiedModel {
                dir: self.model_dir(),
            })
    }

    /// Bytes on disk toward the manifest: final files plus resumable parts.
    pub(crate) fn received_bytes(&self) -> u64 {
        self.manifest
            .files
            .iter()
            .map(|file| {
                if self.is_final(file) {
                    file.size
                } else {
                    len(&self.part_path(file)).min(file.size)
                }
            })
            .sum()
    }

    pub(crate) fn missing_bytes(&self) -> u64 {
        self.manifest.total_bytes() - self.received_bytes()
    }

    /// Removes other model revisions and the finished download's parts.
    /// Idempotent.
    pub(crate) fn sweep(&self) -> io::Result<()> {
        if self.verified().is_some() {
            remove(&self.model_dir().join(PARTIAL))?;
        }
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        for entry in entries {
            let name = entry?.file_name();
            if name != OPT_IN && name != self.manifest.id {
                remove(&self.root.join(name))?;
            }
        }
        Ok(())
    }

    /// Removes everything inside the root, the opt-in marker first, so a
    /// download in flight stops at its next range.
    pub(crate) fn clear(&self) -> io::Result<()> {
        remove(&self.root.join(OPT_IN))?;
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        for entry in entries {
            remove(&entry?.path())?;
        }
        Ok(())
    }

    pub(crate) fn final_path(&self, file: &ModelFile) -> PathBuf {
        self.model_dir().join(file.path)
    }

    pub(crate) fn part_path(&self, file: &ModelFile) -> PathBuf {
        self.model_dir()
            .join(PARTIAL)
            .join(format!("{}.part", file.path))
    }

    pub(crate) fn is_final(&self, file: &ModelFile) -> bool {
        fs::metadata(self.final_path(file))
            .is_ok_and(|meta| meta.is_file() && meta.len() == file.size)
    }

    fn model_dir(&self) -> PathBuf {
        self.root.join(self.manifest.id)
    }
}

pub(crate) fn len(path: &Path) -> u64 {
    fs::metadata(path).map_or(0, |meta| meta.len())
}

fn remove(path: &Path) -> io::Result<()> {
    let removed = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) => Err(error),
    };
    match removed {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vector_key_names_the_pinned_onnx_hashes() {
        let [graph, weights, _] = MODEL.files else {
            panic!("three files");
        };
        assert_eq!(
            MODEL.vector_key,
            format!(
                "embeddinggemma-2-q4-{}-{}",
                &graph.sha256[..12],
                &weights.sha256[..12]
            )
        );
    }
}
