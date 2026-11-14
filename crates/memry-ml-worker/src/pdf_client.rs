//! The typed PDF calls over a [`Supervisor`], the shape of the Electron host's `PdfDocument`
//! (`apps/desktop/src/main/file-text/pdf-host.ts:26-39`). A document lives in one worker: after
//! the worker restarts, its calls fail with "not open" and the caller opens the file again.

use std::path::Path;

use crate::op::{Request, Response};
use crate::supervisor::{Supervisor, WorkerError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedPage {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub struct PdfDocument<'a> {
    worker: &'a Supervisor,
    doc: u32,
    page_count: u32,
}

impl Supervisor {
    pub fn open_pdf(&self, path: &Path) -> Result<PdfDocument<'_>, WorkerError> {
        let path = path
            .to_str()
            .ok_or_else(|| WorkerError::Failed(format!("{} is not valid UTF-8", path.display())))?;
        match self.call(&Request::PdfOpen { path: path.into() })? {
            Response::PdfOpened { doc, page_count } => Ok(PdfDocument {
                worker: self,
                doc,
                page_count,
            }),
            other => Err(unexpected(&other)),
        }
    }
}

impl PdfDocument<'_> {
    pub fn page_count(&self) -> u32 {
        self.page_count
    }

    /// The page's text layer, empty for a scanned page. Pages count from 1.
    pub fn page_text(&self, page: u32) -> Result<String, WorkerError> {
        match self.worker.call(&Request::PdfPageText {
            doc: self.doc,
            page,
        })? {
            Response::Text(text) => Ok(text),
            other => Err(unexpected(&other)),
        }
    }

    /// The page as PNG, its long edge at most `max_edge` px and never past 300 DPI.
    pub fn render_page(&self, page: u32, max_edge: u32) -> Result<RenderedPage, WorkerError> {
        match self.worker.call(&Request::PdfRenderPage {
            doc: self.doc,
            page,
            max_edge,
        })? {
            Response::Rendered { width, height, png } => Ok(RenderedPage { png, width, height }),
            other => Err(unexpected(&other)),
        }
    }

    pub fn close(self) -> Result<(), WorkerError> {
        match self.worker.call(&Request::PdfClose { doc: self.doc })? {
            Response::Done => Ok(()),
            other => Err(unexpected(&other)),
        }
    }
}

fn unexpected(response: &Response) -> WorkerError {
    WorkerError::Protocol(format!("unexpected answer {response:?}"))
}
