//! The request and answer shape of each provider's structured call (#3539), as the AI SDK
//! sends and reads them: OpenAI Responses, chat completions for Ollama and a custom endpoint,
//! Anthropic's `output_config.format` or forced `json` tool by model, Google `generateContent`.

use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::settings::InlineAiSettings;
use memry_desktop::ai::structured::{Ask, Dialect, anthropic_output_format};
use serde_json::json;

fn ask() -> Ask<'static> {
    Ask {
        system: "sys",
        prompt: "user",
        schema: json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "a": { "type": "string" } },
                        "additionalProperties": false,
                    },
                },
            },
            "required": ["items"],
            "additionalProperties": false,
        }),
    }
}

fn dialect(provider: AiProvider, model: &str) -> Dialect {
    Dialect::of(&InlineAiSettings {
        enabled: true,
        provider,
        model: model.to_owned(),
        api_key: String::new(),
        base_url: String::new(),
    })
}

#[test]
fn each_provider_gets_its_sdk_dialect() {
    assert_eq!(dialect(AiProvider::Openai, "gpt-4.1"), Dialect::Responses);
    assert_eq!(dialect(AiProvider::Ollama, "llama3.2"), Dialect::Chat);
    assert_eq!(dialect(AiProvider::Custom, "x"), Dialect::Chat);
    assert_eq!(
        dialect(AiProvider::Google, "gemini-2.5-flash"),
        Dialect::Google
    );
    assert_eq!(
        dialect(AiProvider::Anthropic, "claude-sonnet-4-5"),
        Dialect::Anthropic {
            output_format: true
        }
    );
    assert_eq!(
        dialect(AiProvider::Anthropic, "claude-3-7-sonnet-latest"),
        Dialect::Anthropic {
            output_format: false
        }
    );
}

#[test]
fn openai_asks_the_responses_api_with_a_strict_schema() {
    let (path, body) = Dialect::Responses.request("gpt-4.1", &ask());
    assert_eq!(path, "/responses");
    assert_eq!(body["model"], json!("gpt-4.1"));
    assert_eq!(body["instructions"], json!("sys"));
    assert_eq!(
        body["input"],
        json!([{ "role": "user", "content": "user" }])
    );
    assert_eq!(
        body["text"]["format"],
        json!({ "type": "json_schema", "name": "response", "strict": true, "schema": ask().schema })
    );

    let answer = json!({ "output": [
        { "type": "reasoning", "summary": [] },
        { "type": "message", "content": [
            { "type": "output_text", "text": "{\"a\":" },
            { "type": "refusal", "refusal": "no" },
            { "type": "output_text", "text": "1}" },
        ] },
    ] });
    assert_eq!(
        Dialect::Responses.text(&answer).as_deref(),
        Some("{\"a\":1}")
    );
    assert_eq!(Dialect::Responses.text(&json!({ "output": [] })), None);
}

#[test]
fn chat_completions_carry_a_strict_response_format() {
    let (path, body) = Dialect::Chat.request("llama3.2", &ask());
    assert_eq!(path, "/chat/completions");
    assert_eq!(
        body["messages"],
        json!([{ "role": "system", "content": "sys" }, { "role": "user", "content": "user" }])
    );
    assert_eq!(
        body["response_format"],
        json!({ "type": "json_schema", "json_schema": {
            "name": "response", "strict": true, "schema": ask().schema,
        } })
    );
    let answer = json!({ "choices": [{ "message": { "content": "{}" } }] });
    assert_eq!(Dialect::Chat.text(&answer).as_deref(), Some("{}"));
    assert_eq!(Dialect::Chat.text(&json!({ "choices": [] })), None);
}

