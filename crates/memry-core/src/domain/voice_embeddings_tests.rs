//! The store and plan of Electron's `voice-vectors.ts` and `voice-embedding-projector.ts`
//! (`voice-embedding-projector.test.ts`), on a real `data.db` and an `index.db` with vec0.

use super::*;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::test_support::temp_dir;
use crate::storage::vec::{EMBEDDING_DIMENSION, vector};
use crate::storage::{open_data, open_index};

const NOW: i64 = 1_760_000_000_000;

fn memo(status: Option<&str>, transcription: Option<&str>) -> VoiceItem {
    VoiceItem {
        id: "m".into(),
        title: "Voice memo (0:07)".into(),
        transcription: transcription.map(str::to_owned),
        transcription_status: status.map(str::to_owned),
        attachment_path: Some("attachments/inbox/m/voice-memo.wav".into()),
    }
}

/// "waits for a running transcription", "embeds a usable transcript with the text model",
/// "embeds the audio when the transcript is missing, failed or too short".
#[test]
fn a_memo_is_planned_from_its_transcript_or_its_audio() {
    assert_eq!(plan(&memo(Some("pending"), None)), VoicePlan::Wait);
    assert_eq!(
        plan(&memo(Some("processing"), Some("a b c d"))),
        VoicePlan::Wait
    );
    let VoicePlan::Transcript(text) = plan(&memo(Some("complete"), Some("buy oat milk"))) else {
        panic!("a three-word transcript is usable");
    };
    assert!(
        text.contains("Voice memo (0:07)") && text.contains("buy oat milk"),
        "{text}"
    );
    assert_eq!(
        plan(&memo(Some("complete"), Some("Thank you."))),
        VoicePlan::Audio
    );
    assert_eq!(
        plan(&memo(Some("complete"), Some("1 2 3 4 ..."))),
        VoicePlan::Audio
    );
    assert_eq!(plan(&memo(Some("complete"), None)), VoicePlan::Audio);
    assert_eq!(
        plan(&memo(Some("failed"), Some("buy oat milk"))),
        VoicePlan::Audio
    );
    assert_eq!(plan(&memo(None, None)), VoicePlan::Audio);
    // `\p{L}[\p{L}\p{N}']*`: letters start a word, digits and apostrophes continue it.
    assert!(matches!(
        plan(&memo(Some("complete"), Some("don't v2 çay"))),
        VoicePlan::Transcript(_)
    ));
    assert!(matches!(
        plan(&memo(Some("complete"), Some("日本 語の テスト"))),
        VoicePlan::Transcript(_)
    ));
}

#[test]
fn a_state_row_matches_its_source_at_the_current_version() {
    let row = |source: &str, input_version| VoiceEmbeddingState {
        item_id: "m".into(),
        source: source.into(),
        input_version,
        chunks: 1,
    };
    assert!(row("transcript", EMBEDDING_INPUT_VERSION).matches(VoiceSource::Transcript));
    assert!(!row("transcript", EMBEDDING_INPUT_VERSION - 1).matches(VoiceSource::Transcript));
    assert!(!row("transcript", EMBEDDING_INPUT_VERSION).matches(VoiceSource::Audio));
    assert!(row("audio", AUDIO_EMBEDDING_INPUT_VERSION).matches(VoiceSource::Audio));
    assert!(!row("video", AUDIO_EMBEDDING_INPUT_VERSION).matches(VoiceSource::Audio));
}

fn capture(data: &rusqlite::Connection, id: &str, payload: serde_json::Value, deleted: bool) {
    let record = InboundRecord {
        item_type: "inbox".to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-a".to_owned()),
        updated_at: NOW,
        deleted_at: deleted.then_some(NOW),
    };
    sync_items::apply_remote(data, &record, NOW).expect("apply");
}

