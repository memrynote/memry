//! The approval map: what the card shows, each decision, the 30 minute deadline on a paused
//! clock, cancel, turn end, shutdown and an abandoned request. Every refusal is checked against
//! the host's record of writes.

use super::*;

#[tokio::test]
async fn the_card_shows_what_will_be_written_and_allow_writes_exactly_that() {
    let mut vault = vault();
    let grant = vault.gate.mint_turn_write_grant("conversation-1");
    let mut call = vault.spawn(NOTE_EDIT, grant.secret());
    let card = vault.card(&mut call).await;
    assert_eq!(card.conversation_id, "conversation-1");
    assert_eq!(card.name, "vault_update_note");
    assert!(card.requires_diff);
    assert_eq!(card.preview_kind, PreviewKind::Body);
    assert_eq!(
        card.review_target,
        Some(ReviewTarget::Note {
            id: "note-1".into()
        })
    );
    assert!(card.tool_call_id.starts_with("gate-"));
    let shown = vault.gate.pending_approval(&card.tool_call_id).unwrap();
    assert_eq!(vault.written(), []);
    assert!(
        vault
            .gate
            .resolve_approval(&card.tool_call_id, ApproveToolDecision::Allow)
    );
    assert_eq!(refusal(&call.await.unwrap()), None);
    assert_eq!(
        vault.written(),
        [("vault_update_note".to_owned(), shown.args)]
    );
    assert_eq!(vault.gate.pending_approval(&card.tool_call_id), None);
    assert!(
        !vault
            .gate
            .resolve_approval(&card.tool_call_id, ApproveToolDecision::Allow)
    );
}

#[tokio::test]
async fn a_denial_writes_nothing() {
    let mut vault = vault();
    let grant = vault.gate.mint_turn_write_grant("conversation-1");
    let mut call = vault.spawn(TASK, grant.secret());
    let card = vault.card(&mut call).await;
    vault
        .gate
        .resolve_approval(&card.tool_call_id, ApproveToolDecision::Deny);
    assert_eq!(refusal(&call.await.unwrap()), denied_with(DENIED));
    assert_eq!(vault.written(), []);
}

#[tokio::test]
async fn an_edit_replaces_the_arguments() {
    let mut vault = vault();
    let grant = vault.gate.mint_turn_write_grant("conversation-1");
    let mut call = vault.spawn(TASK, grant.secret());
    let card = vault.card(&mut call).await;
    let edited = json!({ "title": "Edited" });
    vault.gate.resolve_approval(
        &card.tool_call_id,
        ApproveToolDecision::EditAllow {
            edited_args: Some(edited),
        },
    );
    assert_eq!(refusal(&call.await.unwrap()), None);
    let written = vault.written();
    assert_eq!(written[0].1["title"], "Edited");
}

#[tokio::test]
async fn allow_always_trusts_the_tool_at_its_scope_but_never_an_in_page_edit() {
    let mut vault = vault();
    let grant = vault.gate.mint_turn_write_grant("conversation-1");
    let mut call = vault.spawn(TASK, grant.secret());
    let card = vault.card(&mut call).await;
    let always = |scope| ApproveToolDecision::AllowAlways { scope };
    vault
        .gate
        .resolve_approval(&card.tool_call_id, always(AlwaysAllowScope::Conversation));
    assert_eq!(refusal(&call.await.unwrap()), None);
    assert_eq!(
        vault
            .host
            .conversation_trust_list("conversation-1")
            .unwrap(),
        ["vault_create_task"]
    );
    // Trusted now: no second card.
    assert_eq!(refusal(&vault.call(TASK, grant.secret()).await), None);

    let mut call = vault.spawn(DELETE, grant.secret());
    let card = vault.card(&mut call).await;
    vault
        .gate
        .resolve_approval(&card.tool_call_id, always(AlwaysAllowScope::Vault));
    assert_eq!(refusal(&call.await.unwrap()), None);
    assert_eq!(vault.host.vault_trust_list(), ["vault_delete_note"]);

    let mut call = vault.spawn(NOTE_EDIT, grant.secret());
    let card = vault.card(&mut call).await;
    vault
        .gate
        .resolve_approval(&card.tool_call_id, always(AlwaysAllowScope::Vault));
    assert_eq!(refusal(&call.await.unwrap()), None);
    assert_eq!(vault.host.vault_trust_list(), ["vault_delete_note"]);
    assert_eq!(vault.written().len(), 4);

    // A delete asks again even though it was "always" allowed.
    let mut call = vault.spawn(DELETE, grant.secret());
    let card = vault.card(&mut call).await;
    vault
        .gate
        .resolve_approval(&card.tool_call_id, ApproveToolDecision::Deny);
    assert_eq!(refusal(&call.await.unwrap()), denied_with(DENIED));
}