#[test]
fn anthropic_sends_output_format_or_a_forced_json_tool_with_4096_tokens() {
    let native = Dialect::Anthropic {
        output_format: true,
    };
    let (path, body) = native.request("claude-sonnet-4-5", &ask());
    assert_eq!(path, "/messages");
    assert_eq!(body["max_tokens"], json!(4096));
    assert_eq!(body["system"], json!("sys"));
    assert_eq!(
        body["output_config"],
        json!({ "format": { "type": "json_schema", "schema": ask().schema } })
    );
    assert!(body.get("tools").is_none());
    let answer = json!({ "content": [
        { "type": "thinking", "thinking": "hm" },
        { "type": "text", "text": "{\"a\":" },
        { "type": "text", "text": "1}" },
    ] });
    assert_eq!(native.text(&answer).as_deref(), Some("{\"a\":1}"));

    let tool = Dialect::Anthropic {
        output_format: false,
    };
    let (_, body) = tool.request("claude-3-7-sonnet-latest", &ask());
    assert_eq!(body["max_tokens"], json!(4096));
    assert!(body.get("output_config").is_none());
    assert_eq!(body["tools"][0]["name"], json!("json"));
    assert_eq!(body["tools"][0]["input_schema"], ask().schema);
    assert_eq!(
        body["tool_choice"],
        json!({ "type": "tool", "name": "json" })
    );
    let answer = json!({ "content": [
        { "type": "text", "text": "Here you go" },
        { "type": "tool_use", "name": "other", "input": { "b": 2 } },
        { "type": "tool_use", "name": "json", "input": { "a": 1 } },
    ] });
    assert_eq!(tool.text(&answer).as_deref(), Some(r#"{"a":1}"#));
    assert_eq!(tool.text(&json!({ "content": [] })), None);
}

#[test]
fn google_gets_an_openapi_schema_and_skips_thoughts() {
    let (path, body) = Dialect::Google.request("gemini-2.5-flash", &ask());
    assert_eq!(path, "/models/gemini-2.5-flash:generateContent");
    let (tuned, _) = Dialect::Google.request("tunedModels/mine", &ask());
    assert_eq!(tuned, "/tunedModels/mine:generateContent");
    assert_eq!(
        body["systemInstruction"],
        json!({ "parts": [{ "text": "sys" }] })
    );
    assert_eq!(
        body["contents"],
        json!([{ "role": "user", "parts": [{ "text": "user" }] }])
    );
    let config = &body["generationConfig"];
    assert_eq!(config["responseMimeType"], json!("application/json"));
    assert_eq!(
        config["responseSchema"],
        json!({
            "type": "object",
            "properties": { "items": {
                "type": "array",
                "items": { "type": "object", "properties": { "a": { "type": "string" } } },
            } },
            "required": ["items"],
        })
    );
    let answer = json!({ "candidates": [{ "content": { "parts": [
        { "text": "thinking", "thought": true },
        { "text": "{\"a\":1}" },
    ] } }] });
    assert_eq!(Dialect::Google.text(&answer).as_deref(), Some("{\"a\":1}"));
}

/// `getModelCapabilities` of `@ai-sdk/anthropic` 3.0.142, `supportsStructuredOutput`.
#[test]
fn anthropic_output_format_follows_the_sdk_model_table() {
    let cases = [
        ("claude-opus-4-8", true),
        ("claude-opus-4-7", true),
        ("claude-sonnet-4-6", true),
        ("claude-opus-4-6", true),
        ("claude-sonnet-4-5-20250929", true),
        ("claude-opus-4-5", true),
        ("claude-haiku-4-5", true),
        ("claude-opus-4-1-20250805", true),
        ("claude-sonnet-5", true),
        ("claude-opus-5-5", true),
        ("claude-fable-5", true),
        ("anthropic/claude-haiku-4-5", true),
        ("claude-sonnet-4-20250514", false),
        ("claude-opus-4-20250514", false),
        ("claude-3-haiku-20240307", false),
        ("claude-3-5-haiku-latest", false),
        ("claude-3-7-sonnet-latest", false),
        ("claude-3", false),
        ("claude-2.1", false),
        ("claude-2", false),
        ("claude-v2:1", false),
        ("claude-instant-1.2", false),
        ("claude-instant", false),
        ("claude-20", true),
        ("claude-30", true),
        ("claude-instantly", true),
        ("gpt-4.1", false),
        ("", false),
    ];
    for (model, expected) in cases {
        assert_eq!(anthropic_output_format(model), expected, "{model}");
    }
}
