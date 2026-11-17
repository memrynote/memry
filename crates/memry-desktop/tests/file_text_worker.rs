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
use std::time::{Duration, Instant};

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

/// The page's text is the pid of the child that read it.
fn read_by(f: &Ft<WorkerHandle>, id: &str) -> Option<u32> {
    f.text(id).parse().ok()
}

/// The child dies in the middle of the page read. `read_twice` opens the document again in the
/// next child inside the same pass, so the job ends `Done` with no pass error and no wait.
/// (`ERROR_BACKOFF` follows only an error of the pass itself, a database one for example: a
/// worker failure is a page failure, `runner.ts` `readTwice`.)
#[test]
#[ignore = "needs `cargo build -p memry-ml-worker --bins`"]
fn a_worker_killed_mid_read_is_read_again_by_a_fresh_worker_in_the_same_pass() {
    let marks = tempfile::tempdir().unwrap();
    let crash_once = marks.path().join("crash-once");
    std::fs::write(&crash_once, b"").unwrap();
    let f = ft_with(
        &[("doc.pdf", b"%PDF")],
        worker("memry-ml-worker-stub", marks.path().to_path_buf()),
    );
    f.scanned();
    let id = f.id_of("doc.pdf");
    let job = f.settled_job(&own(&id));
    assert!(!crash_once.exists(), "the first child aborted in the read");
    assert_eq!(
        (job.status, job.error, job.page_count),
        (FileTextJobStatus::Done, None, Some(1))
    );
    assert!(
        read_by(&f, &id).is_some(),
        "the second child's page: {}",
        f.text(&id)
    );
    assert_eq!(f.found(&f.text(&id)), [id]);
}

/// Both reads of the page kill the child: the page is stored unreadable and the job ends. A day
/// later (the runner's clock) the comparison finds the unreadable page due and the job reads it
/// with the worker that now works.
#[test]
#[ignore = "needs `cargo build -p memry-ml-worker --bins`"]
fn a_page_that_killed_the_worker_twice_is_read_again_a_day_later() {
    let marks = tempfile::tempdir().unwrap();
    let crash_always = marks.path().join("crash-always");
    std::fs::write(&crash_always, b"").unwrap();
    let f = ft_with(
        &[("doc.pdf", b"%PDF")],
        worker("memry-ml-worker-stub", marks.path().to_path_buf()),
    );
    f.scanned();
    let id = f.id_of("doc.pdf");
    let of = own(&id);
    let job = f.settled_job(&of);
    assert_eq!(job.status, FileTextJobStatus::Done);
    let open = f.e.session.current().expect("open");
    let unreadable = open
        .search
        .extracted_parts(of.clone(), Some(ExtractedTextMethod::Unreadable))
        .unwrap();
    assert_eq!(unreadable.into_iter().collect::<Vec<_>>(), [1]);
    assert_eq!(f.text(&id), "");

    std::fs::remove_file(&crash_always).unwrap();
    f.scanned();
    assert_eq!(f.text(&id), "", "not due within the day");
    f.clock_offset
        .store(25 * 60 * 60 * 1000, std::sync::atomic::Ordering::SeqCst);
    f.scanned();
    f.until("the page read again", |f| read_by(f, &id).is_some());
    assert_eq!(f.found(&f.text(&id)), [id]);
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

/// A PDF of `pages` pages with no text layer: each page is `png` drawn as a grey image, as a
/// scanner writes it. The pages share one image object.
fn scanned_pdf(png: &[u8], pages: usize) -> Vec<u8> {
    let grey = image::load_from_memory(png).unwrap().into_luma8();
    let (width, height) = grey.dimensions();
    let mut zlib = ZlibEncoder::new(Vec::new(), Compression::default());
    zlib.write_all(grey.as_raw()).unwrap();
    let pixels = zlib.finish().unwrap();
    let content = format!("q {width} 0 0 {height} 0 0 cm /Im0 Do Q");
    let (image_obj, content_obj) = (pages + 3, pages + 4);
    let kids: Vec<String> = (3..3 + pages).map(|n| format!("{n} 0 R")).collect();
    let mut objects: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        format!(
            "<< /Type /Pages /Kids [{}] /Count {pages} >>",
            kids.join(" ")
        )
        .into_bytes(),
    ];
    for _ in 0..pages {
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] \
                 /Resources << /XObject << /Im0 {image_obj} 0 R >> >> /Contents {content_obj} 0 R >>"
            )
            .into_bytes(),
        );
    }
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
    let pdf = scanned_pdf(&png, 1);
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

/// Measurements for #3542 box 75, printed and never asserted (a timing bound is not a test, and
/// the numbers depend on the machine). Run on a release build:
///
/// ```text
/// cargo build --release -p memry-ml-worker --bin memry-ml-worker --no-default-features --features pdf,ocr
/// MEMRY_PERF=1 MEMRY_SEED1K_VAULT=<pnpm seed1k --vault=...> MEMRY_PERF_SCAN_PNG=<page.png> MEMRY_PERF_SCAN_WORD=<a word on it> \
///   cargo test --release -p memry-desktop --test file_text_worker -- --ignored --nocapture measure
/// ```
///
/// Without `MEMRY_PERF_SCAN_PNG` the scan is the small OCR fixture, far lighter than a page.
/// Without `MEMRY_PERF` they skip, so CI's `--run-ignored only` run of this file does not time anything.
fn perf_requested() -> bool {
    let on = std::env::var_os("MEMRY_PERF").is_some();
    if !on {
        eprintln!("skipped: set MEMRY_PERF=1 to measure");
    }
    on
}