#[tokio::test(start_paused = true)]
async fn an_unanswered_approval_expires_after_30_minutes_and_writes_nothing() {
    let mut vault = vault();
    let grant = vault.gate.mint_turn_write_grant("conversation-1");
    let mut call = vault.spawn(TASK, grant.secret());
    let card = vault.card(&mut call).await;
    let shown = tokio::time::Instant::now();
    tokio::time::advance(APPROVAL_TIMEOUT - Duration::from_secs(1)).await;
    assert!(vault.gate.pending_approval(&card.tool_call_id).is_some());
    let result = call.await.unwrap();
    assert_eq!(shown.elapsed().as_secs(), 30 * 60);
    assert_eq!(refusal(&result), denied_with(APPROVAL_EXPIRED_MESSAGE));
    assert!(APPROVAL_EXPIRED_MESSAGE.starts_with("Approval request expired after 30 minutes"));
    assert_eq!(
        vault.failed(),
        [(
            card.tool_call_id.clone(),
            APPROVAL_EXPIRED_CODE.to_owned(),
            APPROVAL_EXPIRED_MESSAGE.to_owned()
        )]
    );
    assert_eq!(vault.gate.pending_approval(&card.tool_call_id), None);
    assert_eq!(vault.written(), []);
}

#[tokio::test(start_paused = true)]
async fn a_decision_in_time_cancels_the_deadline() {
    let mut vault = vault();
    let grant = vault.gate.mint_turn_write_grant("conversation-1");
    let mut call = vault.spawn(TASK, grant.secret());
    let card = vault.card(&mut call).await;
    tokio::time::advance(Duration::from_secs(29 * 60)).await;
    vault
        .gate
        .resolve_approval(&card.tool_call_id, ApproveToolDecision::Allow);
    assert_eq!(refusal(&call.await.unwrap()), None);
    tokio::time::advance(Duration::from_secs(5 * 60)).await;
    assert_eq!(vault.failed(), []);
}

#[tokio::test]
async fn stop_denies_only_that_conversations_approvals() {
    let mut vault = vault();
    let one = vault.gate.mint_turn_write_grant("conversation-1");
    let two = vault.gate.mint_turn_write_grant("conversation-2");
    let mut cancelled = vault.spawn(TASK, one.secret());
    let cancelled_card = vault.card(&mut cancelled).await;
    let mut kept = vault.spawn(TASK, two.secret());
    let kept_card = vault.card(&mut kept).await;
    vault.gate.cancel_turn("conversation-1");
    assert_eq!(refusal(&cancelled.await.unwrap()), denied_with(DENIED));
    assert_eq!(
        vault.failed(),
        [(
            cancelled_card.tool_call_id,
            "PERMISSION_DENIED".to_owned(),
            CANCELLED.to_owned()
        )]
    );
    assert!(
        vault
            .gate
            .pending_approval(&kept_card.tool_call_id)
            .is_some()
    );
    vault
        .gate
        .resolve_approval(&kept_card.tool_call_id, ApproveToolDecision::Allow);
    assert_eq!(refusal(&kept.await.unwrap()), None);
    assert_eq!(vault.written().len(), 1);
}

#[tokio::test]
async fn an_approval_never_outlives_its_turn() {
    let mut vault = vault();
    // The turn exits while the card is open; a late "allow" writes nothing.
    let grant = vault.gate.mint_turn_write_grant("conversation-1");
    let mut call = vault.spawn(TASK, grant.secret());
    let card = vault.card(&mut call).await;
    drop(grant);
    vault
        .gate
        .resolve_approval(&card.tool_call_id, ApproveToolDecision::Allow);
    assert_eq!(refusal(&call.await.unwrap()), denied_with(NO_TURN));
    // The turn lock is released while the card is open: the card is denied at once.
    let grant = vault.gate.mint_turn_write_grant("conversation-1");
    let mut call = vault.spawn(TASK, grant.secret());
    vault.card(&mut call).await;
    vault.gate.end_turn("conversation-1");
    assert_eq!(refusal(&call.await.unwrap()), denied_with(DENIED));
    assert_eq!(vault.written(), []);
}

#[tokio::test]
async fn shutdown_denies_every_open_approval() {
    let mut vault = vault();
    let grant = vault.gate.mint_turn_write_grant("conversation-1");
    let mut call = vault.spawn(TASK, grant.secret());
    let card = vault.card(&mut call).await;
    vault.gate.shutdown();
    assert_eq!(refusal(&call.await.unwrap()), denied_with(DENIED));
    assert_eq!(vault.gate.pending_approval(&card.tool_call_id), None);
    assert_eq!(vault.written(), []);
}

#[tokio::test]
async fn an_abandoned_request_clears_its_card() {
    let mut vault = vault();
    let grant = vault.gate.mint_turn_write_grant("conversation-1");
    let mut call = vault.spawn(TASK, grant.secret());
    let card = vault.card(&mut call).await;
    call.abort();
    let _ = call.await;
    assert_eq!(vault.gate.pending_approval(&card.tool_call_id), None);
    assert_eq!(vault.failed().len(), 1);
    assert!(
        !vault
            .gate
            .resolve_approval(&card.tool_call_id, ApproveToolDecision::Allow)
    );
    assert_eq!(vault.written(), []);
}

#[tokio::test]
async fn always_accept_writes_without_a_card() {
    let mut vault = vault();
    *vault.host.mode.lock().unwrap() = ToolApprovalMode::AlwaysAccept;
    let grant = vault.gate.mint_turn_write_grant("conversation-1");
    assert_eq!(refusal(&vault.call(DELETE, grant.secret()).await), None);
    assert!(vault.requested.try_recv().is_err());
    assert_eq!(vault.written().len(), 1);
}
