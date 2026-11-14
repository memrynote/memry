//! The real worker on the pinned pdfium. Needs the library: `node scripts/fetch-pdfium.mjs`
//! writes it where these tests look by default; `MEMRY_PDFIUM_DIR` points them elsewhere (CI).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use memry_ml_worker::{
    Limits, MAX_RENDER_EDGE, PdfDocument, RenderedPage, Supervisor, SystemClock, WorkerError,
};

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

fn worker_with(pdfium: &Path) -> Supervisor {
    Supervisor::new(
        PathBuf::from(env!("CARGO_BIN_EXE_memry-ml-worker")),
        vec!["--pdfium-dir".into(), pdfium.into()],
        Limits::default(),
        Arc::new(SystemClock),
    )
}

fn worker() -> Supervisor {
    worker_with(&pdfium_dir())
}

fn open<'a>(worker: &'a Supervisor, name: &str) -> Result<PdfDocument<'a>, WorkerError> {
    worker.open_pdf(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
}

/// Width and height from the PNG's IHDR, which must match what the worker reported.
fn dimensions(page: &RenderedPage) -> (u32, u32) {
    let png = &page.png;
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let ihdr = |at: usize| u32::from_be_bytes(png[at..at + 4].try_into().unwrap());
    assert_eq!((ihdr(16), ihdr(20)), (page.width, page.height));
    (page.width, page.height)
}

#[test]
fn a_two_page_pdf_gives_its_text_and_renders() {
    let worker = worker();
    let doc = open(&worker, "two-pages.pdf").expect("open");
    assert_eq!(doc.page_count(), 2);
    assert!(
        doc.page_text(1)
            .expect("page 1")
            .contains("Alpha harbor lantern")
    );
    assert!(
        doc.page_text(2)
            .expect("page 2")
            .contains("Beta orchard compass")
    );
    // Page 2 is 792 x 612 pt: the long edge lands on the requested 400 px.
    assert_eq!(
        dimensions(&doc.render_page(2, 400).expect("render")),
        (400, 309)
    );
    // Page 1 is 612 x 792 pt: 4000 px would pass 300 DPI, which caps it at 792 * 300 / 72.
    assert_eq!(
        dimensions(&doc.render_page(1, 4000).expect("render")).1,
        3300
    );
    let reopened = open(&worker, "two-pages.pdf").expect("open again");
    doc.close().expect("close");
    assert!(
        reopened.page_text(1).is_ok(),
        "closing one document leaves the other open"
    );
}

#[test]
fn bad_page_numbers_and_edges_fail_the_op_only() {
    let worker = worker();
    let doc = open(&worker, "two-pages.pdf").expect("open");
    let pid = worker.pid();
    for page in [0, 3, u32::MAX] {
        assert!(
            matches!(doc.page_text(page), Err(WorkerError::Failed(_))),
            "page {page}"
        );
    }
    for edge in [0, MAX_RENDER_EDGE + 1] {
        assert!(
            matches!(doc.render_page(1, edge), Err(WorkerError::Failed(_))),
            "edge {edge}"
        );
    }
    assert_eq!(worker.pid(), pid, "the worker survived every bad request");
}

#[test]
fn a_corrupt_pdf_errors_without_killing_the_worker() {
    let worker = worker();
    assert_eq!(
        open(&worker, "two-pages.pdf").expect("open").page_count(),
        2
    );
    let pid = worker.pid().expect("running");
    let error = open(&worker, "corrupt.pdf").err().expect("corrupt");
    assert!(
        matches!(&error, WorkerError::Failed(m) if m.contains("could not be opened")),
        "{error:?}"
    );
    assert!(matches!(
        open(&worker, "missing.pdf"),
        Err(WorkerError::Failed(_))
    ));
    assert_eq!(worker.pid(), Some(pid), "the same worker is alive");
    assert_eq!(
        open(&worker, "two-pages.pdf")
            .expect("open after")
            .page_count(),
        2
    );
}

#[test]
fn a_worker_without_pdfium_fails_each_pdf_op_and_stays_up() {
    let empty = tempfile::tempdir().expect("temp dir");
    let worker = worker_with(empty.path());
    let error = open(&worker, "two-pages.pdf").err().expect("no pdfium");
    assert!(
        matches!(&error, WorkerError::Failed(m) if m.contains("pdfium could not be loaded")),
        "{error:?}"
    );
    let pid = worker.pid().expect("still running");
    assert!(open(&worker, "two-pages.pdf").is_err());
    assert_eq!(worker.pid(), Some(pid));
}

#[cfg(unix)]
#[test]
fn a_killed_worker_is_restarted_by_the_next_call() {
    let worker = worker();
    let doc = open(&worker, "two-pages.pdf").expect("open");
    let killed = worker.pid().expect("running");
    // SAFETY: kills the child this test started.
    assert_eq!(
        unsafe { libc::kill(killed as libc::pid_t, libc::SIGKILL) },
        0
    );
    // The call races the stdout reader noticing the exit: either the pipe is already gone, or a
    // new worker answers that the old worker's document is not open.
    assert!(doc.page_text(1).is_err());
    assert_eq!(
        open(&worker, "two-pages.pdf")
            .expect("open again")
            .page_count(),
        2
    );
    assert_ne!(worker.pid(), Some(killed));
}
