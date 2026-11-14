//! The worker's side of the frames: announce readiness, then answer each request in order until
//! `Shutdown` or the end of stdin. A request that does not decode is answered with `Failed` under
//! its id, since its frame was whole; a frame that does not parse ends the worker, because the
//! stream cannot be resynchronised.

use std::io::{Read, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};

use crate::frame::{FrameError, read_frame, write_frame};
use crate::op::{Request, Response};

/// The id the `Ready` frame carries; requests never use it.
pub const READY_ID: u32 = 0;

pub fn serve(
    mut input: impl Read,
    mut output: impl Write,
    mut handle: impl FnMut(Request) -> Response,
) -> Result<(), FrameError> {
    write_frame(&mut output, &Response::Ready.to_frame(READY_ID))?;
    while let Some(frame) = read_frame(&mut input)? {
        let response = match Request::from_frame(&frame) {
            Ok(Request::Shutdown) => return Ok(()),
            Ok(request) => catch_unwind(AssertUnwindSafe(|| handle(request)))
                .unwrap_or_else(|_| Response::Failed("the worker op panicked".into())),
            Err(error) => Response::Failed(error.to_string()),
        };
        match write_frame(&mut output, &response.to_frame(frame.id)) {
            Err(FrameError::TooLarge(len)) => {
                let failed = Response::Failed(format!("the answer of {len} bytes is over the cap"));
                write_frame(&mut output, &failed.to_frame(frame.id))?;
            }
            other => other?,
        }
    }
    Ok(())
}
