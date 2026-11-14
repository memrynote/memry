//! `memry-ml-worker --pdfium-dir <dir>`: answers the app's frames on stdin and stdout. Logs go to
//! stderr, which the app forwards to `main.log`. pdfium is bound from `<dir>` on the first PDF,
//! so a worker without it still starts and fails each PDF op with the reason.

mod pdf;

use std::path::PathBuf;
use std::process::ExitCode;

use memry_ml_worker::serve::serve;

fn main() -> ExitCode {
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
    match serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        |request| pdfs.handle(request),
    ) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("frame stream broke: {error}");
            ExitCode::from(3)
        }
    }
}
