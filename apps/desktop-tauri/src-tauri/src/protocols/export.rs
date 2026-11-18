//! The `memry-export` scheme: serves the PDF export's document to its print window from memory.
//! Electron staged it in a temp file because Chromium refuses a long `data:` URL
//! (`ipc/notes-handlers.ts:1004-1009`); a scheme URL has no length limit and writes no file.
//! A page is answered once, and only to the print window its export opened.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, PoisonError};

use memry_desktop::notes::print::PRINT_CSP;
use tauri::http::{Response, StatusCode, header};
use url::Url;
use uuid::Uuid;

pub const EXPORT_SCHEME: &str = "memry-export";

/// A staged page: the window it is for, and its bytes until that window has read them.
struct Page {
    label: String,
    html: Option<Vec<u8>>,
}

static STAGED: LazyLock<Mutex<HashMap<Uuid, Page>>> = LazyLock::new(Mutex::default);

fn staged() -> std::sync::MutexGuard<'static, HashMap<Uuid, Page>> {
    STAGED.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A page the scheme serves to the webview `label` until this is dropped.
pub struct Staged {
    id: Uuid,
}

impl Staged {
    pub fn new(html: String, label: String) -> Self {
        let id = Uuid::new_v4();
        let html = Some(html.into_bytes());
        staged().insert(id, Page { label, html });
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

/// The answer to `uri`, asked by the webview `label`: the staged page, the first time its own
/// print window asks, with a CSP that runs no script and loads nothing from outside the
/// document; otherwise 404.
pub fn answer(label: &str, uri: &str) -> Response<Cow<'static, [u8]>> {
    let page = Url::parse(uri)
        .ok()
        .and_then(|url| {
            let name = url.path().strip_prefix('/')?.strip_suffix(".html")?;
            Uuid::parse_str(name).ok()
        })
        .and_then(|id| {
            let mut staged = staged();
            let page = staged.get_mut(&id).filter(|page| page.label == label)?;
            page.html.take()
        });
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
        .body(Cow::Owned(page))
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[][..])))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage(label: &str) -> Staged {
        Staged::new("<p>hi</p>".to_owned(), label.to_owned())
    }

    #[test]
    fn a_print_window_reads_its_page_with_the_print_csp() {
        let page = stage("pdf-print-3");
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
        let page = stage("pdf-print-1");
        for label in [
            "main",
            "quick-capture",
            "e2e-1",
            "pdf-print-2",
            "pdf-print-10",
        ] {
            assert_eq!(
                answer(label, page.url().as_str()).status(),
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            answer("pdf-print-1", page.url().as_str()).status(),
            StatusCode::OK
        );
    }

    #[test]
    fn a_page_is_served_once() {
        let page = stage("pdf-print-4");
        assert_eq!(
            answer("pdf-print-4", page.url().as_str()).status(),
            StatusCode::OK
        );
        assert_eq!(
            answer("pdf-print-4", page.url().as_str()).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn a_page_is_gone_once_its_export_drops_it() {
        let page = stage("pdf-print-1");
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
