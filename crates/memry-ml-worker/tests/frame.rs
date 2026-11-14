//! The frame codec reads untrusted bytes from both directions. The format is flat (no nesting,
//! no recursion), so its guards are the length cap, truncation and the payload checks.

use std::io::{Cursor, Read};

use memry_ml_worker::frame::{HEADER_LEN, read_frame, write_frame};
use memry_ml_worker::{Frame, FrameError, MAX_FRAME_LEN, OpError, Request, Response};
use memry_test_kit::{output_bound, proptest_config};
use proptest::prelude::*;

/// Counts the bytes a reader handed out.
struct Counting<R> {
    inner: R,
    read: usize,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read += n;
        Ok(n)
    }
}

/// An endless stream of zeroes, as a peer that keeps sending would be.
struct Zeroes;

impl Read for Zeroes {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        buf.fill(0);
        Ok(buf.len())
    }
}

#[test]
fn an_oversized_frame_is_refused_before_its_body_is_read() {
    let header = (MAX_FRAME_LEN + 1).to_be_bytes();
    let mut reader = Counting {
        inner: Cursor::new(header).chain(Zeroes),
        read: 0,
    };
    let error = read_frame(&mut reader).expect_err("over the cap");
    assert!(matches!(error, FrameError::TooLarge(len) if len == u64::from(MAX_FRAME_LEN) + 1));
    assert_eq!(reader.read, 4, "only the length was read");

    let max = u32::MAX.to_be_bytes();
    assert!(matches!(
        read_frame(&mut Cursor::new(max)),
        Err(FrameError::TooLarge(_))
    ));
}

#[test]
fn a_frame_at_the_cap_is_read_and_one_past_it_is_never_written() {
    let at_cap = Frame {
        op: 0x83,
        id: 7,
        payload: vec![1; (MAX_FRAME_LEN - HEADER_LEN) as usize],
    };
    let mut bytes = Vec::new();
    write_frame(&mut bytes, &at_cap).expect("at the cap");
    let read = read_frame(&mut Cursor::new(&bytes))
        .expect("read")
        .expect("a frame");
    assert_eq!(read, at_cap);

    let past = Frame {
        payload: vec![1; (MAX_FRAME_LEN - HEADER_LEN + 1) as usize],
        ..at_cap
    };
    let mut out = Vec::new();
    assert!(matches!(
        write_frame(&mut out, &past),
        Err(FrameError::TooLarge(_))
    ));
    assert!(out.is_empty(), "nothing of a refused frame is written");
}

#[test]
fn a_truncated_frame_is_an_error_at_every_cut() {
    let mut bytes = Vec::new();
    write_frame(
        &mut bytes,
        &Request::PdfOpen {
            path: "/v/a.pdf".into(),
        }
        .to_frame(3),
    )
    .expect("write");
    assert!(
        read_frame(&mut Cursor::new(&[] as &[u8]))
            .expect("clean end")
            .is_none()
    );
    for cut in 1..bytes.len() {
        let error = read_frame(&mut Cursor::new(&bytes[..cut])).expect_err("truncated");
        assert!(
            matches!(error, FrameError::Truncated),
            "cut {cut}: {error:?}"
        );
    }
}

#[test]
fn a_length_shorter_than_the_header_is_refused() {
    for len in 0..HEADER_LEN {
        let mut bytes = len.to_be_bytes().to_vec();
        bytes.extend_from_slice(&[0; 8]);
        assert!(matches!(
            read_frame(&mut Cursor::new(bytes)),
            Err(FrameError::TooShort(l)) if l == len
        ));
    }
}

#[test]
fn unknown_ops_and_bad_payloads_are_errors() {
    let frame = |op, payload: &[u8]| Frame {
        op,
        id: 1,
        payload: payload.to_vec(),
    };
    assert_eq!(
        Request::from_frame(&frame(0x7e, &[])),
        Err(OpError::UnknownOp(0x7e))
    );
    assert_eq!(
        Response::from_frame(&frame(0x7e, &[])),
        Err(OpError::UnknownOp(0x7e))
    );
    // PdfClose with a trailing byte, PdfPageText one byte short, a string longer than its frame,
    // and a string that is not UTF-8.
    for (op, payload) in [
        (0x04, &[0, 0, 0, 1, 9][..]),
        (0x02, &[0, 0, 0, 1, 0, 0, 0][..]),
        (0x01, &[0, 0, 0, 9, b'a'][..]),
        (0x01, &[0, 0, 0, 1, 0xff][..]),
    ] {
        assert_eq!(
            Request::from_frame(&frame(op, payload)),
            Err(OpError::Malformed(op))
        );
    }
}

fn request() -> impl Strategy<Value = Request> {
    prop_oneof![
        ".{0,64}".prop_map(|path| Request::PdfOpen { path }),
        (any::<u32>(), any::<u32>()).prop_map(|(doc, page)| Request::PdfPageText { doc, page }),
        (any::<u32>(), any::<u32>(), any::<u32>()).prop_map(|(doc, page, max_edge)| {
            Request::PdfRenderPage {
                doc,
                page,
                max_edge,
            }
        }),
        any::<u32>().prop_map(|doc| Request::PdfClose { doc }),
        Just(Request::Shutdown),
    ]
}

fn response() -> impl Strategy<Value = Response> {
    prop_oneof![
        Just(Response::Ready),
        (any::<u32>(), any::<u32>())
            .prop_map(|(doc, page_count)| Response::PdfOpened { doc, page_count }),
        ".{0,64}".prop_map(Response::Text),
        (
            any::<u32>(),
            any::<u32>(),
            proptest::collection::vec(any::<u8>(), 0..64)
        )
            .prop_map(|(width, height, png)| Response::Rendered { width, height, png }),
        Just(Response::Done),
        ".{0,64}".prop_map(Response::Failed),
    ]
}

fn through_the_wire(frame: &Frame) -> Frame {
    let mut bytes = Vec::new();
    write_frame(&mut bytes, frame).expect("write");
    read_frame(&mut Cursor::new(bytes))
        .expect("read")
        .expect("a frame")
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn requests_and_responses_round_trip(id in any::<u32>(), req in request(), resp in response()) {
        prop_assert_eq!(Request::from_frame(&through_the_wire(&req.to_frame(id))), Ok(req));
        prop_assert_eq!(Response::from_frame(&through_the_wire(&resp.to_frame(id))), Ok(resp));
    }

    /// Arbitrary bytes never panic either decoder, and nothing decoded outgrows its input.
    #[test]
    fn arbitrary_bytes_fail_closed(bytes in proptest::collection::vec(any::<u8>(), 0..256)) {
        let mut reader = Cursor::new(&bytes);
        while let Ok(Some(frame)) = read_frame(&mut reader) {
            prop_assert!(frame.payload.len() <= output_bound(bytes.len()));
            let _ = Request::from_frame(&frame);
            if let Ok(Response::Rendered { png, .. }) = Response::from_frame(&frame) {
                prop_assert!(png.len() <= output_bound(bytes.len()));
            }
        }
    }
}
