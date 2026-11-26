//! The parts of the agent MCP server around the call path: the reply cut (ports of Electron's
//! `reply-cap.test.ts`), the session (`session.test.ts`) and the untrusted-input guards on tool
//! arguments.

use memry_desktop::agent::mcp::reply_cap::cap_reply;
use memry_desktop::agent::mcp::{CallContext, ReplyCap};
use serde_json::json;

mod reply_cap {
    use super::*;

    fn cap() -> ReplyCap {
        ReplyCap {
            max_bytes: 102_400,
            advice: r#"Ask for less than {"id":"note-1"}."#.into(),
        }
    }

    fn notice(kept: usize, total: usize) -> String {
        format!(
            "Reply cut at {kept} of {total} bytes. partial holds the start of the JSON reply and is not valid JSON on its own. The rest is not returned. Ask for less than {{\"id\":\"note-1\"}}."
        )
    }

    #[test]
    fn a_reply_within_the_limit_is_unchanged() {
        let reply = json!({ "id": "note-1", "content": "Short body" });
        assert_eq!(cap_reply(reply.clone(), &cap()), reply);
    }

    #[test]
    fn a_cut_reply_stays_within_the_limit_after_escaping_and_says_so() {
        let value = json!({ "id": "note-1", "content": "\"".repeat(150_000) });
        let reply = cap_reply(value.clone(), &cap());
        let reply_bytes = reply.to_string().len();
        assert_eq!(reply["truncated"], true);
        assert_eq!(reply["totalBytes"], 300_028);
        assert!(
            reply_bytes <= 102_400 && reply_bytes > 101_000,
            "{reply_bytes}"
        );
        let partial = reply["partial"].as_str().unwrap();
        assert_eq!(reply["message"], notice(partial.len(), 300_028));
        assert!(value.to_string().starts_with(partial));
    }

    #[test]
    fn the_limit_is_utf8_bytes_and_the_cut_is_on_a_character() {
        let value = json!({ "id": "note-1", "content": "\u{6f22}\u{1F600}".repeat(20_000) });
        let reply = cap_reply(value.clone(), &cap());
        let reply_bytes = reply.to_string().len();
        assert!(value.to_string().encode_utf16().count() < 102_400);
        assert_eq!(reply["totalBytes"], 140_028);
        assert!(
            reply_bytes <= 102_400 && reply_bytes > 101_000,
            "{reply_bytes}"
        );
        assert!(
            value
                .to_string()
                .starts_with(reply["partial"].as_str().unwrap())
        );
    }
}

mod session {
    use axum::http::HeaderMap;
    use memry_desktop::agent::mcp::session::Session;

    use super::*;

    #[test]
    fn the_bearer_is_64_hex_and_rotation_replaces_it() {
        let session = Session::new();
        let first = session.token();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
        let second = session.rotate();
        assert_ne!(first, second);
        assert!(!session.verify(Some(&first)));
        assert!(session.verify(Some(&second)));
        assert!(!session.verify(None));
        assert!(!session.verify(Some(&second[..63])));
    }

    #[test]
    fn the_context_reads_the_turn_and_window_headers_only() {
        let mut headers = HeaderMap::new();
        assert_eq!(CallContext::from_headers(&headers), CallContext::default());
        headers.insert("x-memry-conversation", "c-1".parse().unwrap());
        assert_eq!(CallContext::from_headers(&headers), CallContext::default());
        headers.insert("X-Memry-Turn", "grant".parse().unwrap());
        headers.insert("x-memry-window", "main".parse().unwrap());
        assert_eq!(
            CallContext::from_headers(&headers),
            CallContext {
                write_grant: Some("grant".into()),
                window: Some("main".into())
            }
        );
    }
}

/// Tool arguments come from any client holding the bearer, and from model output. The JSON depth
/// guard is serde_json's 128-level recursion limit in rmcp's body parse (behind rmcp's 4 MiB
/// body cap); validation walks the static schemas only, and its text stays within the input's
/// size.
mod untrusted {
    use std::sync::Arc;

