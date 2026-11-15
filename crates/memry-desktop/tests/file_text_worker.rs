//! The file text runner reading through the real `memry-ml-worker` sidecar. Ignored by default:
//! the binaries must be built first, and the pdfium test needs the library. CI (rust-ci, Ubuntu):
//!
//! ```text
//! cargo build -p memry-ml-worker --bins
//! MEMRY_PDFIUM_DIR=<dir> cargo nextest run -p memry-desktop --test file_text_worker --run-ignored only
//! ```
//!
//! Without `MEMRY_PDFIUM_DIR` the pdfium test looks where `node scripts/fetch-pdfium.mjs` writes.

mod device_key;
#[path = "file_text_env.rs"]
mod file_text_env;
mod vault_env;

use std::path::{Path, PathBuf};

use memry_core::domain::file_text::FileTextJobStatus;
use memry_desktop::services::file_text::{WorkerHandle, WorkerPaths};

use file_text_env::{ft_with, own};

/// Cargo's target dir of this test binary (`target/<profile>/deps/<test>`), which holds every
/// workspace binary `cargo build -p memry-ml-worker --bins` wrote.
fn bin_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    exe.parent().unwrap().parent().unwrap().to_path_buf()
}

fn worker(program: &str, pdfium_dir: PathBuf) -> std::sync::Arc<WorkerHandle> {
    let program = bin_dir().join(format!("{program}{}", std::env::consts::EXE_SUFFIX));
    assert!(
        program.is_file(),
        "{} is missing: run `cargo build -p memry-ml-worker --bins`",
        program.display()
    );
    WorkerHandle::new(WorkerPaths {
        program,
        pdfium_dir,
    })
}

fn pdfium_dir() -> PathBuf {
    let dir = std::env::var_os("MEMRY_PDFIUM_DIR").map_or_else(
        || {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../apps/desktop-tauri/src-tauri/resources/pdfium")
        },
        PathBuf::from,
    );
    assert!(
        dir.is_dir(),
        "pdfium is missing at {}: run `node scripts/fetch-pdfium.mjs`",
        dir.display()
    );
    dir
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// The stub answers every page with its process id, so the text names the child that read it.
#[test]
#[ignore = "needs `cargo build -p memry-ml-worker --bins`"]
fn a_filed_pdf_is_read_through_the_worker_which_stops_with_the_vault() {
    let mut f = ft_with(
        &[("doc.pdf", b"%PDF")],
        worker("memry-ml-worker-stub", PathBuf::new()),
    );
    f.scanned();
    let id = f.id_of("doc.pdf");
    let job = f.settled_job(&own(&id));
    assert_eq!(
        (job.status, job.page_count),
        (FileTextJobStatus::Done, Some(1))
    );
    let pid: u32 = f.text(&id).parse().expect("the child's pid");
    assert_eq!(f.found(&pid.to_string()), [id]);

    #[cfg(unix)]
    assert!(alive(pid), "the worker idles a minute before it exits");
    f.e.close();
    #[cfg(unix)]
    assert!(!alive(pid), "closing the vault stops the worker");
}

#[test]
#[ignore = "needs `cargo build -p memry-ml-worker --bins` and pdfium"]
fn a_pdf_text_layer_is_read_by_pdfium() {
    let pdf = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../memry-ml-worker/tests/fixtures/two-pages.pdf"),
    )
    .unwrap();
    let f = ft_with(
        &[("two-pages.pdf", &pdf)],
        worker("memry-ml-worker", pdfium_dir()),
    );
    f.scanned();
    let id = f.id_of("two-pages.pdf");
    let job = f.settled_job(&own(&id));
    assert_eq!(
        (job.status, job.page_count),
        (FileTextJobStatus::Done, Some(2))
    );
    let text = f.text(&id);
    assert!(text.contains("Alpha harbor lantern"), "{text}");
    assert!(text.contains("Beta orchard compass"), "{text}");
    assert_eq!(f.found("orchard"), [id]);
}
