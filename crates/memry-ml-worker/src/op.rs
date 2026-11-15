//! The ops the app sends and the answers the worker gives, and their payloads inside a
//! [`Frame`]. Every number is a big-endian `u32`; a string is its length then its UTF-8 bytes.
//! An unknown op code, a payload of the wrong size and invalid UTF-8 are errors, never guesses.

use crate::frame::Frame;

/// The largest long edge, in pixels, a page is rendered at.
pub const MAX_RENDER_EDGE: u32 = 4000;
/// The largest long edge, in pixels, of an image OCR reads: the app's OCR prep caps it there
/// (`ocr-reader.ts:8`).
pub const MAX_OCR_EDGE: u32 = 4000;
/// More languages than the app has (English and the 31 it downloads) are refused.
pub const MAX_OCR_LANGUAGES: u32 = 32;

/// The width of a stored embedding (`memry_ml::EMBEDDING_DIMENSION`); an `Embedded` answer holds
/// exactly this many `f32`s.
pub const EMBEDDING_DIMENSION: usize = 256;
/// The longest text an `EmbedText` or `EmbedImage` request carries, in UTF-8 bytes. The model
/// reads the first 4000 UTF-16 units (at most 12,000 bytes), so a longer text is a caller bug.
pub const MAX_EMBED_TEXT_BYTES: usize = 1 << 20;
/// The largest image an `EmbedImage` request carries (`memry_ml::image_prep::MAX_IMAGE_BYTES`).
pub const MAX_EMBED_IMAGE_BYTES: usize = 30 << 20;
/// The most files a `ModelManifest` answer lists, and the longest string in it.
const MAX_MANIFEST_FILES: u32 = 16;
const MAX_MANIFEST_STRING: usize = 256;
/// The longest `Failed` message, in UTF-8 bytes: the worker cuts a longer one, the app refuses it.
pub const MAX_FAILED_MESSAGE: usize = 4096;

/// The model repo and revision the app downloads from (`memry_ml::MODEL_REPO`,
/// `MODEL_REVISION`; the worker binary asserts they are equal at compile time). The app refuses a
/// manifest that names another, so a worker cannot point the download elsewhere.
pub const MODEL_REPO: &str = "onnx-community/embeddinggemma-2-ONNX";
pub const MODEL_REVISION: &str = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";

const PDF_OPEN: u8 = 0x01;
const PDF_PAGE_TEXT: u8 = 0x02;
const PDF_RENDER_PAGE: u8 = 0x03;
const PDF_CLOSE: u8 = 0x04;
const SHUTDOWN: u8 = 0x0f;
const EMBED_LOAD: u8 = 0x10;
const EMBED_TEXT: u8 = 0x11;
const EMBED_IMAGE: u8 = 0x12;
const MODEL_MANIFEST: u8 = 0x13;
/// Past the embedding ops (0x10 to 0x13, #4701) and the audio ops (0x14 to 0x16, #4742). Its
/// answer is `TEXT` (0x82), so it adds no answer code.
const OCR: u8 = 0x17;

const READY: u8 = 0x80;
const PDF_OPENED: u8 = 0x81;
const TEXT: u8 = 0x82;
const RENDERED: u8 = 0x83;
const DONE: u8 = 0x84;
const EMBEDDED: u8 = 0x85;
const MANIFEST: u8 = 0x86;
const FAILED: u8 = 0xff;

/// The model files that load together (`memry_ml::ModelGroup`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelGroup {
    Text,
    Vision,
    Audio,
}

impl ModelGroup {
    fn code(self) -> u32 {
        match self {
            Self::Text => 0,
            Self::Vision => 1,
            Self::Audio => 2,
        }
    }

    fn from_code(code: u32) -> Option<Self> {
        Some(match code {
            0 => Self::Text,
            1 => Self::Vision,
            2 => Self::Audio,
            _ => return None,
        })
    }
}

/// One pinned model file, `path` relative to the model directory with `/` separators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// The pinned files of a model group and where they are served (`memry_ml::files`), which the
/// app downloads and hashes before the worker loads them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub repo: String,
    pub revision: String,
    pub files: Vec<ManifestFile>,
}

