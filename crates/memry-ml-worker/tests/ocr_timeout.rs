//! The OCR read's own timeout (`ocr-engine.ts:24`: 180 s, where a PDF call gets 120 s), against
//! the stub worker. Time is never asserted from above: the slow read must outlive the PDF timeout
//! and still answer, and the hung read must end with its child replaced.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use memry_ml_worker::{Limits, Supervisor, SystemClock, WorkerError};

fn supervisor(limits: Limits) -> Supervisor {
    Supervisor::new(
        PathBuf::from(env!("CARGO_BIN_EXE_memry-ml-worker-stub")),
        Vec::new(),
        limits,
        Arc::new(SystemClock),
    )
}

fn read(worker: &Supervisor, behaviour: &str) -> Result<String, WorkerError> {
    worker.recognize(Path::new("tessdata"), &[behaviour.into()], Vec::new())
}

#[test]
fn an_ocr_read_gets_the_ocr_timeout_not_the_op_timeout() {
    let worker = supervisor(Limits {
        op_timeout: Duration::from_millis(100),
        ocr_timeout: Duration::from_secs(60),
        ..Limits::default()
    });
    assert_eq!(read(&worker, "slow:600"), Ok("read".into()));
}

#[test]
fn a_hung_ocr_read_is_killed_at_the_ocr_timeout_and_the_next_read_restarts() {
    let worker = supervisor(Limits {
        op_timeout: Duration::from_secs(60),
        ocr_timeout: Duration::from_millis(300),
        ..Limits::default()
    });
    assert_eq!(read(&worker, "eng"), Ok("read".into()));
    let hung = worker.pid().expect("running");
    assert_eq!(
        read(&worker, "hang"),
        Err(WorkerError::Timeout { op: "ocr" })
    );
    assert_eq!(worker.pid(), None, "the hung child was killed");
    assert_eq!(read(&worker, "eng"), Ok("read".into()));
    assert_ne!(worker.pid(), Some(hung), "a new child answered");
}
