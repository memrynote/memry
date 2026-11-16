//! The real worker on the Tesseract this crate links, with the English data the app bundles
//! (`apps/desktop-tauri/src-tauri/resources/tessdata/eng.traineddata.gz`, unpacked here as the app
//! unpacks it). Ports `apps/desktop/src/main/file-text/ocr-reader.test.ts:15-38`. pdfium is not
//! needed: an OCR read never binds it.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use flate2::read::GzDecoder;
use image::ImageEncoder;
use memry_ml_worker::{Limits, Supervisor, SystemClock, WorkerError};

fn worker() -> Supervisor {
    Supervisor::new(
        PathBuf::from(env!("CARGO_BIN_EXE_memry-ml-worker")),
        vec!["--pdfium-dir".into(), "no-pdfium".into()],
        Limits::default(),
        Arc::new(SystemClock),
    )
}

/// A data dir holding the plain `eng.traineddata`.
fn tessdata() -> tempfile::TempDir {
    tessdata_named("ocr")
}

fn tessdata_named(prefix: &str) -> tempfile::TempDir {
    let packed = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop-tauri/src-tauri/resources/tessdata/eng.traineddata.gz"),
    )
    .expect("the bundled English data");
    let mut plain = Vec::new();
    GzDecoder::new(packed.as_slice())
        .read_to_end(&mut plain)
        .expect("gunzip");
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir()
        .expect("temp dir");
    std::fs::write(dir.path().join("eng.traineddata"), plain).expect("write");
    dir
}

fn fixture() -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ocr-reader.fixture.png"),
    )
    .expect("fixture")
}

fn eng() -> Vec<String> {
    vec!["eng".into()]
}

#[test]
fn reads_the_text_of_an_image_with_the_bundled_english_data() {
    let data = tessdata();
    let text = worker()
        .recognize(data.path(), &eng(), fixture())
        .expect("read");
    assert_eq!(text.trim(), "Heron count at dawn");
}

/// A Windows profile dir like `C:\Users\Çağrı`: Tesseract's narrow `fopen` reads the path in
/// the ANSI code page there.
#[test]
fn reads_with_data_under_a_non_ascii_dir() {
    let data = tessdata_named("ocr-ç");
    let text = worker()
        .recognize(data.path(), &eng(), fixture())
        .expect("read");
    assert_eq!(text.trim(), "Heron count at dawn");
}

#[test]
fn keeps_reading_after_a_bad_image_and_a_language_without_data() {
    let data = tessdata();
    let worker = worker();
    let failed = worker.recognize(data.path(), &eng(), b"not an image".to_vec());
    assert!(
        matches!(&failed, Err(WorkerError::Failed(m)) if m.contains("could not be decoded")),
        "{failed:?}"
    );
    let failed = worker.recognize(data.path(), &["deu".into()], fixture());
    assert_eq!(
        failed,
        Err(WorkerError::Failed("Tesseract could not load deu".into()))
    );
    let pid = worker.pid();
    let text = worker
        .recognize(data.path(), &eng(), fixture())
        .expect("read");
    assert_eq!(text.trim(), "Heron count at dawn");
    assert_eq!(worker.pid(), pid, "the same child read after both failures");
}

#[test]
fn a_language_code_that_is_not_a_file_name_is_refused() {
    let data = tessdata();
    for code in ["../eng", "eng/x", "", "ENG", "eng+deu"] {
        let failed = worker().recognize(data.path(), &[code.into()], fixture());
        assert_eq!(
            failed,
            Err(WorkerError::Failed(format!(
                "{code:?} is not an OCR language code"
            ))),
            "{code}"
        );
    }
}

#[test]
fn an_image_past_the_ocr_edge_is_refused_before_it_is_decoded() {
    let data = tessdata();
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[255; 4001], 4001, 1, image::ExtendedColorType::L8)
        .expect("encode");
    let failed = worker().recognize(data.path(), &eng(), png);
    assert!(
        matches!(&failed, Err(WorkerError::Failed(m)) if m.contains("could not be decoded")),
        "{failed:?}"
    );
}