/// Pages are numbered from 1, as in the Electron PDF host (`pdf-host.ts:35-37`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    PdfOpen {
        path: String,
    },
    PdfPageText {
        doc: u32,
        page: u32,
    },
    PdfRenderPage {
        doc: u32,
        page: u32,
        max_edge: u32,
    },
    PdfClose {
        doc: u32,
    },
    /// The text Tesseract reads in a PNG, with the models of `languages` (Tesseract codes such as
    /// `eng` and `chi_sim`) from the plain `.traineddata` files in `datapath`. Answered with
    /// [`Response::Text`].
    Ocr {
        datapath: String,
        languages: Vec<String>,
        png: Vec<u8>,
    },
    Shutdown,
    /// Loads the text model from the worker's `--model-cache`, unless it is loaded.
    EmbedLoad,
    /// The text's embedding, the text model loaded first when it is not.
    EmbedText {
        text: String,
    },
    /// The image's embedding, alone or at the `<|image|>` placeholder of `text`, with
    /// `soft_tokens` (the engine's default when `None`).
    EmbedImage {
        bytes: Vec<u8>,
        text: Option<String>,
        soft_tokens: Option<u32>,
    },
    ModelManifest {
        group: ModelGroup,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Response {
    /// Sent once, with id 0, when the worker is ready for requests.
    Ready,
    PdfOpened {
        doc: u32,
        page_count: u32,
    },
    Text(String),
    /// A PNG, its long edge at most the requested edge and never past 300 DPI.
    Rendered {
        width: u32,
        height: u32,
        png: Vec<u8>,
    },
    Done,
    /// [`EMBEDDING_DIMENSION`] values.
    Embedded(Vec<f32>),
    Manifest(Manifest),
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpError {
    #[error("unknown op code {0:#04x}")]
    UnknownOp(u8),
    #[error("malformed payload for op {0:#04x}")]
    Malformed(u8),
    #[error("a field of op {0:#04x} is over its cap")]
    TooLarge(u8),
}

impl Request {
    pub fn to_frame(&self, id: u32) -> Frame {
        let mut out = Vec::new();
        let op = match self {
            Self::PdfOpen { path } => {
                put_str(&mut out, path);
                PDF_OPEN
            }
            Self::PdfPageText { doc, page } => {
                put_u32s(&mut out, &[*doc, *page]);
                PDF_PAGE_TEXT
            }
            Self::PdfRenderPage {
                doc,
                page,
                max_edge,
            } => {
                put_u32s(&mut out, &[*doc, *page, *max_edge]);
                PDF_RENDER_PAGE
            }
            Self::PdfClose { doc } => {
                put_u32s(&mut out, &[*doc]);
                PDF_CLOSE
            }
            Self::Ocr {
                datapath,
                languages,
                png,
            } => {
                put_str(&mut out, datapath);
                put_u32s(
                    &mut out,
                    &[u32::try_from(languages.len()).unwrap_or(u32::MAX)],
                );
                for language in languages {
                    put_str(&mut out, language);
                }
                out.extend_from_slice(png);
                OCR
            }
            Self::Shutdown => SHUTDOWN,
            Self::EmbedLoad => EMBED_LOAD,
            Self::EmbedText { text } => {
                put_str(&mut out, text);
                EMBED_TEXT
            }
            Self::EmbedImage {
                bytes,
                text,
                soft_tokens,
            } => {
                put_u32s(
                    &mut out,
                    &[soft_tokens.unwrap_or(0), u32::from(text.is_some())],
                );
                if let Some(text) = text {
                    put_str(&mut out, text);
                }
                out.extend_from_slice(bytes);
                EMBED_IMAGE
            }
            Self::ModelManifest { group } => {
                put_u32s(&mut out, &[group.code()]);
                MODEL_MANIFEST
            }
        };
        Frame {
            op,
            id,
            payload: out,
        }
    }

    pub fn from_frame(frame: &Frame) -> Result<Self, OpError> {
        let op = frame.op;
        let mut r = Reader::new(&frame.payload, op);
        let request = match op {
            PDF_OPEN => Self::PdfOpen { path: r.string()? },
            PDF_PAGE_TEXT => Self::PdfPageText {
                doc: r.u32()?,
                page: r.u32()?,
            },
            PDF_RENDER_PAGE => Self::PdfRenderPage {
                doc: r.u32()?,
                page: r.u32()?,
                max_edge: r.u32()?,
            },
            PDF_CLOSE => Self::PdfClose { doc: r.u32()? },
            OCR => {
                let datapath = r.string()?;
                let count = r.u32()?;
                if count > MAX_OCR_LANGUAGES {
                    return Err(OpError::Malformed(op));
                }
                let languages = (0..count).map(|_| r.string()).collect::<Result<_, _>>()?;
                Self::Ocr {
                    datapath,
                    languages,
                    png: r.rest(),
                }
            }
            SHUTDOWN => Self::Shutdown,
            EMBED_LOAD => Self::EmbedLoad,
            EMBED_TEXT => Self::EmbedText {
                text: r.string_within(MAX_EMBED_TEXT_BYTES)?,
            },
            EMBED_IMAGE => {
                let soft_tokens = Some(r.u32()?).filter(|&n| n != 0);
                let text = match r.u32()? {
                    0 => None,
                    1 => Some(r.string_within(MAX_EMBED_TEXT_BYTES)?),
                    _ => return Err(OpError::Malformed(op)),
                };
                Self::EmbedImage {
                    bytes: r.rest_within(MAX_EMBED_IMAGE_BYTES)?,
                    text,
                    soft_tokens,
                }
            }
            MODEL_MANIFEST => Self::ModelManifest {
                group: ModelGroup::from_code(r.u32()?).ok_or(OpError::Malformed(op))?,
            },
            other => return Err(OpError::UnknownOp(other)),
        };
        r.end()?;
        Ok(request)
    }

    /// The op's name in logs and errors.
    pub fn name(&self) -> &'static str {
        match self {
            Self::PdfOpen { .. } => "pdf-open",
            Self::PdfPageText { .. } => "pdf-page-text",
            Self::PdfRenderPage { .. } => "pdf-render-page",
            Self::PdfClose { .. } => "pdf-close",
            Self::Ocr { .. } => "ocr",
            Self::Shutdown => "shutdown",
            Self::EmbedLoad => "embed-load",
            Self::EmbedText { .. } => "embed-text",
            Self::EmbedImage { .. } => "embed-image",
            Self::ModelManifest { .. } => "model-manifest",
        }
    }
}

impl Response {
    /// The answer's name in logs and errors, never its payload, which holds a file's content.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::PdfOpened { .. } => "pdf-opened",
            Self::Text(_) => "text",
            Self::Rendered { .. } => "rendered",
            Self::Done => "done",
            Self::Embedded(_) => "embedded",
            Self::Manifest(_) => "manifest",
            Self::Failed(_) => "failed",
        }
    }

    pub fn to_frame(&self, id: u32) -> Frame {
        let mut out = Vec::new();
        let op = match self {
            Self::Ready => READY,
            Self::PdfOpened { doc, page_count } => {
                put_u32s(&mut out, &[*doc, *page_count]);
                PDF_OPENED
            }
            Self::Text(text) => {
                put_str(&mut out, text);
                TEXT
            }
            Self::Rendered { width, height, png } => {
                put_u32s(&mut out, &[*width, *height]);
                out.extend_from_slice(png);
                RENDERED
            }
            Self::Done => DONE,
            Self::Embedded(values) => {
                for value in values {
                    out.extend_from_slice(&value.to_be_bytes());
                }
                EMBEDDED
            }
            Self::Manifest(manifest) => {
                put_str(&mut out, &manifest.repo);
                put_str(&mut out, &manifest.revision);
                put_u32s(
                    &mut out,
                    &[u32::try_from(manifest.files.len()).unwrap_or(u32::MAX)],
                );
                for file in &manifest.files {
                    put_str(&mut out, &file.path);
                    out.extend_from_slice(&file.size.to_be_bytes());
                    put_str(&mut out, &file.sha256);
                }
                MANIFEST
            }
            Self::Failed(message) => {
                put_str(&mut out, cut(message, MAX_FAILED_MESSAGE));
                FAILED
            }
        };
        Frame {
            op,
            id,
            payload: out,
        }
    }

    pub fn from_frame(frame: &Frame) -> Result<Self, OpError> {
        let op = frame.op;
        let mut r = Reader::new(&frame.payload, op);
        let response = match op {
            READY => Self::Ready,
            PDF_OPENED => Self::PdfOpened {
                doc: r.u32()?,
                page_count: r.u32()?,
            },
            TEXT => Self::Text(r.string()?),
            RENDERED => Self::Rendered {
                width: r.u32()?,
                height: r.u32()?,
                png: r.rest(),
            },
            DONE => Self::Done,
            EMBEDDED => {
                let mut values = Vec::with_capacity(EMBEDDING_DIMENSION);
                for _ in 0..EMBEDDING_DIMENSION {
                    values.push(f32::from_bits(r.u32()?));
                }
                Self::Embedded(values)
            }
            MANIFEST => {
                let repo = r.string_within(MAX_MANIFEST_STRING)?;
                let revision = r.string_within(MAX_MANIFEST_STRING)?;
                let count = r.u32()?;
                if count > MAX_MANIFEST_FILES {
                    return Err(OpError::Malformed(op));
                }
                let mut files = Vec::new();
                for _ in 0..count {
                    files.push(ManifestFile {
                        path: r.string_within(MAX_MANIFEST_STRING)?,
                        size: r.u64()?,
                        sha256: r.string_within(MAX_MANIFEST_STRING)?,
                    });
                }
                Self::Manifest(Manifest {
                    repo,
                    revision,
                    files,
                })
            }
            FAILED => Self::Failed(r.string_within(MAX_FAILED_MESSAGE)?),
            other => return Err(OpError::UnknownOp(other)),
        };
        r.end()?;
        Ok(response)
    }
}

