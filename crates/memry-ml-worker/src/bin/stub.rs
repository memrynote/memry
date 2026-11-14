//! Test-only stand-in for `memry-ml-worker`, speaking the same frames. `PdfOpen`'s path picks the
//! behaviour: `hang` never answers, `hang:<file>` creates `<file>` and never answers, `crash`
//! aborts the process, `exit` exits with code 1, `oversize` writes a frame header past the cap,
//! `log` writes a stderr line and answers; anything else answers with one page as document 1.
//! `PdfPageText` answers the child's pid, so a test sees which child answered. `PdfRenderPage`
//! answers the names of the child's environment variables, a tab, then its cwd.
//! `--crash-before-ready` aborts before the `Ready` frame. Never bundled.

use std::io::Write;

use memry_ml_worker::serve::serve;
use memry_ml_worker::{MAX_FRAME_LEN, Request, Response};

fn main() {
    if std::env::args().any(|arg| arg == "--crash-before-ready") {
        std::process::abort();
    }
    let result = serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        |request| match request {
            Request::PdfOpen { path } => match path.as_str() {
                "hang" => loop {
                    std::thread::park();
                },
                hang if hang.starts_with("hang:") => {
                    let _ = std::fs::write(&hang["hang:".len()..], b"");
                    loop {
                        std::thread::park();
                    }
                }
                "crash" => std::process::abort(),
                "exit" => std::process::exit(1),
                "oversize" => {
                    let mut out = std::io::stdout().lock();
                    let _ = out.write_all(&(MAX_FRAME_LEN + 1).to_be_bytes());
                    let _ = out.flush();
                    loop {
                        std::thread::park();
                    }
                }
                "log" => {
                    eprintln!("stub-log-line");
                    Response::PdfOpened {
                        doc: 1,
                        page_count: 1,
                    }
                }
                _ => Response::PdfOpened {
                    doc: 1,
                    page_count: 1,
                },
            },
            Request::PdfPageText { .. } => Response::Text(std::process::id().to_string()),
            Request::PdfRenderPage { .. } => {
                let mut names: Vec<_> = std::env::vars_os()
                    .map(|(name, _)| name.to_string_lossy().into_owned())
                    .collect();
                names.sort();
                let cwd = std::env::current_dir().unwrap_or_default();
                Response::Text(format!("{}\t{}", names.join("\n"), cwd.display()))
            }
            _ => Response::Done,
        },
    );
    if result.is_err() {
        std::process::exit(3);
    }
}
