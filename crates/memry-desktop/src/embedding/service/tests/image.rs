//! `embedImage` on the fake model: the vision encoder's breaker (`embedWithEncoder` and
//! `recordEncoderFailure('vision')`, embeddings.ts:431-469, 830-832).

use super::*;

const IMAGE: [f32; EMBEDDING_DIMENSION] = [0.75; EMBEDDING_DIMENSION];

/// An image the encoder fails (a corrupt file, a broken vision download) backs off images only:
/// text keeps embedding, the next image waits, and a success clears the backoff.
#[test]
fn an_encoder_failure_backs_off_images_and_never_text() {
    let c = case(long_deadline());
    lock(&c.script.images).push_back(Step::Fail("not an image"));
    assert_eq!(c.image(), None);
    assert_eq!(c.error(), "not an image");
    assert_eq!(c.image(), None, "backing off");
    assert_eq!(
        *lock(&c.script.order),
        ["image"],
        "the second never reached the model"
    );
    assert_eq!(c.service.embed(TEXT), Some(vec![0.5; EMBEDDING_DIMENSION]));

    c.service.reset_failure();
    assert_eq!(c.image(), Some(IMAGE.to_vec()));
    assert_eq!(lock(&c.service.state).vision.failures, 0);
    assert!(c.service.status().error.is_none());
}

/// Five images that crash the model never latch anything: each drops the model and backs off
/// images, and text loads go on.
#[test]
fn images_that_crash_the_model_never_stop_text() {
    let c = case(Timing {
        retry_base: Duration::ZERO,
        ..long_deadline()
    });
    for attempt in 0..MAX_CONSECUTIVE_FAILURES {
        lock(&c.script.images).push_back(Step::Panic);
        assert_eq!(c.image(), None, "attempt {attempt}");
        assert!(!c.service.status().loaded, "attempt {attempt}");
    }
    assert_eq!(
        lock(&c.service.state).vision.failures,
        MAX_CONSECUTIVE_FAILURES
    );
    assert_eq!(lock(&c.service.state).audio.failures, 0, "audio untouched");
    assert!(c.service.load(), "text loads go on");
    assert_eq!(c.image(), Some(IMAGE.to_vec()), "never latched");
}

/// A failed vision download backs off images, and a vault close that cancels it counts nowhere.
#[test]
fn a_failed_vision_download_backs_off_images_but_a_cancelled_one_does_not() {
    let c = case(long_deadline());
    lock(&c.script.downloads).push_back(Step::Fail("offline"));
    assert_eq!(c.image(), None);
    assert_eq!(lock(&c.service.state).vision.failures, 1);
    assert_eq!(lock(&c.service.state).audio.failures, 0);

    c.service.reset_failure();
    let (gate, reached) = Gate::new();
    lock(&c.script.downloads).push_back(Step::AwaitAbort(gate));
    let service = c.service.clone();
    let pending = background(move || {
        service.embed_image(ImageInput {
            bytes: vec![1],
            text: None,
            soft_tokens: None,
        })
    });
    reached.recv_timeout(HANG).expect("the download started");
    c.service.stop();
    assert_eq!(pending.recv_timeout(HANG).expect("returned"), None);
    assert_eq!(lock(&c.service.state).vision.failures, 0);
}

/// An image past its deadline backs off images only; the thread is let go.
#[test]
fn an_image_past_its_deadline_backs_off_images_only() {
    let c = case(Timing {
        request_deadline: Duration::from_millis(200),
        ..Timing::default()
    });
    let (gate, reached) = Gate::new();
    lock(&c.script.images).push_back(Step::Block(gate.clone()));
    assert_eq!(c.image(), None);
    reached.recv_timeout(HANG).expect("the image started");
    assert_eq!(c.error(), "Embedding request timed out");
    assert_eq!(lock(&c.service.state).vision.failures, 1);
    gate.release();
    assert!(c.service.load(), "text is not backing off");
}

/// `generateImageEmbedding` (embeddings.ts:1016-1018): an empty image reaches nothing.
#[test]
fn an_empty_image_is_not_embedded() {
    let c = case(long_deadline());
    let service = c.service.clone();
    let got = returns(move || {
        service.embed_image(ImageInput {
            bytes: Vec::new(),
            text: None,
            soft_tokens: None,
        })
    });
    assert_eq!(got, None);
    assert_eq!(c.loads(), 0);
}
