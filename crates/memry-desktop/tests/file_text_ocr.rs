//! OCR's image preparation and its English data check, without the worker. The sizes are what
//! Electron's `toOcrPng` (`apps/desktop/src/main/file-text/ocr-reader.ts:6-25`) gives on sharp
//! 0.35.4, measured by running it in place on the same inputs.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
use memry_desktop::services::file_text::ocr::{BUNDLED_PACK, OcrEngine, to_ocr_png};
use memry_desktop::services::file_text::{WorkerHandle, WorkerPaths};
use memry_desktop::services::ocr_languages::OcrLanguage;

fn png(image: DynamicImage) -> Vec<u8> {
    let mut bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .unwrap();
    bytes
}

fn grey_rgb(width: u32, height: u32) -> Vec<u8> {
    png(RgbImage::from_pixel(width, height, Rgb([128, 128, 128])).into())
}

/// The prepared PNG, decoded as stored: its colour type and size.
fn prepared(input: &[u8]) -> DynamicImage {
    let out = to_ocr_png(input).expect("prepared");
    image::load_from_memory_with_format(&out, ImageFormat::Png).expect("a PNG")
}

fn size(input: &[u8]) -> (u32, u32) {
    let image = prepared(input);
    assert!(
        matches!(image, DynamicImage::ImageLuma8(_)),
        "grey without alpha: {:?}",
        image.color()
    );
    (image.width(), image.height())
}

#[test]
fn small_images_are_read_at_twice_their_size_and_large_ones_at_most_4000() {
    let fixture = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../memry-ml-worker/tests/fixtures/ocr-reader.fixture.png"),
    )
    .unwrap();
    assert_eq!(size(&fixture), (1440, 240));
    assert_eq!(size(&grey_rgb(333, 7)), (666, 14));
    assert_eq!(size(&grey_rgb(1599, 10)), (3198, 20));
    assert_eq!(size(&grey_rgb(1599, 1599)), (3198, 3198));
    assert_eq!(size(&grey_rgb(1600, 10)), (1600, 10));
    assert_eq!(size(&grey_rgb(6000, 3000)), (4000, 2000));
}

#[test]
fn images_are_upright_grey_and_flattened_on_white() {
    // Stored 40x24 with orientation 6: upright it is 24x40, read at 48x80.
    let vectors: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/contracts/test-vectors/pixel-tensors.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let case = vectors["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "jpeg orientation 6 @140")
        .expect("the orientation case");
    let jpeg = base64::engine::general_purpose::STANDARD
        .decode(case["input"].as_str().unwrap())
        .unwrap();
    assert_eq!(size(&jpeg), (48, 80));

    let clear = png(RgbaImage::from_pixel(10, 10, Rgba([0, 0, 0, 0])).into());
    let image = prepared(&clear).into_luma8();
    assert_eq!(image.dimensions(), (20, 20));
    assert!(image.pixels().all(|pixel| pixel.0 == [255]), "white");

    let grey = prepared(&grey_rgb(4, 4)).into_luma8();
    assert!(grey.pixels().all(|pixel| pixel.0 == [128]), "{grey:?}");
}

#[test]
fn what_the_decode_refuses_is_not_read() {
    assert!(to_ocr_png(b"not an image").is_err());
}

fn engine(resource_dir: &Path) -> std::sync::Arc<OcrEngine> {
    // Never started: a read without its language data fails before it reaches the worker.
    let worker = WorkerHandle::new(WorkerPaths {
        program: PathBuf::from("no-such-worker"),
        pdfium_dir: PathBuf::new(),
    });
    OcrEngine::new(worker, resource_dir)
}

/// `assertLanguageData` (`ocr-engine.ts:47-56`): no English data, or data that does not match
/// its pin, fails the read at once.
#[test]
fn without_the_bundled_english_data_ocr_fails_at_once() {
    let image = grey_rgb(4, 4);
    let data = tempfile::tempdir().unwrap();

    let missing = tempfile::tempdir().unwrap();
    let error = engine(missing.path())
        .read(&image, data.path(), &[OcrLanguage::Eng])
        .unwrap_err();
    assert_eq!(error, "OCR language data is missing");

    let changed = tempfile::tempdir().unwrap();
    let pack = changed.path().join(BUNDLED_PACK);
    std::fs::create_dir_all(pack.parent().unwrap()).unwrap();
    std::fs::write(&pack, b"not the pinned pack").unwrap();
    let error = engine(changed.path())
        .read(&image, data.path(), &[OcrLanguage::Eng])
        .unwrap_err();
    assert_eq!(error, "OCR language data is missing");
    assert!(!data.path().join("eng.traineddata").exists());
}

/// The bundled pack matches its pin and is unpacked into the data dir before the worker is
/// called (here a worker that cannot start).
#[test]
fn the_bundled_english_data_is_unpacked_for_the_worker() {
    let resources =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop-tauri/src-tauri/resources");
    let data = tempfile::tempdir().unwrap();
    let error = engine(&resources)
        .read(&grey_rgb(4, 4), data.path(), &[OcrLanguage::Eng])
        .unwrap_err();
    assert_ne!(error, "OCR language data is missing");
    let unpacked = std::fs::metadata(data.path().join("eng.traineddata")).unwrap();
    assert!(unpacked.len() > 1_000_000, "{}", unpacked.len());
}
