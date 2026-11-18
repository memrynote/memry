//! The `memry-export` scheme: serves the PDF export's document to its print window from memory.
//! Electron staged it in a temp file because Chromium refuses a long `data:` URL
//! (`ipc/notes-handlers.ts:1004-1009`); a scheme URL has no length limit and writes no file.
//! Only a `pdf-print-<n>` window is answered, and only while its export holds the page.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use memry_desktop::notes::print::PRINT_CSP;
use tauri::http::{Response, StatusCode, header};
use url::Url;
use uuid::Uuid;

use crate::windows::registry::WindowKind;

pub const EXPORT_SCHEME: &str = "memry-export";

static STAGED: LazyLock<Mutex<HashMap<Uuid, Arc<[u8]>>>> = LazyLock::new(Mutex::default);

fn staged() -> std::sync::MutexGuard<'static, HashMap<Uuid, Arc<[u8]>>> {
    STAGED.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A page the scheme serves until this is dropped.
pub struct Staged {
    id: Uuid,
}

impl Staged {
    pub fn new(html: String) -> Self {
        let id = Uuid::new_v4();
        staged().insert(id, Arc::from(html.into_bytes()));
        Self { id }
    }

    /// The page's URL as the engine loads it: WebView2 serves a scheme as
    /// `https://<scheme>.localhost` (`use_https_scheme`).
    pub fn url(&self) -> Url {
        let url = if cfg!(windows) {
            format!("https://{EXPORT_SCHEME}.localhost/{}.html", self.id)
        } else {
            format!("{EXPORT_SCHEME}://localhost/{}.html", self.id)
        };
        Url::parse(&url).expect("a scheme URL with a UUID path parses")
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        staged().remove(&self.id);
    }
}

/// The answer to `uri`, asked by the webview `label`: the staged page with a CSP that runs no
/// script and loads nothing from outside the document, or 404.
pub fn answer(label: &str, uri: &str) -> Response<Cow<'static, [u8]>> {
    let page = (WindowKind::of_label(label) == Some(WindowKind::PdfPrint))
        .then(|| Url::parse(uri).ok())
        .flatten()
        .and_then(|url| {
            let name = url.path().strip_prefix('/')?.strip_suffix(".html")?;
            Uuid::parse_str(name).ok()
        })
        .and_then(|id| staged().get(&id).cloned());
    let Some(page) = page else {
        tracing::warn!(scope = "Export", label, "memry-export answered 404");
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Cow::Borrowed(&[][..]))
            .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[][..])));
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, PRINT_CSP)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(page.to_vec()))
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[][..])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_print_window_reads_the_staged_page_with_the_print_csp() {
        let page = Staged::new("<p>hi</p>".to_owned());
        let response = answer("pdf-print-3", page.url().as_str());
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(&response.body()[..], b"<p>hi</p>");
        assert_eq!(
            response.headers()[header::CONTENT_SECURITY_POLICY],
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
        );
    }

    #[test]
    fn another_window_gets_nothing() {
        let page = Staged::new("<p>hi</p>".to_owned());
        for label in ["main", "quick-capture", "e2e-1"] {
            assert_eq!(
                answer(label, page.url().as_str()).status(),
                StatusCode::NOT_FOUND
            );
        }
    }

    #[test]
    fn a_page_is_gone_once_its_export_drops_it() {
        let page = Staged::new("<p>hi</p>".to_owned());
        let url = page.url();
        drop(page);
        assert_eq!(
            answer("pdf-print-1", url.as_str()).status(),
            StatusCode::NOT_FOUND
        );
        let unknown = format!("{EXPORT_SCHEME}://localhost/{}.html", Uuid::new_v4());
        assert_eq!(
            answer("pdf-print-1", &unknown).status(),
            StatusCode::NOT_FOUND
        );
    }
}
