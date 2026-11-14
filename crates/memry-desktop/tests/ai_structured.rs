//! One structured call to the inline AI model against a local fake provider (#3539): the
//! request goes through the proxy with the stored key in the auth header only, the SDK's
//! retries and `retry-after` hold, a vault that closes during a retry's wait ends the call, a
//! failure names what the user can fix, the answer is capped and a provider that quotes the key
//! back has it cut out before anything reads the message.

use std::sync::Arc;
use std::time::Duration;

use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::proxy::{AiProxy, ProxyError};
use memry_desktop::ai::settings::InlineAiSettings;
use memry_desktop::ai::structured::{ANSWER_CAP, Ask, Failure, Retry, StructuredError, generate};
use memry_desktop::ai::writing_assist::{self, WritingAssistInput, WritingAssistResult};
use serde_json::{Value, json};

use crate::ai_fake::{KEY, Reply, WAIT, closed_base, fake, proxy, settings};

const NOW: Retry = Retry {
    retries: 2,
    first_delay: Duration::ZERO,
};

fn ask() -> Ask<'static> {
    Ask {
        system: "the system text",
        prompt: "the user text",
        schema: json!({
            "type": "object",
            "properties": { "answer": { "type": "string" } },
            "required": ["answer"],
            "additionalProperties": false,
        }),
    }
}

async fn call(
    proxy: &Arc<AiProxy>,
    settings: &InlineAiSettings,
    retry: Retry,
) -> Result<Value, StructuredError> {
    tokio::time::timeout(
        WAIT,
        generate::<Value>(proxy, settings, &proxy.owner("main"), &ask(), retry),
    )
    .await
    .expect("the call ended")
}

