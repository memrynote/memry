//! `embedAudio` on the fake model: the audio encoder's breaker, file faults and per-window
//! requests.

use super::*;

/// A recording the worker cannot read or decode is the file's fault: it backs nothing off, even
/// as the request that loads the model, so a vault of broken voice memos cannot stop embeddings.
#[test]
fn a_recording_the_worker_cannot_read_backs_nothing_off() {
    let c = case(long_deadline());
    for _ in 0..MAX_CONSECUTIVE_FAILURES + 1 {
        assert_eq!(c.audio("unreadable.wav"), None);
    }
    assert_eq!(c.error(), "not a WAV");
    assert_eq!(
        c.opens(),
        MAX_CONSECUTIVE_FAILURES as usize + 1,
        "never backed off"
    );
    assert_eq!(c.audio("memo.wav").map(|v| v.len()), Some(3));
    assert_eq!(c.service.embed(TEXT), Some(vec![0.5; EMBEDDING_DIMENSION]));
    assert_eq!(c.loads(), 1);
}

/// `recordEncoderFailure('audio')` (embeddings.ts:247-254, 830-832): a recording that crashes the
/// worker feeds only the audio breaker, which never latches, so five of them leave text alone.
#[test]
fn five_recordings_that_crash_the_model_never_stop_text() {
    let c = case(Timing {
        retry_base: Duration::ZERO,
        ..long_deadline()
    });
    for attempt in 0..MAX_CONSECUTIVE_FAILURES {
        lock(&c.script.windows).extend([Step::Vector, Step::Panic]);
        assert_eq!(c.audio("crash.wav"), None, "attempt {attempt}");
        assert!(
            !c.service.status().loaded,
            "attempt {attempt}: the model was dropped"
        );
    }
    assert_eq!(
        lock(&c.service.state).audio.failures,
        MAX_CONSECUTIVE_FAILURES
    );
    assert!(c.service.load(), "text loads go on");
    assert_eq!(c.service.embed(TEXT), Some(vec![0.5; EMBEDDING_DIMENSION]));
    assert_eq!(
        c.audio("memo.wav").map(|v| v.len()),
        Some(3),
        "never latched"
    );
    assert_eq!(
        lock(&c.service.state).audio.failures,
        0,
        "a recording clears it"
    );
}

/// The encoder's own faults (its download failing, its files broken so a window fails) back off
/// the next recording, never text; enabling AI again clears it (`clearLoadFailure`).
#[test]
fn an_encoder_fault_backs_off_audio_and_never_text() {
    let c = case(long_deadline());
    lock(&c.script.downloads).push_back(Step::Fail("offline"));
    assert_eq!(c.audio("memo.wav"), None);
    assert_eq!(c.error(), "offline");
    assert_eq!(c.audio("memo.wav"), None, "backing off");
    assert_eq!(c.opens(), 0);
    assert_eq!(c.service.embed(TEXT), Some(vec![0.5; EMBEDDING_DIMENSION]));

    c.service.reset_failure();
    lock(&c.script.windows).push_back(Step::Fail("audio model incomplete"));
    assert_eq!(c.audio("memo.wav"), None);
    assert_eq!(c.error(), "audio model incomplete");
    assert_eq!(c.audio("memo.wav"), None, "backing off");
    assert_eq!(c.opens(), 1);
    assert!(c.service.load());
    assert_eq!(c.service.embed(TEXT), Some(vec![0.5; EMBEDDING_DIMENSION]));
}

/// A window past its deadline feeds the audio breaker, never the text one: the thread is let go
/// and the next text request loads the model on a new one.
#[test]
fn a_window_past_its_deadline_backs_off_audio_only() {
    let c = case(Timing {
        request_deadline: Duration::from_millis(200),
        ..Timing::default()
    });
    let (gate, reached) = Gate::new();
    lock(&c.script.windows).push_back(Step::Block(gate.clone()));
    assert_eq!(c.audio("memo.wav"), None);
    reached.recv_timeout(HANG).expect("the window started");
    assert_eq!(c.error(), "Embedding request timed out");
    assert_eq!(c.audio("memo.wav"), None, "backing off");
    assert_eq!(c.opens(), 1);
    gate.release();
    assert!(c.service.load(), "text is not backing off");
    assert_eq!(c.loads(), 2);
}

/// Electron's timer is per window (embeddings.ts:792-798): a recording whose windows together
/// take longer than one request deadline still embeds.
#[test]
fn each_window_has_its_own_deadline() {
    let c = case(Timing {
        request_deadline: Duration::from_secs(2),
        ..Timing::default()
    });
    lock(&c.script.windows).extend((0..3).map(|_| Step::Sleep(Duration::from_millis(800))));
    assert_eq!(c.audio("memo.wav").map(|v| v.len()), Some(3));
    assert!(c.service.status().error.is_none());
}

/// A text request that arrives during a window is served before the next window, so a long
/// recording never holds text past its deadline.
#[test]
fn text_runs_between_the_windows_of_a_recording() {
    let c = case(long_deadline());
    let (gate, reached) = Gate::new();
    lock(&c.script.windows).push_back(Step::Block(gate.clone()));
    let service = c.service.clone();
    let audio = background(move || service.embed_audio(std::path::Path::new("memo.wav")));
    reached.recv_timeout(HANG).expect("window 0 started");
    let service = c.service.clone();
    let text = background(move || service.embed(TEXT));
    until("the text request waiting", || {
        let state = lock(&c.service.state);
        let worker = state.worker.as_ref().expect("running");
        worker
            .pending
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|slot| !slot.is_filled())
            .count()
            == 2
    });
    gate.release();
    assert!(text.recv_timeout(HANG).expect("text hung").is_some());
    assert_eq!(
        audio
            .recv_timeout(HANG)
            .expect("audio hung")
            .map(|v| v.len()),
        Some(3)
    );
    assert_eq!(
        *lock(&c.script.order),
        ["window", "text", "window", "window"]
    );
}

/// Electron returns before its bridge for a recording under one second: here the worker decodes
/// it first, so its empty answer must not count as an encoder success.
#[test]
fn a_recording_without_windows_is_not_a_success() {
    let c = case(Timing {
        retry_base: Duration::ZERO,
        ..long_deadline()
    });
    lock(&c.script.windows).push_back(Step::Fail("audio model incomplete"));
    assert_eq!(c.audio("memo.wav"), None);
    assert_eq!(c.audio("short.wav"), None);
    assert_eq!(lock(&c.service.state).audio.failures, 1);
    assert_eq!(c.error(), "audio model incomplete");
}