fn put_u32s(out: &mut Vec<u8>, values: &[u32]) {
    for value in values {
        out.extend_from_slice(&value.to_be_bytes());
    }
}

/// The longest prefix of `text` of at most `max` bytes that ends on a character boundary.
fn cut(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn put_str(out: &mut Vec<u8>, value: &str) {
    // A frame body is capped far below `u32::MAX`; `write_frame` refuses a longer one.
    put_u32s(out, &[u32::try_from(value.len()).unwrap_or(u32::MAX)]);
    out.extend_from_slice(value.as_bytes());
}

struct Reader<'a> {
    rest: &'a [u8],
    op: u8,
}

impl<'a> Reader<'a> {
    fn new(payload: &'a [u8], op: u8) -> Self {
        Self { rest: payload, op }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], OpError> {
        if self.rest.len() < n {
            return Err(OpError::Malformed(self.op));
        }
        let (head, tail) = self.rest.split_at(n);
        self.rest = tail;
        Ok(head)
    }

    fn u32(&mut self) -> Result<u32, OpError> {
        let bytes = self.take(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn u64(&mut self) -> Result<u64, OpError> {
        Ok((u64::from(self.u32()?) << 32) | u64::from(self.u32()?))
    }

    fn string(&mut self) -> Result<String, OpError> {
        self.string_within(usize::MAX)
    }

    /// A string of at most `cap` bytes; a longer one is refused before it is copied.
    fn string_within(&mut self, cap: usize) -> Result<String, OpError> {
        let len = self.u32()? as usize;
        if len > cap {
            return Err(OpError::TooLarge(self.op));
        }
        let bytes = self.take(len)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| OpError::Malformed(self.op))
    }

    fn rest(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rest).to_vec()
    }

    /// The rest of the payload, refused before it is copied when it is over `cap` bytes.
    fn rest_within(&mut self, cap: usize) -> Result<Vec<u8>, OpError> {
        if self.rest.len() > cap {
            return Err(OpError::TooLarge(self.op));
        }
        Ok(self.rest())
    }

    fn end(&self) -> Result<(), OpError> {
        if self.rest.is_empty() {
            Ok(())
        } else {
            Err(OpError::Malformed(self.op))
        }
    }
}