#[test]
#[ignore = "measurement: needs the release worker and pdfium"]
fn measure_the_first_page_of_a_twenty_page_scan() {
    if !perf_requested() {
        return;
    }
    let (png, word) = match std::env::var_os("MEMRY_PERF_SCAN_PNG") {
        Some(path) => (
            std::fs::read(path).unwrap(),
            std::env::var("MEMRY_PERF_SCAN_WORD").expect("MEMRY_PERF_SCAN_WORD"),
        ),
        None => (ocr_fixture(), "Heron".to_owned()),
    };
    let pdf = scanned_pdf(&png, 20);
    let worker = worker("memry-ml-worker", pdfium_dir());
    let data = tempfile::tempdir().unwrap();
    let start = Instant::now();
    let f = ft_built(
        &[("scan.pdf", &pdf)],
        worker.clone(),
        real_ocr(&worker, data.path()),
        "1.0.0",
    );
    let opened = start.elapsed();
    let of = own(&f.id_of("scan.pdf"));
    while f.found(&word).is_empty() {
        assert!(
            start.elapsed() < Duration::from_secs(600),
            "page 1 never became searchable"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let first = start.elapsed();
    while f
        .job(&of)
        .is_none_or(|job| job.status == FileTextJobStatus::Pending)
    {
        assert!(
            start.elapsed() < Duration::from_secs(600),
            "the scan never finished"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let all = start.elapsed();
    let job = f.job(&of).unwrap();
    eprintln!(
        "PERF scan {}x{} px, {} pdf bytes: vault open+index {opened:?}; page 1 searchable {first:?}; \
         20 pages done {all:?} ({:?} a page after the first); job {:?} pages {:?}",
        image::load_from_memory(&png).unwrap().width(),
        image::load_from_memory(&png).unwrap().height(),
        pdf.len(),
        (all - first) / 19,
        job.status,
        job.page_count,
    );
}

/// Every file of `root` outside dot folders, as `(relative path, bytes)`.
fn vault_files(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().unwrap().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            vault_files(root, &path, out);
        } else {
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            out.push((rel, std::fs::read(&path).unwrap()));
        }
    }
}

/// 15 scans with nothing changed, each from `rescan_all` to the scan ending, in ms (sorted).
fn idle_scans(f: &Ft<WorkerHandle>) -> Vec<f64> {
    f.scanned();
    let runner = f.file_text.runner().expect("running");
    let mut times: Vec<f64> = (0..15)
        .map(|_| {
            let before = runner.scans();
            let start = Instant::now();
            f.file_text.rescan_all();
            while runner.scans() == before {
                std::thread::sleep(Duration::from_micros(100));
            }
            start.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    times.sort_by(f64::total_cmp);
    times
}

fn measure_idle_scans(label: &str, extra: &[(String, Vec<u8>)]) {
    let root = PathBuf::from(std::env::var_os("MEMRY_SEED1K_VAULT").expect("MEMRY_SEED1K_VAULT"));
    let mut files = Vec::new();
    vault_files(&root, &root, &mut files);
    let notes = files.len();
    files.extend(extra.iter().cloned());
    let borrowed: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(p, b)| (p.as_str(), b.as_slice()))
        .collect();
    // The worker is never called: no PDF is in the vault.
    let worker = WorkerHandle::new(WorkerPaths {
        program: PathBuf::from("unused"),
        pdfium_dir: PathBuf::new(),
    });
    let f = ft_with(&borrowed, worker);
    if !extra.is_empty() {
        let started = Instant::now();
        let open = f.e.session.current().unwrap();
        let failed = || {
            open.search
                .file_text_jobs_with_status(FileTextJobStatus::Failed)
                .unwrap()
                .len()
        };
        while failed() < extra.len() {
            assert!(
                started.elapsed() < Duration::from_secs(600),
                "{} jobs ended",
                failed()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        eprintln!(
            "PERF {} image jobs ended after {:?}",
            extra.len(),
            started.elapsed()
        );
    }
    let times = idle_scans(&f);
    eprintln!(
        "PERF no-change scan, {label} ({notes} vault files + {} filed images): min {:.1} ms, median {:.1} ms, max {:.1} ms; compared {} files over {} scans",
        extra.len(),
        times[0],
        times[times.len() / 2],
        times[times.len() - 1],
        f.compared(),
        f.file_text.runner().unwrap().scans(),
    );
}

#[test]
#[ignore = "measurement: needs MEMRY_SEED1K_VAULT"]
fn measure_a_no_change_scan_of_the_seed1k_vault() {
    if !perf_requested() {
        return;
    }
    measure_idle_scans("seed1k as seeded", &[]);
}

/// The heavy case: the seed1k notes and a thousand filed images, each compared on every scan.
#[test]
#[ignore = "measurement: needs MEMRY_SEED1K_VAULT"]
fn measure_a_no_change_scan_of_the_seed1k_vault_with_a_thousand_filed_images() {
    if !perf_requested() {
        return;
    }
    let images: Vec<(String, Vec<u8>)> = (0..1000)
        .map(|i| (format!("img/f{}/i{i}.png", i % 10), b"png".to_vec()))
        .collect();
    measure_idle_scans("seed1k plus images", &images);
}