#[tokio::test]
async fn ollama_and_custom_ask_chat_completions_with_the_key_only_in_the_auth_header() {
    for provider in [AiProvider::Custom, AiProvider::Ollama] {
        let fake = fake(vec![Reply::chat(r#"{"answer":"yes"}"#)]).await;
        let proxy = proxy();
        let answer = call(&proxy, &settings(provider, &fake.base, KEY), NOW).await;
        assert_eq!(answer, Ok(json!({ "answer": "yes" })), "{provider:?}");

        let seen = fake.seen();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].path, "/v1/chat/completions");
        let body = seen[0].json();
        assert_eq!(body["messages"][0]["content"], json!("the system text"));
        assert_eq!(body["messages"][1]["content"], json!("the user text"));
        assert_eq!(
            body["response_format"]["json_schema"]["schema"],
            ask().schema
        );
        assert_eq!(
            body["response_format"]["json_schema"]["strict"],
            json!(true)
        );
        assert!(!String::from_utf8_lossy(&seen[0].body).contains(KEY));
        let auth = seen[0].headers.get("authorization");
        match provider {
            AiProvider::Custom => assert_eq!(auth.unwrap(), &format!("Bearer {KEY}")),
            // Ollama runs on this device and takes no key, even with a cloud key stored.
            _ => assert!(auth.is_none()),
        }
        assert_eq!(proxy.in_flight(), 0);
    }
}

#[tokio::test]
async fn a_busy_provider_is_tried_again_and_gives_up_after_two_retries() {
    let fake_ok = fake(vec![
        Reply::status(503),
        Reply::status(429),
        Reply::chat(r#"{"answer":"third"}"#),
    ])
    .await;
    let proxy = proxy();
    let answer = call(
        &proxy,
        &settings(AiProvider::Custom, &fake_ok.base, KEY),
        NOW,
    )
    .await;
    assert_eq!(answer, Ok(json!({ "answer": "third" })));
    assert_eq!(fake_ok.seen().len(), 3);

    let fake_down = fake(vec![Reply::status(500)]).await;
    let error = call(
        &proxy,
        &settings(AiProvider::Custom, &fake_down.base, KEY),
        NOW,
    )
    .await
    .unwrap_err();
    assert_eq!(fake_down.seen().len(), 3);
    let StructuredError::Retried { attempts, last } = &error else {
        panic!("{error:?}");
    };
    assert_eq!(*attempts, 3);
    assert!(matches!(
        **last,
        StructuredError::Status { status: 500, .. }
    ));
    assert_eq!(error.failure(), Failure::Other);
    assert!(
        error
            .to_string()
            .starts_with("Failed after 3 attempts. Last error: ")
    );
}

#[tokio::test]
async fn a_short_retry_after_replaces_the_backoff_and_a_long_one_is_ignored() {
    // An hour of backoff: only the provider's `retry-after-ms: 0` lets the call end in time.
    let hour = Retry {
        retries: 1,
        first_delay: Duration::from_secs(3600),
    };
    let fake_short = fake(vec![
        Reply::status(429).with_header("retry-after-ms", "0"),
        Reply::chat(r#"{"answer":"after"}"#),
    ])
    .await;
    let proxy = proxy();
    let answer = call(
        &proxy,
        &settings(AiProvider::Custom, &fake_short.base, KEY),
        hour,
    )
    .await;
    assert_eq!(answer, Ok(json!({ "answer": "after" })));

    // An hour asked in `retry-after` is past a minute and longer than the backoff: ignored.
    let fake_long = fake(vec![
        Reply::status(503).with_header("retry-after", "3600"),
        Reply::chat(r#"{"answer":"backoff"}"#),
    ])
    .await;
    let answer = call(
        &proxy,
        &settings(AiProvider::Custom, &fake_long.base, KEY),
        NOW,
    )
    .await;
    assert_eq!(answer, Ok(json!({ "answer": "backoff" })));
}

#[tokio::test]
async fn a_refused_key_is_unauthorized_and_never_retried() {
    for status in [401, 403] {
        let fake = fake(vec![Reply::status(status)]).await;
        let error = call(
            &proxy(),
            &settings(AiProvider::Custom, &fake.base, KEY),
            NOW,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, StructuredError::Status { .. }), "{error:?}");
        assert_eq!(error.failure(), Failure::Unauthorized);
        assert_eq!(fake.seen().len(), 1);
    }
}

#[tokio::test]
async fn an_unreachable_provider_is_retried_then_reported_unreachable() {
    let base = closed_base().await;
    let error = call(&proxy(), &settings(AiProvider::Custom, &base, KEY), NOW)
        .await
        .unwrap_err();
    let StructuredError::Retried { attempts: 3, last } = &error else {
        panic!("{error:?}");
    };
    assert!(matches!(
        **last,
        StructuredError::Proxy(ProxyError::Unreachable { .. })
    ));
    assert_eq!(error.failure(), Failure::Unreachable);
    assert!(!format!("{error} {error:?}").contains(KEY));
}

/// No run of 8 characters of the key, so a message clipped mid-key leaks nothing either.
fn assert_no_key(text: &str) {
    for at in 0..=KEY.len() - 8 {
        assert!(!text.contains(&KEY[at..at + 8]), "key text in {text:?}");
    }
}

#[tokio::test]
async fn a_provider_that_quotes_the_key_back_has_it_cut_out() {
    let long = format!("{}Incorrect API key provided: {KEY}.", "x".repeat(100_000));
    let bodies = [
        json!({ "error": { "message": format!("Incorrect API key provided: {KEY}.") } }),
        json!({ "error": format!("bad key {KEY}") }),
        json!({ "error": { "message": long } }),
    ];
    for body in bodies {
        for status in [400, 500] {
            let fake = fake(vec![Reply::json(status, &body)]).await;
            let error = call(
                &proxy(),
                &settings(AiProvider::Custom, &fake.base, KEY),
                NOW,
            )
            .await
            .unwrap_err();
            let text = format!("{error} {error:?}");
            assert_no_key(&text);
            assert!(text.contains("[redacted]"), "{status}");
        }
    }
}

#[tokio::test]
async fn an_answer_without_an_object_is_no_object() {
    let answers = [
        Reply::Answer {
            status: 200,
            headers: Vec::new(),
            body: b"not json".to_vec(),
        },
        // A refusal: no text at all.
        Reply::json(
            200,
            &json!({ "choices": [{ "message": { "content": null } }] }),
        ),
        Reply::chat("I cannot help with that."),
    ];
    for answer in answers {
        let fake = fake(vec![answer]).await;
        let error = call(
            &proxy(),
            &settings(AiProvider::Custom, &fake.base, KEY),
            NOW,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, StructuredError::NoObject(_)), "{error:?}");
        assert_eq!(fake.seen().len(), 1, "no object is not retried");
    }
}

#[tokio::test]
async fn an_answer_past_the_cap_is_refused() {
    let fake = fake(vec![Reply::Answer {
        status: 200,
        headers: Vec::new(),
        body: vec![b' '; ANSWER_CAP + 1],
    }])
    .await;
    let proxy = proxy();
    let error = call(&proxy, &settings(AiProvider::Custom, &fake.base, KEY), NOW)
        .await
        .unwrap_err();
    assert_eq!(
        error,
        StructuredError::Proxy(ProxyError::AnswerTooLarge {
            provider: fake.base[7..fake.base.len() - 3].to_owned(),
            cap: ANSWER_CAP,
        })
    );
    assert_eq!(proxy.in_flight(), 0);
}

#[test]
fn a_deeply_nested_answer_fails_closed_on_a_small_stack() {
    let outcomes = memry_test_kit::on_small_stack(|| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let deep_text = format!("{}{}", "[".repeat(200_000), "]".repeat(200_000));
            let deep_body = format!(
                r#"{{"choices":{}{}}}"#,
                "[".repeat(200_000),
                "]".repeat(200_000)
            );
            let mut outcomes = Vec::new();
            for reply in [
                Reply::chat(&deep_text),
                Reply::Answer {
                    status: 200,
                    headers: Vec::new(),
                    body: deep_body.into_bytes(),
                },
            ] {
                let fake = fake(vec![reply]).await;
                let settings = settings(AiProvider::Custom, &fake.base, KEY);
                outcomes.push(call(&proxy(), &settings, NOW).await);
            }
            outcomes
        })
    });
    for outcome in outcomes {
        assert!(
            matches!(outcome, Err(StructuredError::NoObject(_))),
            "{outcome:?}"
        );
    }
}

