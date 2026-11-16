//! The file text runner reading through the real `memry-ml-worker` sidecar. Ignored by default:
//! the binaries must be built first (which needs the Tesseract sources), and the pdfium tests
//! need the library. CI (rust-ci, Ubuntu):
//!
//! ```text
//! cargo build -p memry-ml-worker --bins
//! MEMRY_PDFIUM_DIR=<dir> cargo nextest run -p memry-desktop --test file_text_worker --run-ignored only
//! ```
//!
//! Without `MEMRY_PDFIUM_DIR` the pdfium tests look where `node scripts/fetch-pdfium.mjs` writes.
//! OCR reads with the English data the app ships, through [`OcrEngine`] as the app does.

mod device_key;
#[path = "file_text_env.rs"]
mod file_text_env;
mod vault_env;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use flate2::Compression;
use flate2::write::ZlibEncoder;
use memry_core::domain::file_text::{ExtractedTextMethod, FileTextJobStatus};
use memry_desktop::services::file_text::ocr::OcrEngine;
use memry_desktop::services::file_text::{PdfReader, WorkerHandle, WorkerPaths};
use memry_desktop::services::ocr_languages::OcrLanguage;

use file_text_env::{Ft, Ocr, ft_built, ft_with, own};

/// What `ocr-reader.fixture.png` reads as (`ocr-reader.test.ts`).
const FIXTURE_TEXT: &str = "Heron count at dawn";

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

fn ocr_fixture() -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../memry-ml-worker/tests/fixtures/ocr-reader.fixture.png"),
    )
    .unwrap()
}

/// The app's OCR on `worker`: English only, unpacked from the bundled pack into `data`.
fn real_ocr(worker: &Arc<WorkerHandle>, data: &Path) -> Ocr {
    let engine = OcrEngine::new(
        worker.clone(),
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop-tauri/src-tauri/resources"),
    );
    let data = data.to_path_buf();
    Ocr::Real(Arc::new(move |image| {
        engine.read(image, &data, &[OcrLanguage::Eng])
    }))
}

/// A one-page PDF with no text layer: the page is `png` drawn as a grey image, as a scanner
/// writes it.
fn scanned_pdf(png: &[u8]) -> Vec<u8> {
    let grey = image::load_from_memory(png).unwrap().into_luma8();
    let (width, height) = grey.dimensions();
    let mut zlib = ZlibEncoder::new(Vec::new(), Compression::default());
    zlib.write_all(grey.as_raw()).unwrap();
    let pixels = zlib.finish().unwrap();
    let content = format!("q {width} 0 0 {height} 0 0 cm /Im0 Do Q");
    let mut objects: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] \
             /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>"
        )
        .into_bytes(),
    ];
    let mut image = format!(
        "<< /Type /XObject /Subtype /Image /Width {width} /Height {height} \
         /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length {} >>\nstream\n",
        pixels.len()
    )
    .into_bytes();
    image.extend_from_slice(&pixels);
    image.extend_from_slice(b"\nendstream");
    objects.push(image);
    objects.push(
        format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len()
        )
        .into_bytes(),
    );
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        pdf.extend_from_slice(body);
        pdf.extend_from_slice(b"\nendobj\n");
    }
    let xref = pdf.len();
    pdf.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    pdf
}

/// The file `rel` was read by OCR, in English, to the fixture's words.
fn assert_read_by_ocr<P: PdfReader>(f: &Ft<P>, rel: &str) -> String {
    let of = own(&f.id_of(rel));
    let job = f.settled_job(&of);
    assert_eq!(
        (
            job.status,
            job.error.as_deref(),
            job.ocr_languages.as_deref()
        ),
        (FileTextJobStatus::Done, None, Some("eng")),
        "{rel}"
    );
    let open = f.e.session.current().expect("open");
    let ocr = open
        .search
        .extracted_parts(of.clone(), Some(ExtractedTextMethod::Ocr))
        .unwrap();
    assert_eq!(ocr.into_iter().collect::<Vec<_>>(), [1], "{rel}");
    let text = f.text(&of.note_id);
    assert_eq!(text, FIXTURE_TEXT, "{rel}");
    of.note_id
}

#[test]
#[ignore = "needs `cargo build -p memry-ml-worker --bins` and pdfium"]
fn a_scanned_image_and_a_scanned_pdf_page_are_read_by_tesseract() {
    let png = ocr_fixture();
    let pdf = scanned_pdf(&png);
    let worker = worker("memry-ml-worker", pdfium_dir());
    let data = tempfile::tempdir().unwrap();
    let f = ft_built(
        &[("scan.png", &png), ("scan.pdf", &pdf)],
        worker.clone(),
        real_ocr(&worker, data.path()),
        "1.0.0",
    );
    f.scanned();
    let image = assert_read_by_ocr(&f, "scan.png");
    let page = assert_read_by_ocr(&f, "scan.pdf");
    let mut found = f.found("Heron");
    found.sort();
    let mut both = vec![image, page];
    both.sort();
    assert_eq!(found, both);
}

/// A build without OCR failed the image `OCR unavailable`; the next version, which has OCR,
/// reads it (`is_due_for_retry`: another app version).
#[test]
#[ignore = "needs `cargo build -p memry-ml-worker --bins`"]
fn an_image_failed_without_ocr_is_read_by_the_next_version_with_ocr() {
    let worker = worker("memry-ml-worker", PathBuf::from("no-pdfium"));
    let f = ft_built(
        &[("scan.png", &ocr_fixture())],
        worker.clone(),
        Ocr::Off,
        "0.9.0",
    );
    f.scanned();
    let of = own(&f.id_of("scan.png"));
    let job = f.settled_job(&of);
    assert_eq!(
        (job.status, job.error.as_deref(), job.app_version.as_str()),
        (FileTextJobStatus::Failed, Some("OCR unavailable"), "0.9.0")
    );
    assert_eq!(f.text(&of.note_id), "");

    let data = tempfile::tempdir().unwrap();
    let f = f.restart(real_ocr(&worker, data.path()), "1.0.0");
    f.scanned();
    assert_eq!(assert_read_by_ocr(&f, "scan.png"), of.note_id);
    assert_eq!(f.job(&of).unwrap().app_version, "1.0.0");
    assert_eq!(f.found("Heron"), [of.note_id]);
}
