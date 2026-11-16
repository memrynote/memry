//! Test-only stand-in for `memry-ml-worker`, speaking the same frames. `PdfOpen`'s path picks the
//! behaviour: `hang` never answers, `hang:<file>` creates `<file>` and never answers, `crash`
//! aborts the process, `exit` exits with code 1, `oversize` writes a frame header past the cap,
//! `log` writes a stderr line and answers; anything else answers with one page as document 1.
//! `PdfPageText` answers the child's pid, so a test sees which child answered. `PdfRenderPage`
//! answers the names of the child's environment variables, a tab, then its cwd. `EmbedText` hangs,
//! crashes (any text that starts with `crash`) and creates files as `PdfOpen` does, answers NaNs
//! to `nan` and otherwise answers an embedding whose values are the child's pid; `EmbedLoad`
//! answers `Done`;
//! `ModelManifest` names one empty file, `config.json`, in the app's pinned repo and revision.
//! `AudioOpen` opens any path as recording 1 of three windows (none for a path ending in
//! `short.wav`); `EmbedAudioWindow` answers the child's pid, except that window 1 of a path ending
//! in `crash.wav` aborts, of `hang.wav` never answers, and of `nan.wav` answers NaNs.
//! `--crash-before-ready` aborts before the `Ready` frame. Never bundled.

use std::io::Write;

use memry_ml_worker::serve::serve;
use memry_ml_worker::{
    EMBEDDING_DIMENSION, MAX_FRAME_LEN, MODEL_REPO, MODEL_REVISION, Manifest, ManifestFile,
    Request, Response,
};

fn park_forever() -> ! {
    loop {
        std::thread::park();
    }
}

fn main() {
    if std::env::args().any(|arg| arg == "--crash-before-ready") {
        std::process::abort();
    }
    let mut recording = String::new();
    let result = serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        |request| match request {
            Request::PdfOpen { path } => match path.as_str() {
                "hang" => loop {
                    std::thread::park();
                },
                hang if hang.starts_with("hang:") => {
                    let _ = std::fs::write(&hang["hang:".len()..], b"");
                    loop {
                        std::thread::park();
                    }
                }
                "crash" => std::process::abort(),
                "exit" => std::process::exit(1),
                "oversize" => {
                    let mut out = std::io::stdout().lock();
                    let _ = out.write_all(&(MAX_FRAME_LEN + 1).to_be_bytes());
                    let _ = out.flush();
                    loop {
                        std::thread::park();
                    }
                }
                "log" => {
                    eprintln!("stub-log-line");
                    Response::PdfOpened {
                        doc: 1,
                        page_count: 1,
                    }
                }
                _ => Response::PdfOpened {
                    doc: 1,
                    page_count: 1,
                },
            },
            Request::PdfPageText { .. } => Response::Text(std::process::id().to_string()),
            Request::EmbedLoad => Response::Done,
            Request::ModelManifest { .. } => Response::Manifest(Manifest {
                repo: MODEL_REPO.into(),
                revision: MODEL_REVISION.into(),
                files: vec![ManifestFile {
                    path: "config.json".into(),
                    size: 0,
                    // The SHA-256 of no bytes.
                    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                        .into(),
                }],
            }),
            Request::EmbedText { text } => match text.as_str() {
                "hang" => park_forever(),
                hang if hang.starts_with("hang:") => {
                    let _ = std::fs::write(&hang["hang:".len()..], b"");
                    park_forever()
                }
                crash if crash.starts_with("crash") => std::process::abort(),
                "nan" => Response::Embedded(vec![f32::NAN; EMBEDDING_DIMENSION]),
                _ => Response::Embedded(vec![std::process::id() as f32; EMBEDDING_DIMENSION]),
            },
            Request::AudioOpen { path } => {
                let windows = if path.ends_with("short.wav") { 0 } else { 3 };
                recording = path;
                Response::AudioOpened {
                    recording: 1,
                    windows,
                }
            }
            Request::EmbedAudioWindow { window: 1, .. } if recording.ends_with("crash.wav") => {
                std::process::abort()
            }
            Request::EmbedAudioWindow { window: 1, .. } if recording.ends_with("hang.wav") => {
                park_forever()
            }
            Request::EmbedAudioWindow { window: 1, .. } if recording.ends_with("nan.wav") => {
                Response::Embedded(vec![f32::NAN; EMBEDDING_DIMENSION])
            }
            Request::EmbedAudioWindow { .. } => {
                Response::Embedded(vec![std::process::id() as f32; EMBEDDING_DIMENSION])
            }
            Request::PdfRenderPage { .. } => {
                let mut names: Vec<_> = std::env::vars_os()
                    .map(|(name, _)| name.to_string_lossy().into_owned())
                    .collect();
                names.sort();
                let cwd = std::env::current_dir().unwrap_or_default();
                Response::Text(format!("{}\t{}", names.join("\n"), cwd.display()))
            }
            _ => Response::Done,
        },
    );
    if result.is_err() {
        std::process::exit(3);
    }
}
