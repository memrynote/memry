//! The typed OCR call over a [`Supervisor`], the worker side of Electron's `recognizeText`
//! (`apps/desktop/src/main/file-text/ocr-engine.ts:145-167`). A read past
//! [`Limits::ocr_timeout`](crate::Limits::ocr_timeout) kills the child.

use std::path::Path;

use crate::op::{Request, Response};
use crate::supervisor::{Supervisor, WorkerError};

impl Supervisor {
    /// The text Tesseract reads in `png`, a prepared image (upright, grey, at most
    /// [`MAX_OCR_EDGE`](crate::MAX_OCR_EDGE) on its long edge), with the `.traineddata` of every
    /// language in `languages` from `datapath`.
    pub fn recognize(
        &self,
        datapath: &Path,
        languages: &[String],
        png: Vec<u8>,
    ) -> Result<String, WorkerError> {
        let datapath = datapath.to_str().ok_or_else(|| {
            WorkerError::Failed(format!("{} is not valid UTF-8", datapath.display()))
        })?;
        let request = Request::Ocr {
            datapath: datapath.into(),
            languages: languages.to_vec(),
            png,
        };
        match self.call(&request)? {
            Response::Text(text) => Ok(text),
            other => Err(WorkerError::Protocol(format!(
                "unexpected answer {}",
                other.name()
            ))),
        }
    }
}
