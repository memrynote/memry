//! The ops the app sends and the answers the worker gives, and their payloads inside a
//! [`Frame`]. Every number is a big-endian `u32`; a string is its length then its UTF-8 bytes.
//! An unknown op code, a payload of the wrong size and invalid UTF-8 are errors, never guesses.

use crate::frame::Frame;

/// The largest long edge, in pixels, a page is rendered at.
pub const MAX_RENDER_EDGE: u32 = 4000;

const PDF_OPEN: u8 = 0x01;
const PDF_PAGE_TEXT: u8 = 0x02;
const PDF_RENDER_PAGE: u8 = 0x03;
const PDF_CLOSE: u8 = 0x04;
const SHUTDOWN: u8 = 0x0f;

const READY: u8 = 0x80;
const PDF_OPENED: u8 = 0x81;
const TEXT: u8 = 0x82;
const RENDERED: u8 = 0x83;
const DONE: u8 = 0x84;
const FAILED: u8 = 0xff;

/// Pages are numbered from 1, as in the Electron PDF host (`pdf-host.ts:35-37`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    PdfOpen { path: String },
    PdfPageText { doc: u32, page: u32 },
    PdfRenderPage { doc: u32, page: u32, max_edge: u32 },
    PdfClose { doc: u32 },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpError {
    #[error("unknown op code {0:#04x}")]
    UnknownOp(u8),
    #[error("malformed payload for op {0:#04x}")]
    Malformed(u8),
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
            Self::Shutdown => SHUTDOWN,
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
            SHUTDOWN => Self::Shutdown,
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
            Self::Shutdown => "shutdown",
        }
    }
}

impl Response {
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
            Self::Failed(message) => {
                put_str(&mut out, message);
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
            FAILED => Self::Failed(r.string()?),
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

    fn string(&mut self) -> Result<String, OpError> {
        let len = self.u32()? as usize;
        let bytes = self.take(len)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| OpError::Malformed(self.op))
    }

    fn rest(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rest).to_vec()
    }

    fn end(&self) -> Result<(), OpError> {
        if self.rest.is_empty() {
            Ok(())
        } else {
            Err(OpError::Malformed(self.op))
        }
    }
}