    use async_trait::async_trait;
    use memry_desktop::agent::mcp::{
        CallContext, McpServer, ToolError, ToolRegistry, ToolReply, VaultToolHost,
    };
    use memry_test_kit::{assert_output_bounded, proptest_config};
    use proptest::prelude::*;
    use serde_json::{Map, Value, json};

    use crate::agent_mcp::http::request;

    struct Echo;

    #[async_trait]
    impl VaultToolHost for Echo {
        async fn call(
            &self,
            _: &str,
            args: Value,
            _: &CallContext,
        ) -> Result<ToolReply, ToolError> {
            Ok(ToolReply::new(args))
        }
    }

    fn text(result: &rmcp::model::CallToolResult) -> String {
        serde_json::to_value(result).unwrap()["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_deeply_nested_body_is_refused_and_the_server_keeps_serving() {
        let server = McpServer::start(Arc::new(ToolRegistry::new(Arc::new(Echo))))
            .await
            .unwrap();
        let token = server.token();
        let depth = 100_000;
        let body = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"vault_search_notes","arguments":{{"query":{}{}}}}}}}"#,
            "[".repeat(depth),
            "]".repeat(depth)
        );
        let (status, reply) =
            request(server.url(), "POST", "/mcp", Some(&token), Some(&body)).await;
        assert!(status >= 400 || reply.contains("error"), "{status} {reply}");
        assert!(!reply.contains("\"query\""));
        let health = request(server.url(), "GET", "/healthz", Some(&token), None).await;
        assert_eq!(health.0, 200);
        server.stop().await;
    }

    #[tokio::test]
    async fn the_validation_text_of_a_large_input_stays_within_its_size() {
        let registry = ToolRegistry::new(Arc::new(Echo));
        let file_types: Vec<Value> = (0..20_000).map(Value::from).collect();
        let args = json!({ "query": "", "limit": 0, "file_types": file_types });
        let input_len = args.to_string().len();
        let Value::Object(args) = args else {
            unreachable!()
        };
        let result = registry
            .call("vault_search_notes", Some(args), &CallContext::default())
            .await;
        assert_eq!(result.is_error, Some(true));
        assert_output_bounded("validation text", input_len, text(&result).len());
    }

    fn arg() -> impl Strategy<Value = Value> {
        let leaf = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::from),
            any::<i64>().prop_map(Value::from),
            "[a-z#0-9 ]{0,12}".prop_map(Value::from),
        ];
        leaf.prop_recursive(3, 24, 4, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..4).prop_map(Value::from),
                prop::collection::btree_map("[a-z_]{1,8}", inner, 0..4)
                    .prop_map(|map| Value::Object(map.into_iter().collect())),
            ]
        })
    }

    fn arguments() -> impl Strategy<Value = Map<String, Value>> {
        let keys = prop_oneof![
            Just("query".to_owned()),
            Just("limit".to_owned()),
            Just("file_types".to_owned()),
            Just("name".to_owned()),
            Just("project_id".to_owned()),
            Just("color".to_owned()),
            "[a-z_]{1,8}",
        ];
        prop::collection::btree_map(keys, arg(), 0..5).prop_map(|map| map.into_iter().collect())
    }

    proptest! {
        #![proptest_config(proptest_config(256))]

        /// Any arguments get an answer: a valid call reaches the host with its arguments (and
        /// defaults), an invalid one gets bounded text.
        #[test]
        fn any_arguments_get_a_bounded_answer(
            tool in prop_oneof![Just("vault_search_notes"), Just("vault_get_tags")],
            args in arguments(),
        ) {
            let input_len = Value::Object(args.clone()).to_string().len();
            let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
            let registry = ToolRegistry::new(Arc::new(Echo));
            let result = runtime.block_on(registry.call(tool, Some(args), &CallContext::default()));
            let text = text(&result);
            if result.is_error != Some(true) {
                prop_assert!(serde_json::from_str::<Value>(&text).is_ok());
            }
            prop_assert!(text.len() <= memry_test_kit::output_bound(input_len) + 200, "{text}");
        }
    }
}