#[tokio::test]
async fn writing_assist_returns_cleaned_alternatives_of_the_selection() {
    let fake = fake(vec![Reply::chat(
        &json!({ "alternatives": [" \"Hi\" ", "Hello", "hello there", "Hi", ""] }).to_string(),
    )])
    .await;
    let proxy = proxy();
    let input = WritingAssistInput::Alternatives {
        text: "  Hello ".to_owned(),
        context: "He said Hello to her.".to_owned(),
    }
    .validate()
    .unwrap();
    let result = writing_assist::run(
        &proxy,
        &settings(AiProvider::Custom, &fake.base, KEY),
        &proxy.owner("main"),
        &input,
        NOW,
    )
    .await;
    assert_eq!(
        result,
        Ok(WritingAssistResult::Alternatives {
            alternatives: vec!["Hi".to_owned(), "hello there".to_owned()],
        })
    );
    let prompt = fake.seen()[0].json()["messages"][1]["content"].clone();
    assert_eq!(
        prompt,
        json!("Surrounding text:\nHe said Hello to her.\n\nSelection to rephrase:\nHello")
    );
}

#[tokio::test]
async fn a_vault_that_closes_during_a_retry_wait_ends_the_call_with_nothing_sent() {
    // Half a minute asked: well past the watchdog, so only the close can end the wait.
    let fake = fake(vec![
        Reply::status(429).with_header("retry-after", "30"),
        Reply::chat(r#"{"answer":"next vault"}"#),
    ])
    .await;
    let proxy = proxy();
    let calling = {
        let proxy = proxy.clone();
        let settings = settings(AiProvider::Custom, &fake.base, KEY);
        tokio::spawn(async move {
            let owner = proxy.owner("main");
            generate::<Value>(&proxy, &settings, &owner, &ask(), NOW).await
        })
    };
    fake.wait_for(1).await;
    // The 429 is read once its request leaves the in-flight map: the call is in its wait.
    tokio::time::timeout(WAIT, async {
        while proxy.in_flight() > 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the first answer was read");
    proxy.cancel_all();

    let outcome = tokio::time::timeout(WAIT, calling)
        .await
        .expect("the wait ended with the vault")
        .unwrap();
    assert_eq!(
        outcome,
        Err(StructuredError::Proxy(ProxyError::VaultClosed))
    );
    assert_eq!(outcome.unwrap_err().failure(), Failure::Ended);
    assert_eq!(fake.seen().len(), 1, "no request after the close");
}

#[tokio::test]
async fn a_later_try_that_no_retry_helps_says_so() {
    let fake = fake(vec![Reply::status(503), Reply::status(400)]).await;
    let error = call(
        &proxy(),
        &settings(AiProvider::Custom, &fake.base, KEY),
        NOW,
    )
    .await
    .unwrap_err();
    assert_eq!(fake.seen().len(), 2);
    assert_eq!(
        error.to_string(),
        "Failed after 2 attempts with non-retryable error: 'status 400'"
    );
}

#[tokio::test]
async fn a_key_quoted_back_as_json_text_is_cut_out_too() {
    // A key with the characters a JSON string escapes; the provider echoes the request body.
    const ODD: &str = r#"test"key\not-real-42"#;
    let echoed = format!("bad request body: {}", json!({ "key": ODD }));
    assert!(!echoed.contains(ODD), "the echo holds the escaped key only");
    let fake = fake(vec![Reply::json(
        400,
        &json!({ "error": { "message": echoed } }),
    )])
    .await;
    let error = call(
        &proxy(),
        &settings(AiProvider::Custom, &fake.base, ODD),
        NOW,
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        r#"bad request body: {"key":"[redacted]"}"#
    );
}

#[tokio::test]
async fn provider_text_is_left_alone_for_a_short_key_or_a_provider_without_one() {
    let text = "the model llama-local-model is not loaded";
    for (provider, key) in [
        // A key this short would cut letters out of words.
        (AiProvider::Custom, "el"),
        // Ollama never gets the stored cloud key, so it cannot quote it.
        (AiProvider::Ollama, "llama-local-model"),
    ] {
        let fake = fake(vec![Reply::json(
            400,
            &json!({ "error": { "message": text } }),
        )])
        .await;
        let error = call(&proxy(), &settings(provider, &fake.base, key), NOW)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), text, "{provider:?}");
    }
}

#[tokio::test]
async fn a_short_custom_key_quoted_back_is_cut_out_as_a_whole_token() {
    // LiteLLM's default master key.
    const SHORT: &str = "sk-1234";
    let fake = fake(vec![Reply::json(
        400,
        &json!({ "error": { "message": "Invalid key sk-1234. Keys look like sk-12345678." } }),
    )])
    .await;
    let error = call(
        &proxy(),
        &settings(AiProvider::Custom, &fake.base, SHORT),
        NOW,
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Invalid key [redacted]. Keys look like sk-12345678."
    );
}
