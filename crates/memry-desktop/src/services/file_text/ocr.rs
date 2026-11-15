//! OCR of a vault image or a scanned PDF page: the image is prepared here, in process, and
//! Tesseract reads it in the `memry-ml-worker` sidecar. Port of Electron's `toOcrPng`
//! (`apps/desktop/src/main/file-text/ocr-reader.ts:6-25`) and of `recognizeText`'s language data
//! check (`ocr-engine.ts:47-56,145-167`).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, GrayImage, ImageEncoder, Luma};
use memry_ml_worker::MAX_OCR_EDGE;

use super::WorkerHandle;
use super::runner::Recognize;
use crate::services::ocr_languages::{OcrLanguage, OcrLanguages, unpack};

/// Tesseract reads small type badly; a screenshot at 1x scale is read at 2x.
const UPSCALE_BELOW_EDGE: u32 = 1600;

/// The English pack the app ships, under the resource dir.
pub const BUNDLED_PACK: &str = "tessdata/eng.traineddata.gz";

/// The sha256 of [`BUNDLED_PACK`]: Electron's `resources/tessdata/eng.traineddata.gz`, byte for
/// byte.
pub const BUNDLED_PACK_SHA256: &str =
    "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91";

const MISSING_DATA: &str = "OCR language data is missing";

/// `toOcrPng`: upright, flattened onto white, grey, at most [`MAX_OCR_EDGE`] on its long edge and
/// twice its size when the long edge is under [`UPSCALE_BELOW_EDGE`], as PNG. The decode is
/// `memry_media`'s, with its size guards; an image it refuses is not read.
pub fn to_ocr_png(image: &[u8]) -> Result<Vec<u8>, String> {
    let fitted = memry_media::decode_fit(image, MAX_OCR_EDGE).map_err(|error| error.to_string())?;
    let rgba = fitted.image.into_rgba8();
    let mut grey = GrayImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let on_white = |sample: u8| {
            let mixed = u32::from(sample) * u32::from(a) + 255 * (255 - u32::from(a));
            ((mixed + 127) / 255) as f32
        };
        // Rec. 709 luma of the sRGB samples, as `image`'s `to_luma8` weighs them.
        let luma = 0.2126 * on_white(r) + 0.7152 * on_white(g) + 0.0722 * on_white(b);
        Luma([luma.round().clamp(0.0, 255.0) as u8])
    });
    if fitted.width.max(fitted.height) < UPSCALE_BELOW_EDGE {
        grey = image::imageops::resize(
            &grey,
            grey.width() * 2,
            grey.height() * 2,
            FilterType::Lanczos3,
        );
    }
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(
            grey.as_raw(),
            grey.width(),
            grey.height(),
            ExtendedColorType::L8,
        )
        .map_err(|error| error.to_string())?;
    Ok(png)
}

/// Reads images through the worker with the English data the app ships, unpacked into the
/// Tesseract data dir of the languages it reads with.
pub struct OcrEngine {
    worker: Arc<WorkerHandle>,
    bundled_pack: PathBuf,
    reported_missing: AtomicBool,
}

impl OcrEngine {
    /// `resource_dir` holds [`BUNDLED_PACK`].
    pub fn new(worker: Arc<WorkerHandle>, resource_dir: &Path) -> Arc<Self> {
        Arc::new(Self {
            worker,
            bundled_pack: resource_dir.join(BUNDLED_PACK),
            reported_missing: AtomicBool::new(false),
        })
    }

    /// The text in `image` read with `languages`, whose data `datapath` holds except English,
    /// which this unpacks there. Without English data that matches its pin the read fails at
    /// once, logged once per run (`assertLanguageData`). Blocking.
    pub fn read(
        &self,
        image: &[u8],
        datapath: &Path,
        languages: &[OcrLanguage],
    ) -> Result<String, String> {
        if let Err(error) = unpack(
            datapath,
            OcrLanguage::BUNDLED,
            &self.bundled_pack,
            BUNDLED_PACK_SHA256,
        ) {
            if !self.reported_missing.swap(true, Ordering::SeqCst) {
                tracing::error!(
                    scope = "Ocr",
                    pack = %self.bundled_pack.display(),
                    %error,
                    "OCR language data is missing; scanned pages and images stay unread"
                );
            }
            return Err(MISSING_DATA.to_owned());
        }
        let png = to_ocr_png(image)?;
        let codes: Vec<String> = languages.iter().map(|l| l.code().to_owned()).collect();
        self.worker
            .recognize(datapath, &codes, png)
            .map_err(|error| error.to_string())
    }

    /// The runner's OCR: every language `languages` has ready now (`ocrLanguageSet`).
    pub fn recognizer(self: &Arc<Self>, languages: Arc<OcrLanguages>) -> Recognize {
        let engine = self.clone();
        Arc::new(move |image| {
            let ready = languages.ready();
            let datapath = languages
                .datapath(&ready)
                .map_err(|error| error.to_string())?;
            engine.read(image, &datapath, &ready)
        })
    }
}
