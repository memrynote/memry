//! The PDF ops on pdfium: page count, a page's text layer, a page rendered to PNG. Ports the
//! hidden PDF host page of the Electron app (`apps/desktop/src/renderer/src/pdf-host/main.ts`).
//! pdfium reads the file through a seekable reader, so a scan of several hundred megabytes is
//! never held in memory whole, as the Electron host's range transport did.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;

use image::ImageFormat;
use memry_ml_worker::{MAX_RENDER_EDGE, Request, Response};
use pdfium_render::prelude::{PdfDocument, PdfRenderConfig, Pdfium};

/// Rendering past 300 DPI makes bigger PNGs without clearer text (`main.ts:15-16`).
const MAX_SCALE: f32 = 300.0 / 72.0;

pub struct Pdfs {
    dir: PathBuf,
    /// Bound on the first PDF op. Leaked: it lives as long as the process, and every open
    /// document borrows it.
    pdfium: Option<&'static Pdfium>,
    docs: HashMap<u32, PdfDocument<'static>>,
    next_doc: u32,
}

impl Pdfs {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            pdfium: None,
            docs: HashMap::new(),
            next_doc: 0,
        }
    }

    pub fn handle(&mut self, request: Request) -> Response {
        let outcome = match request {
            Request::PdfOpen { path } => self.open(&path),
            Request::PdfPageText { doc, page } => self.page_text(doc, page),
            Request::PdfRenderPage {
                doc,
                page,
                max_edge,
            } => self.render_page(doc, page, max_edge),
            Request::PdfClose { doc } => {
                self.docs.remove(&doc);
                Ok(Response::Done)
            }
            Request::Shutdown => Ok(Response::Done),
        };
        outcome.unwrap_or_else(Response::Failed)
    }

    fn pdfium(&mut self) -> Result<&'static Pdfium, String> {
        if let Some(pdfium) = self.pdfium {
            return Ok(pdfium);
        }
        let library = Pdfium::pdfium_platform_library_name_at_path(&self.dir);
        let bindings = Pdfium::bind_to_library(&library).map_err(|error| {
            format!(
                "pdfium could not be loaded from {}: {error}",
                library.display()
            )
        })?;
        let pdfium: &'static Pdfium = Box::leak(Box::new(Pdfium::new(bindings)));
        self.pdfium = Some(pdfium);
        Ok(pdfium)
    }

    fn open(&mut self, path: &str) -> Result<Response, String> {
        let pdfium = self.pdfium()?;
        let document = pdfium
            .load_pdf_from_file(path, None)
            .map_err(|error| format!("the PDF could not be opened: {error}"))?;
        let page_count = u32::try_from(document.pages().len()).unwrap_or(0);
        self.next_doc = self.next_doc.wrapping_add(1);
        self.docs.insert(self.next_doc, document);
        Ok(Response::PdfOpened {
            doc: self.next_doc,
            page_count,
        })
    }

    fn document(&self, doc: u32) -> Result<&PdfDocument<'static>, String> {
        self.docs
            .get(&doc)
            .ok_or_else(|| format!("PDF {doc} is not open"))
    }

    fn page_text(&self, doc: u32, page: u32) -> Result<Response, String> {
        let document = self.document(doc)?;
        let page = document
            .pages()
            .get(page_index(document, page)?)
            .map_err(|e| e.to_string())?;
        let text = page.text().map_err(|e| e.to_string())?.all();
        Ok(Response::Text(text.replace("\r\n", "\n")))
    }

    fn render_page(&self, doc: u32, page: u32, max_edge: u32) -> Result<Response, String> {
        if max_edge == 0 || max_edge > MAX_RENDER_EDGE {
            return Err(format!(
                "max edge {max_edge} is outside 1..={MAX_RENDER_EDGE}"
            ));
        }
        let document = self.document(doc)?;
        let page = document
            .pages()
            .get(page_index(document, page)?)
            .map_err(|e| e.to_string())?;
        let long_edge = page.width().value.max(page.height().value);
        if !long_edge.is_finite() || long_edge <= 0.0 {
            return Err("the page has no size".into());
        }
        let scale = MAX_SCALE.min(max_edge as f32 / long_edge);
        let bitmap = page
            .render_with_config(&PdfRenderConfig::new().scale_page_by_factor(scale))
            .map_err(|error| format!("page could not be rendered: {error}"))?;
        let image = bitmap.as_image().map_err(|e| e.to_string())?;
        let mut png = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .map_err(|error| format!("page could not be encoded: {error}"))?;
        Ok(Response::Rendered {
            width: image.width(),
            height: image.height(),
            png,
        })
    }
}

fn page_index(document: &PdfDocument<'_>, page: u32) -> Result<i32, String> {
    let count = document.pages().len();
    match i32::try_from(page) {
        Ok(page) if (1..=count).contains(&page) => Ok(page - 1),
        _ => Err(format!("page {page} is outside 1..={count}")),
    }
}
