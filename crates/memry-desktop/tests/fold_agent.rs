//! The fold's agent detection over the local agent engine (`note-fold/agent.ts` and its
//! `agent.test.ts`): which agent `auto` and a chosen agent resolve to, and how long an answer
//! holds.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::http::{Method, StatusCode};
use memry_desktop::ai::local_provider::AgentLocalProviderPreset;
use memry_desktop::fold::agent::{
    DETECTED_TTL, FoldAgentChoice, FoldAgentOption, FoldAgentStatus, FoldAgents, NONE_TTL,
};
use serde_json::json;

use crate::ai_local_agent::{agent, provider};
use crate::local_agent_server::{Fake, MODEL, json_reply, models, serve};

fn local() -> FoldAgentOption {
    FoldAgentOption {
        id: FoldAgentChoice::LocalOpenaiCompatible,
        label: "Local model".into(),
    }
}

fn model_lists(fake: &Fake) -> usize {
    fake.requests()
        .iter()
        .filter(|r| r.method == Method::GET && r.path.ends_with("/models"))
        .count()
}

/// A provider that lists [`MODEL`] while `up` holds, and answers 503 otherwise.
async fn provider_server(up: Arc<AtomicBool>) -> Fake {
    serve(move |_| {
        if up.load(Ordering::SeqCst) {
            models(MODEL)
        } else {
            json_reply(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "error": { "message": "down" } }),
            )
        }
    })
    .await
}

fn agents(fake: &Fake, model: &str) -> FoldAgents {
    FoldAgents::new(agent(provider(
        AgentLocalProviderPreset::Custom,
        &fake.base_url,
        model,
    )))
}

async fn advance(by: Duration) {
    tokio::time::pause();
    tokio::time::advance(by).await;
    tokio::time::resume();
}

#[tokio::test]
async fn auto_and_the_local_choice_resolve_to_a_local_model_that_answers() {
    let fake = provider_server(Arc::new(AtomicBool::new(true))).await;
    let agents = agents(&fake, MODEL);

    assert_eq!(
        agents.status(FoldAgentChoice::Auto).await,
        FoldAgentStatus {
            choice: FoldAgentChoice::Auto,
            available: vec![local()],
            resolved: Some("Local model".into()),
        }
    );
    let run = agents
        .resolve(FoldAgentChoice::LocalOpenaiCompatible)
        .await
        .expect("detected");
    assert_eq!(run.model.as_deref(), Some(MODEL));
    // A chosen agent that is not detected resolves to none, never to another one.
    assert_eq!(
        agents.status(FoldAgentChoice::CodexCli).await,
        FoldAgentStatus {
            choice: FoldAgentChoice::CodexCli,
            available: vec![local()],
            resolved: None,
        }
    );
    assert_eq!(agents.resolve(FoldAgentChoice::ClaudeCli).await, None);
}

#[tokio::test]
async fn a_model_the_provider_does_not_list_is_no_agent() {
    let fake = provider_server(Arc::new(AtomicBool::new(true))).await;
    let agents = agents(&fake, "other-model");

    let status = agents.status(FoldAgentChoice::Auto).await;
    assert_eq!(status.available, []);
    assert_eq!(status.resolved, None);
}

#[tokio::test]
async fn a_detected_agent_holds_a_minute_and_a_settings_change_detects_again() {
    let fake = provider_server(Arc::new(AtomicBool::new(true))).await;
    let agents = agents(&fake, MODEL);

    agents.status(FoldAgentChoice::Auto).await;
    agents.resolve(FoldAgentChoice::Auto).await;
    assert_eq!(model_lists(&fake), 1, "a found agent is cached");

    agents.reset();
    agents.status(FoldAgentChoice::Auto).await;
    assert_eq!(
        model_lists(&fake),
        2,
        "a settings change forgets the detection"
    );

    advance(DETECTED_TTL - Duration::from_secs(1)).await;
    agents.status(FoldAgentChoice::Auto).await;
    assert_eq!(model_lists(&fake), 2);
    advance(Duration::from_secs(1)).await;
    agents.status(FoldAgentChoice::Auto).await;
    assert_eq!(model_lists(&fake), 3, "past a minute it detects again");
}

#[tokio::test]
async fn no_agent_holds_only_seconds_so_a_started_provider_shows_up() {
    let up = Arc::new(AtomicBool::new(false));
    let fake = provider_server(up.clone()).await;
    let agents = agents(&fake, MODEL);

    assert_eq!(agents.status(FoldAgentChoice::Auto).await.resolved, None);
    up.store(true, Ordering::SeqCst);
    advance(NONE_TTL - Duration::from_secs(1)).await;
    assert_eq!(agents.status(FoldAgentChoice::Auto).await.resolved, None);
    assert_eq!(
        model_lists(&fake),
        1,
        "no agent is cached for a few seconds"
    );

    advance(Duration::from_secs(1)).await;
    assert_eq!(
        agents
            .status(FoldAgentChoice::Auto)
            .await
            .resolved
            .as_deref(),
        Some("Local model")
    );
}

#[tokio::test]
async fn callers_that_ask_at_once_share_one_detection() {
    let fake = provider_server(Arc::new(AtomicBool::new(true))).await;
    let agents = agents(&fake, MODEL);

    let (a, b) = tokio::join!(
        agents.status(FoldAgentChoice::Auto),
        agents.resolve(FoldAgentChoice::Auto)
    );
    assert_eq!(a.resolved.as_deref(), Some("Local model"));
    assert!(b.is_some());
    assert_eq!(model_lists(&fake), 1);
}

#[test]
fn a_stored_choice_reads_as_electron_wrote_it_and_an_unknown_one_as_auto() {
    for choice in FoldAgentChoice::DETECTION_ORDER {
        assert_eq!(FoldAgentChoice::from_stored(Some(choice.as_str())), choice);
    }
    assert_eq!(
        FoldAgentChoice::from_stored(Some("auto")),
        FoldAgentChoice::Auto
    );
    assert_eq!(
        FoldAgentChoice::from_stored(Some("gemini_cli")),
        FoldAgentChoice::Auto
    );
    assert_eq!(FoldAgentChoice::from_stored(None), FoldAgentChoice::Auto);
}