#[test]
fn the_live_voice_memos_are_listed_filed_and_archived_included() {
    let dir = temp_dir("voice-items");
    let data = open_data(&dir.path().join("data.db")).expect("data.db");
    let items = data
        .call_blocking(|conn| {
            let voice = |id: &str, extra: serde_json::Value| {
                let mut payload = serde_json::json!({
                    "title": format!("memo {id}"), "type": "voice",
                    "transcription": "buy oat milk", "transcriptionStatus": "complete",
                    "attachmentPath": format!("attachments/inbox/{id}/voice-memo.wav"),
                });
                payload
                    .as_object_mut()
                    .unwrap()
                    .extend(extra.as_object().unwrap().clone());
                payload
            };
            capture(conn, "a", voice("a", serde_json::json!({})), false);
            capture(
                conn,
                "b",
                voice(
                    "b",
                    serde_json::json!({ "filedAt": "2026-01-02T03:04:05.000Z" }),
                ),
                false,
            );
            capture(
                conn,
                "c",
                voice(
                    "c",
                    serde_json::json!({ "archivedAt": "2026-01-02T03:04:05.000Z" }),
                ),
                false,
            );
            capture(conn, "gone", voice("gone", serde_json::json!({})), true);
            capture(
                conn,
                "link",
                serde_json::json!({ "title": "x", "type": "link" }),
                false,
            );
            Ok((
                items(conn, None)?,
                items(conn, Some("a"))?,
                items(conn, Some("link"))?,
            ))
        })
        .expect("listed");
    let (all, one, link) = items;
    let ids: Vec<&str> = all.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(ids, ["a", "b", "c"]);
    assert_eq!(
        one,
        [VoiceItem {
            id: "a".into(),
            title: "memo a".into(),
            transcription: Some("buy oat milk".into()),
            transcription_status: Some("complete".into()),
            attachment_path: Some("attachments/inbox/a/voice-memo.wav".into()),
        }]
    );
    assert!(link.is_empty());
}

fn unit(at: usize) -> Vec<f32> {
    let mut vector = vec![0.0_f32; EMBEDDING_DIMENSION];
    vector[at] = 1.0;
    vector
}

/// `replaceVoiceVectors` replaces every window, `deleteVoiceVectors` drops them all, and
/// `nearestVoiceItems` answers one hit per memo at its best window.
#[test]
fn windows_are_replaced_deleted_and_found_per_memo() {
    let dir = temp_dir("voice-vectors");
    let index = open_index(&dir.path().join("index.db"))
        .expect("index.db")
        .db;
    index
        .call_blocking(|conn| {
            replace(conn, "a", VoiceSource::Audio, &[unit(1), unit(2), unit(3)])?;
            replace(conn, "b", VoiceSource::Transcript, &[unit(4)])?;
            // Fewer windows the second time: the third is gone with the rest.
            replace(conn, "a", VoiceSource::Audio, &[unit(2), unit(3)])?;
            assert_eq!(vector(conn, VecTable::Voice, "a#2")?, None);
            assert_eq!(vector(conn, VecTable::Voice, "a#0")?, Some(unit(2)));
            assert_eq!(
                state(conn)?,
                [
                    VoiceEmbeddingState {
                        item_id: "a".into(),
                        source: "audio".into(),
                        input_version: AUDIO_EMBEDDING_INPUT_VERSION,
                        chunks: 2,
                    },
                    VoiceEmbeddingState {
                        item_id: "b".into(),
                        source: "transcript".into(),
                        input_version: EMBEDDING_INPUT_VERSION,
                        chunks: 1,
                    },
                ]
            );

            let hits = nearest_items(conn, &unit(3), 10)?;
            assert_eq!(hits.len(), 2, "one hit per memo: {hits:?}");
            assert_eq!((hits[0].0.as_str(), hits[0].2), ("a", VoiceSource::Audio));
            assert!((hits[0].1 - 1.0).abs() < 1e-6);
            assert_eq!(
                (hits[1].0.as_str(), hits[1].2),
                ("b", VoiceSource::Transcript)
            );
            assert!(hits[1].1.abs() < 1e-6);

            delete(conn, "a")?;
            assert_eq!(vector(conn, VecTable::Voice, "a#0")?, None);
            assert_eq!(vector(conn, VecTable::Voice, "a#1")?, None);
            assert_eq!(state(conn)?.len(), 1);
            delete(conn, "never")?;

            clear(conn)?;
            assert!(state(conn)?.is_empty());
            assert!(nearest_items(conn, &unit(4), 10)?.is_empty());
            Ok(())
        })
        .expect("stored");
}

/// A window with no state row (or a source this build does not know) answers nothing.
#[test]
fn a_window_without_a_known_source_is_not_a_hit() {
    let dir = temp_dir("voice-orphans");
    let index = open_index(&dir.path().join("index.db"))
        .expect("index.db")
        .db;
    let hits = index
        .call_blocking(|conn| {
            replace(conn, "a", VoiceSource::Audio, &[unit(1)])?;
            replace(conn, "z", VoiceSource::Audio, &[unit(1)])?;
            conn.execute(
                "UPDATE voice_embedding_state SET source = 'video' WHERE item_id = 'z'",
                [],
            )
            .map_err(failed)?;
            conn.execute(
                "INSERT INTO vec_voice (chunk_id, embedding) VALUES ('orphan#0', ?1)",
                [to_blob(&unit(1))],
            )
            .map_err(failed)?;
            nearest_items(conn, &unit(1), 10)
        })
        .expect("read");
    let ids: Vec<&str> = hits.iter().map(|hit| hit.0.as_str()).collect();
    assert_eq!(ids, ["a"]);
}
