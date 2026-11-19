//! Chunk holds, chapter 14 §14.8.1 and §14.8.2, against `chunk-holds.json` (generated through
//! Electron's `canvas/assets/chunk-holds.ts`) and a scripted transport.
//!
//! | Test                                                          | Rule                           |
//! | ------------------------------------------------------------- | ------------------------------ |
//! | every holder id matches Electron's                            | `canvasAssetHolderId`          |
//! | every request case sends Electron's bodies, reports its missing | `holdEach`, `probeNoteAttachments` |
//! | a 404 is Unsupported for a hold and success for a release      | §14.8.1 older servers          |
//! | only 408, 429, 5xx and no answer are retryable                | `holdEach` `retryable`         |
//! | a probe releases even after a failed hold                     | `probeNoteAttachments`         |
//! | a lost probe release is a retryable failure                   | `probeNoteAttachments`         |

#[allow(unused_imports)]
use crate::http_fakes;
#[allow(unused_imports)]
use crate::support;

use std::collections::BTreeSet;
use std::sync::Arc;

use http_fakes::{FakeTransport, body_json, error_response, response};
use memry_core::api::errors::TransportError;
use memry_core::protocol::http::{ClientIdentity, HttpClient, VAULT_ID_HEADER};
use memry_core::sync::attachments::holds::{
    self, AttachmentChunks, HoldOutcome, Holder, canvas_asset_holder_id, holder_id,
};
use serde_json::{Value as Json, json};
use support::{hex_field, str_field, vector_file};

const VAULT: &str = "default";
const KEY: [u8; 32] = [3u8; 32];

fn client(transport: Arc<FakeTransport>) -> HttpClient {
    HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.2.3").unwrap(),
    )
}

fn strings(value: &Json) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

/// The outcome as the vector file spells it.
fn plain(outcome: &HoldOutcome) -> Json {
    match outcome {
        HoldOutcome::Held { missing } => json!({ "status": "ok", "missing": missing }),
        HoldOutcome::Unsupported => json!({ "status": "unsupported" }),
        HoldOutcome::Failed { retryable, status } => {
            json!({ "status": "failed", "retryable": retryable, "httpStatus": status })
        }
    }
}

fn holder_of(image: &Json) -> (String, Vec<String>) {
    (
        str_field(image, "contentHash").to_owned(),
        strings(&image["chunkHashes"]),
    )
}

fn attachment_of(attachment: &Json) -> AttachmentChunks {
    AttachmentChunks {
        attachment_id: str_field(attachment, "attachmentId").to_owned(),
        chunk_hashes: strings(&attachment["chunkHashes"]),
    }
}

#[test]
fn every_holder_id_matches_electrons() {
    let file = vector_file("chunk-holds");
    let cases = file["holderIds"].as_array().unwrap();
    assert!(cases.len() >= 10, "{} cases", cases.len());
    for case in cases {
        let key = hex_field(case, "vaultKey");
        let (a, b) = (str_field(case, "a"), str_field(case, "b"));
        let expected = str_field(case, "holderId");
        let derived = holder_id(&key, str_field(case, "domain"), a, b).unwrap();
        assert_eq!(derived, expected, "{}", str_field(case, "name"));
        assert_eq!(canvas_asset_holder_id(&key, a, b).unwrap(), expected);
    }
}

