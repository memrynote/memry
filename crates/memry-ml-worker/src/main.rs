//! `memry-ml-worker --pdfium-dir <dir>`: answers the app's frames on stdin and stdout. Logs go to
//! stderr, which the app forwards to `main.log`. pdfium is bound from `<dir>` on the first PDF,
//! so a worker without it still starts and fails each PDF op with the reason. OCR runs on the
//! Tesseract linked into this binary.

mod ocr;
mod pdf;

use std::path::PathBuf;
use std::process::ExitCode;

use memry_ml_worker::Request;
use memry_ml_worker::serve::serve;

fn main() -> ExitCode {
    #[cfg(windows)]
    {
        use windows::Win32::System::LibraryLoader::{
            LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, SetDefaultDllDirectories,
        };
        // pdfium loads by its full path, and the DLLs it needs only from the app dir and System32,
        // never from the cwd or PATH. SAFETY: plain FFI call that narrows this process's search.
        if let Err(error) = unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) } {
            eprintln!("could not narrow the DLL search path: {error}");
        }
    }
    let mut args = std::env::args_os().skip(1);
    let mut pdfium_dir = None;
    while let Some(arg) = args.next() {
        if arg == "--pdfium-dir" {
            pdfium_dir = args.next().map(PathBuf::from);
        } else {
            eprintln!("unknown argument {}", arg.to_string_lossy());
            return ExitCode::from(2);
        }
    }
    let Some(pdfium_dir) = pdfium_dir else {
        eprintln!("--pdfium-dir is required");
        return ExitCode::from(2);
    };
    let mut pdfs = pdf::Pdfs::new(pdfium_dir);
    let mut ocr = ocr::Ocr::default();
    match serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        |request| match request {
            Request::Ocr {
                datapath,
                languages,
                png,
            } => ocr.handle(&datapath, &languages, &png),
            other => pdfs.handle(other),
        },
    ) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("frame stream broke: {error}");
            ExitCode::from(3)
        }
    }
}
