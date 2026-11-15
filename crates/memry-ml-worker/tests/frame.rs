//! The frame codec reads untrusted bytes from both directions. The format is flat (no nesting,
//! no recursion), so its guards are the length cap, truncation and the payload checks.

use std::io::{Cursor, Read};

use memry_ml_worker::frame::{HEADER_LEN, read_frame, write_frame};
use memry_ml_worker::{
    EMBEDDING_DIMENSION, Frame, FrameError, MAX_EMBED_IMAGE_BYTES, MAX_EMBED_TEXT_BYTES,
    MAX_FAILED_MESSAGE, MAX_FRAME_LEN, MAX_OCR_LANGUAGES, Manifest, ManifestFile, ModelGroup,
    OpError, Request, Response,
};
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

#[test]
fn an_ocr_request_past_the_language_cap_is_refused() {
    let request = |count: u32| Request::Ocr {
        datapath: "tessdata".into(),
        languages: (0..count).map(|_| "eng".to_owned()).collect(),
        png: vec![1, 2, 3],
    };
    let at_cap = request(MAX_OCR_LANGUAGES);
    assert_eq!(Request::from_frame(&at_cap.to_frame(1)), Ok(at_cap));
    let past = request(MAX_OCR_LANGUAGES + 1).to_frame(1);
    assert_eq!(Request::from_frame(&past), Err(OpError::Malformed(past.op)));
}

fn frame(op: u8, payload: Vec<u8>) -> Frame {
    Frame { op, id: 1, payload }
}

/// A text past its cap is refused from its declared length, before its bytes are looked at or
/// copied: the frame below declares one byte over the cap and carries none of them.
#[test]
fn an_embed_text_over_its_cap_is_refused_from_its_length() {
    let declared = u32::try_from(MAX_EMBED_TEXT_BYTES + 1).unwrap();
    assert_eq!(
        Request::from_frame(&frame(0x11, declared.to_be_bytes().to_vec())),
        Err(OpError::TooLarge(0x11))
    );
    // EmbedImage: no soft-token override, a text, then the text's declared length.
    let mut image = vec![0, 0, 0, 0, 0, 0, 0, 1];
    image.extend_from_slice(&declared.to_be_bytes());
    assert_eq!(
        Request::from_frame(&frame(0x12, image)),
        Err(OpError::TooLarge(0x12))
    );
    let at_cap = "a".repeat(MAX_EMBED_TEXT_BYTES);
    let request = Request::EmbedText { text: at_cap };
    assert_eq!(Request::from_frame(&request.to_frame(1)), Ok(request));
}

#[test]
fn an_embed_image_over_its_cap_is_refused() {
    let request = |len| Request::EmbedImage {
        bytes: vec![0; len],
        text: None,
        soft_tokens: None,
    };
    assert_eq!(
        Request::from_frame(&request(MAX_EMBED_IMAGE_BYTES + 1).to_frame(1)),
        Err(OpError::TooLarge(0x12))
    );
    let at_cap = request(MAX_EMBED_IMAGE_BYTES);
    assert_eq!(Request::from_frame(&at_cap.to_frame(1)), Ok(at_cap));
}

/// The app reads the worker's answers as untrusted: an embedding of any other width, a manifest
/// listing more files than a model has, and an over-long manifest string are refused.
#[test]
fn embedding_answers_of_the_wrong_shape_are_refused() {
    for width in [0, EMBEDDING_DIMENSION - 1, EMBEDDING_DIMENSION + 1] {
        assert_eq!(
            Response::from_frame(&frame(0x85, vec![0; width * 4])),
            Err(OpError::Malformed(0x85)),
            "{width} values"
        );
    }
    let mut many = Vec::new();
    for field in ["repo", "rev"] {
        many.extend_from_slice(&u32::try_from(field.len()).unwrap().to_be_bytes());
        many.extend_from_slice(field.as_bytes());
    }
    many.extend_from_slice(&17u32.to_be_bytes());
    assert_eq!(
        Response::from_frame(&frame(0x86, many)),
        Err(OpError::Malformed(0x86))
    );
    assert_eq!(
        Response::from_frame(&frame(0x86, 257u32.to_be_bytes().to_vec())),
        Err(OpError::TooLarge(0x86))
    );
    assert_eq!(
        Request::from_frame(&frame(0x13, 3u32.to_be_bytes().to_vec())),
        Err(OpError::Malformed(0x13))
    );
}

/// A `Failed` message reaches `ModelStatus.error` and the log: the app refuses one over its cap
/// from the declared length, and the worker cuts its own on a character boundary.
#[test]
fn a_failed_message_is_capped() {
    let declared = u32::try_from(MAX_FAILED_MESSAGE + 1).unwrap();
    assert_eq!(
        Response::from_frame(&frame(0xff, declared.to_be_bytes().to_vec())),
        Err(OpError::TooLarge(0xff))
    );
    let long = format!("a{}", "é".repeat(MAX_FAILED_MESSAGE));
    let Ok(Response::Failed(cut)) =
        Response::from_frame(&Response::Failed(long.clone()).to_frame(1))
    else {
        panic!("a cut message round-trips");
    };
    assert_eq!(cut.len(), MAX_FAILED_MESSAGE - 1);
    assert!(long.starts_with(&cut));
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
        (
            ".{0,64}",
            proptest::collection::vec("[a-z_]{0,8}", 0..=MAX_OCR_LANGUAGES as usize),
            proptest::collection::vec(any::<u8>(), 0..64)
        )
            .prop_map(|(datapath, languages, png)| Request::Ocr {
                datapath,
                languages,
                png
            }),
        Just(Request::Shutdown),
        Just(Request::EmbedLoad),
        ".{0,64}".prop_map(|text| Request::EmbedText { text }),
        (
            proptest::collection::vec(any::<u8>(), 0..64),
            proptest::option::of(".{0,64}"),
            proptest::option::of(1..=u32::MAX),
        )
            .prop_map(|(bytes, text, soft_tokens)| Request::EmbedImage {
                bytes,
                text,
                soft_tokens,
            }),
        prop_oneof![
            Just(ModelGroup::Text),
            Just(ModelGroup::Vision),
            Just(ModelGroup::Audio)
        ]
        .prop_map(|group| Request::ModelManifest { group }),
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
        proptest::collection::vec(-1.0f32..1.0, EMBEDDING_DIMENSION).prop_map(Response::Embedded),
        (
            ".{0,64}",
            ".{0,40}",
            proptest::collection::vec((".{0,64}", any::<u64>(), "[0-9a-f]{64}"), 0..8)
        )
            .prop_map(|(repo, revision, files)| Response::Manifest(Manifest {
                repo,
                revision,
                files: files
                    .into_iter()
                    .map(|(path, size, sha256)| ManifestFile { path, size, sha256 })
                    .collect(),
            })),
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