#[tokio::test]
async fn every_request_case_sends_electrons_bodies_and_reports_its_missing() {
    let file = vector_file("chunk-holds");
    let key = hex::decode(
        file["holderIds"][0]["vaultKey"]
            .as_str()
            .expect("the first case's key"),
    )
    .unwrap();
    for case in file["requests"].as_array().unwrap() {
        let name = str_field(case, "name");
        let sent = case["requests"].as_array().unwrap();
        let script = sent
            .iter()
            .map(|request| {
                let holds = request["body"]["holds"].as_array();
                // The generator's server named holders by position; replay what it answered.
                let answer = match holds {
                    Some(_) => json!({ "missing": missing_answer(case, request, &key) }),
                    None => json!({ "released": 1 }),
                };
                response(200, &answer.to_string())
            })
            .collect();
        let transport = FakeTransport::new(script);
        let http = client(transport.clone());
        let outcome = match str_field(case, "kind") {
            "hold-canvas" => {
                let canvas = str_field(case, "canvasId");
                let images: Vec<(String, Vec<String>)> = case["images"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(holder_of)
                    .collect();
                let holders: Vec<Holder> = images
                    .iter()
                    .map(|(hash, chunks)| Holder {
                        holder_id: canvas_asset_holder_id(&key, canvas, hash).unwrap(),
                        chunk_hashes: chunks.clone(),
                    })
                    .collect();
                // `hold` names holders; the canvas caller maps them back to images.
                match holds::hold(&http, VAULT, &holders).await {
                    HoldOutcome::Held { missing } => HoldOutcome::Held {
                        missing: images
                            .iter()
                            .filter(|(hash, _)| {
                                missing
                                    .contains(&canvas_asset_holder_id(&key, canvas, hash).unwrap())
                            })
                            .map(|(hash, _)| hash.clone())
                            .collect(),
                    },
                    other => other,
                }
            }
            "probe-note" => {
                let attachments: Vec<AttachmentChunks> = case["attachments"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(attachment_of)
                    .collect();
                holds::probe_note_attachments(
                    &http,
                    VAULT,
                    &key,
                    str_field(case, "noteId"),
                    &attachments,
                )
                .await
                .unwrap()
            }
            other => panic!("unknown kind {other}"),
        };
        let calls = transport.calls();
        assert_eq!(calls.len(), sent.len(), "{name}: request count");
        for (call, expected) in calls.iter().zip(sent) {
            assert!(
                call.url.ends_with(str_field(expected, "path")),
                "{name}: {}",
                call.url
            );
            assert_eq!(call.method, "POST");
            assert_eq!(
                call.headers.get(VAULT_ID_HEADER).map(String::as_str),
                Some(VAULT)
            );
            assert_eq!(body_json(call), expected["body"], "{name}: body");
        }
        assert_eq!(plain(&outcome), case["outcome"], "{name}: outcome");
    }
}

/// The `missing` the generator's server answered for one hold request: the holders of that
/// request whose key the case's outcome names, plus any unknown id it answered.
fn missing_answer(case: &Json, request: &Json, key: &[u8]) -> Vec<String> {
    let named: BTreeSet<String> = strings(&case["outcome"]["missing"]).into_iter().collect();
    let ids: Vec<String> = request["body"]["holds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["holderId"].as_str().unwrap().to_owned())
        .collect();
    let key_of = |id: &str| -> Option<String> {
        if let Some(canvas) = case["canvasId"].as_str() {
            case["images"].as_array().unwrap().iter().find_map(|image| {
                let hash = str_field(image, "contentHash");
                (canvas_asset_holder_id(key, canvas, hash).unwrap() == id).then(|| hash.to_owned())
            })
        } else {
            case["attachments"]
                .as_array()
                .unwrap()
                .iter()
                .find_map(|a| {
                    let att = str_field(a, "attachmentId");
                    let note = str_field(case, "noteId");
                    (holder_id(key, holds::NOTE_PROBE_DOMAIN, note, att).unwrap() == id)
                        .then(|| att.to_owned())
                })
        }
    };
    let mut answer: Vec<String> = ids
        .into_iter()
        .filter(|id| key_of(id).is_some_and(|k| named.contains(&k)))
        .collect();
    // An id the client never asked about is ignored, never reported.
    answer.push("f".repeat(64));
    answer
}

fn one_holder() -> Vec<Holder> {
    vec![Holder {
        holder_id: "a".repeat(64),
        chunk_hashes: vec!["b".repeat(64)],
    }]
}

#[tokio::test]
async fn a_404_is_unsupported_for_a_hold_and_success_for_a_release() {
    let transport = FakeTransport::new(vec![
        error_response(404, "NOT_FOUND", "no route"),
        error_response(404, "NOT_FOUND", "no route"),
    ]);
    let http = client(transport.clone());
    assert_eq!(
        holds::hold(&http, VAULT, &one_holder()).await,
        HoldOutcome::Unsupported
    );
    holds::release(&http, VAULT, &["a".repeat(64)])
        .await
        .expect("nothing to release");
    assert_eq!(transport.call_count(), 2, "one attempt each");
}

#[tokio::test]
async fn only_408_429_5xx_and_no_answer_are_retryable() {
    let cases: Vec<(Result<_, TransportError>, bool, u16)> = vec![
        (error_response(400, "VALIDATION_ERROR", "bad"), false, 400),
        (error_response(403, "FORBIDDEN", "no"), false, 403),
        (error_response(413, "TOO_LARGE", "no"), false, 413),
        (error_response(408, "TIMEOUT", "slow"), true, 408),
        (error_response(429, "RATE_LIMITED", "slow down"), true, 429),
        (error_response(500, "INTERNAL", "oops"), true, 500),
        (error_response(503, "UNAVAILABLE", "later"), true, 503),
        (Err(TransportError::Offline), true, 0),
        (response(200, "not json"), true, 0),
        (response(200, "{}"), true, 0),
    ];
    for (answer, retryable, status) in cases {
        let transport = FakeTransport::new(vec![answer]);
        let outcome = holds::hold(&client(transport.clone()), VAULT, &one_holder()).await;
        assert_eq!(
            outcome,
            HoldOutcome::Failed { retryable, status },
            "status {status}"
        );
        assert_eq!(
            transport.call_count(),
            1,
            "status {status}: never retried in the call"
        );
    }
}

#[tokio::test]
async fn a_probe_releases_even_after_a_failed_hold() {
    let attachments: Vec<AttachmentChunks> = (0..65)
        .map(|i| AttachmentChunks {
            attachment_id: format!("att-{i}"),
            chunk_hashes: vec![format!("{i:064x}")],
        })
        .collect();
    let transport = FakeTransport::new(vec![
        response(200, r#"{"missing":[]}"#),
        error_response(503, "UNAVAILABLE", "later"),
        response(200, r#"{"released":64}"#),
        response(200, r#"{"released":1}"#),
    ]);
    let outcome =
        holds::probe_note_attachments(&client(transport.clone()), VAULT, &KEY, "n1", &attachments)
            .await
            .unwrap();
    assert_eq!(
        outcome,
        HoldOutcome::Failed {
            retryable: true,
            status: 503
        }
    );
    let releases = transport.calls_to("/holds/release");
    assert_eq!(
        releases.len(),
        2,
        "every probe holder released, the first batch included"
    );
    let released: usize = releases
        .iter()
        .map(|r| body_json(r)["holderIds"].as_array().unwrap().len())
        .sum();
    assert_eq!(released, 65);
}

#[tokio::test]
async fn a_lost_probe_release_is_a_retryable_failure() {
    let attachment = AttachmentChunks {
        attachment_id: "att-1".to_owned(),
        chunk_hashes: vec!["1".repeat(64)],
    };
    let transport = FakeTransport::new(vec![
        response(200, r#"{"missing":[]}"#),
        Err(TransportError::Offline),
    ]);
    let outcome =
        holds::probe_note_attachments(&client(transport), VAULT, &KEY, "n1", &[attachment])
            .await
            .unwrap();
    assert_eq!(
        outcome,
        HoldOutcome::Failed {
            retryable: true,
            status: 0
        }
    );
}
