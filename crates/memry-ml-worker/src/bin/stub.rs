//! Test-only stand-in for `memry-ml-worker`, speaking the same frames. `PdfOpen`'s path picks the
//! behaviour: `hang` never answers, `crash` aborts the process, `oversize` writes a frame header
//! past the cap, `log` writes a stderr line and answers; anything else answers with one page.
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
                "crash" => std::process::abort(),
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
            _ => Response::Done,
        },
    );
    if result.is_err() {
        std::process::exit(3);
    }
}
