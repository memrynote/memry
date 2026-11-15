//! The OCR op on Tesseract 5.5.2 (LSTM only), linked statically by `build.rs`. Ports the Electron
//! OCR worker (`apps/desktop/src/main/file-text/ocr-reader.ts:27-57`, tesseract.js): one engine for
//! the current languages, started on the first read and started again when they change.
//!
//! The image is a PNG the app prepared (upright, grey, flattened on white, at most
//! [`MAX_OCR_EDGE`]); it is decoded here, in the worker, into the grey bytes Tesseract reads, as
//! tesseract.js handed Leptonica the PNG. Tesseract runs with its own default page segmentation
//! (`PSM_SINGLE_BLOCK`), which tesseract.js keeps too.

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::io::Cursor;

use image::{ImageFormat, ImageReader, Limits};
use memry_ml_worker::{MAX_OCR_EDGE, Response};

/// `OEM_LSTM_ONLY` (`OEM.LSTM_ONLY` in `ocr-reader.ts:36`).
const OEM_LSTM_ONLY: c_int = 1;
/// `PSM_SINGLE_BLOCK`, Tesseract's default for the API (`tessedit_pageseg_mode`).
const PSM_SINGLE_BLOCK: c_int = 6;

#[allow(non_snake_case)]
unsafe extern "C" {
    fn TessBaseAPICreate() -> *mut c_void;
    fn TessBaseAPIDelete(handle: *mut c_void);
    fn TessBaseAPIInit2(
        handle: *mut c_void,
        datapath: *const c_char,
        language: *const c_char,
        oem: c_int,
    ) -> c_int;
    fn TessBaseAPISetPageSegMode(handle: *mut c_void, mode: c_int);
    fn TessBaseAPISetImage(
        handle: *mut c_void,
        data: *const u8,
        width: c_int,
        height: c_int,
        bytes_per_pixel: c_int,
        bytes_per_line: c_int,
    );
    fn TessBaseAPIRecognize(handle: *mut c_void, monitor: *mut c_void) -> c_int;
    fn TessBaseAPIGetUTF8Text(handle: *mut c_void) -> *mut c_char;
    fn TessBaseAPIClear(handle: *mut c_void);
    fn TessDeleteText(text: *mut c_char);
}

/// One initialised `TessBaseAPI`.
struct Engine(*mut c_void);

impl Engine {
    /// Tesseract opens `<datapath>/<lang>.traineddata` with narrow `fopen`, which MSVC reads in
    /// the ANSI code page, so a profile dir like `C:\Users\Çağrı` would never open. The worker
    /// moves into `datapath` with the wide-character API and hands Tesseract `.`; Init2 reads
    /// every language's data before it returns. No other path in the worker is relative.
    fn new(datapath: &str, languages: &str) -> Result<Self, String> {
        let langs = CString::new(languages).map_err(|_| "a language holds a NUL byte")?;
        std::env::set_current_dir(datapath)
            .map_err(|error| format!("the OCR data dir could not be opened: {error}"))?;
        // SAFETY: Create returns an owned handle, freed by `Drop`; Init2 reads the two C strings,
        // which outlive the call.
        let engine = Self(unsafe { TessBaseAPICreate() });
        if engine.0.is_null() {
            return Err("Tesseract could not start".into());
        }
        if unsafe { TessBaseAPIInit2(engine.0, c".".as_ptr(), langs.as_ptr(), OEM_LSTM_ONLY) } != 0
        {
            return Err(format!("Tesseract could not load {languages}"));
        }
        // SAFETY: the handle is initialised.
        unsafe { TessBaseAPISetPageSegMode(engine.0, PSM_SINGLE_BLOCK) };
        Ok(engine)
    }

    fn read(&self, grey: &[u8], width: u32, height: u32) -> Result<String, String> {
        let (w, h) = (width as c_int, height as c_int);
        // SAFETY: `grey` holds `width * height` bytes, one a pixel, rows `width` apart, and
        // outlives Recognize; Clear drops Tesseract's copy and results before it is freed.
        unsafe {
            TessBaseAPISetImage(self.0, grey.as_ptr(), w, h, 1, w);
            let outcome = if TessBaseAPIRecognize(self.0, std::ptr::null_mut()) != 0 {
                Err("Tesseract could not read the image".to_owned())
            } else {
                let text = TessBaseAPIGetUTF8Text(self.0);
                if text.is_null() {
                    Err("Tesseract returned no text".to_owned())
                } else {
                    let read = CStr::from_ptr(text).to_string_lossy().into_owned();
                    TessDeleteText(text);
                    Ok(read)
                }
            };
            TessBaseAPIClear(self.0);
            outcome
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // SAFETY: the handle came from Create and is freed once.
        unsafe { TessBaseAPIDelete(self.0) };
    }
}

/// The engine of the last languages read with, kept for the next image.
#[derive(Default)]
pub struct Ocr {
    engine: Option<(String, String, Engine)>,
}

impl Ocr {
    pub fn handle(&mut self, datapath: &str, languages: &[String], png: &[u8]) -> Response {
        self.read(datapath, languages, png)
            .map_or_else(Response::Failed, Response::Text)
    }

    fn read(&mut self, datapath: &str, languages: &[String], png: &[u8]) -> Result<String, String> {
        let languages = language_string(languages)?;
        let (grey, width, height) = decode(png)?;
        let current = self
            .engine
            .as_ref()
            .is_some_and(|(path, langs, _)| path == datapath && *langs == languages);
        if !current {
            self.engine = None;
            let engine = Engine::new(datapath, &languages)?;
            self.engine = Some((datapath.to_owned(), languages, engine));
        }
        let (_, _, engine) = self.engine.as_ref().expect("set above");
        engine.read(&grey, width, height)
    }
}

/// `eng+deu`: Tesseract's form for several languages. A code is lower-case ASCII letters and `_`,
/// so it names a file inside the data path and nothing outside it.
fn language_string(languages: &[String]) -> Result<String, String> {
    if languages.is_empty() {
        return Err("no OCR language".into());
    }
    for code in languages {
        let valid = !code.is_empty()
            && code.len() <= 16
            && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
        if !valid {
            return Err(format!("{code:?} is not an OCR language code"));
        }
    }
    Ok(languages.join("+"))
}

/// The PNG's pixels as 8-bit grey, refused past [`MAX_OCR_EDGE`] before the decoder allocates.
fn decode(png: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_OCR_EDGE);
    limits.max_image_height = Some(MAX_OCR_EDGE);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| format!("the OCR image could not be decoded: {error}"))?
        .into_luma8();
    let (width, height) = image.dimensions();
    Ok((image.into_raw(), width, height))
}
