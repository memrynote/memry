//! The `markdown-convert/layer-critic.json` conformance file: CriticMarkup
//! parsing and transforms, the writing tools marker codec and frontmatter, and
//! the image lift of editor-schema, against the TypeScript they port.

#![cfg(feature = "markdown")]

mod support;

use std::collections::BTreeSet;

use memry_core::markdown::schema::lift_images::lift_images_out_of_text_blocks;
use memry_core::markdown::shared::critic_markup::{
    CriticMarkupMark, ParsedCriticMarkup, TransformResult, accept_critic_mark,
    build_comment_payload, critic_markup_comment_body_hash, delete_critic_mark,
    normalize_critic_markup_comment_attachments, normalize_critic_markup_comment_format_ranges,
    normalize_critic_markup_comment_mentions, parse_critic_markup,
    parse_critic_markup_comment_format, reject_critic_mark, resolve_critic_mark,
    serialize_critic_markup,
};
use memry_core::markdown::shared::writing_tools::{
    WritingFrontmatter, WritingSentinelMap, create_sentinel_allocator, decode_writing_markers,
    encode_writing_body, is_writing_alternative_id, is_writing_frontmatter_value,
    read_writing_frontmatter, strip_writing_sentinels, to_writing_frontmatter_value,
    without_writing_sentinels, writing_frontmatter_of,
};
use serde::de::DeserializeOwned;
use serde_json::{Value as Json, json};
use support::vector_compare::{Failures, json_equal};
use support::vector_file;

fn arg<T: DeserializeOwned>(args: &[Json], index: usize) -> Result<T, String> {
    let value = args.get(index).ok_or(format!("missing argument {index}"))?;
    serde_json::from_value(value.clone()).map_err(|e| format!("argument {index}: {e}"))
}

fn text(args: &[Json], index: usize) -> Result<String, String> {
    arg(args, index)
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<Json, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

fn option_json<T: serde::Serialize>(value: &Option<T>) -> Result<Json, String> {
    match value {
        Some(inner) => to_json(inner),
        None => Ok(Json::Null),
    }
}

fn transform(result: TransformResult) -> Result<Json, String> {
    Ok(json!({"plainText": result.plain_text, "marks": to_json(&result.marks)?}))
}

/// A `Pick<CriticMarkupMark, ...>` argument, completed to a whole mark.
fn pick_mark(args: &[Json]) -> Result<CriticMarkupMark, String> {
    let mut value = args.first().cloned().ok_or("missing mark")?;
    let object = value.as_object_mut().ok_or("mark is not an object")?;
    for (key, default) in [
        ("kind", json!("comment")),
        ("visibleText", json!("")),
        ("start", json!(0)),
        ("end", json!(0)),
    ] {
        object.entry(key).or_insert(default);
    }
    serde_json::from_value(value).map_err(|e| e.to_string())
}

fn marks_of(args: &[Json], index: usize) -> Result<Vec<CriticMarkupMark>, String> {
    arg(args, index)
}

/// `None` when the function name has no Rust dispatch.
fn dispatch(name: &str, args: &[Json], expected: &Json) -> Option<Result<Json, String>> {
    Some(match name {
        "critic.parseCriticMarkup" => text(args, 0).and_then(|m| to_json(&parse_critic_markup(&m))),
        "critic.serializeCriticMarkup" => text(args, 0)
            .and_then(|p| Ok(serialize_critic_markup(&p, &marks_of(args, 1)?)))
            .map(Json::String),
        "critic.buildCommentPayload" => {
            pick_mark(args).map(|m| Json::String(build_comment_payload(&m)))
        }
        "critic.normalizeMentions" => args
            .first()
            .ok_or("missing value".to_owned())
            .and_then(|v| option_json(&normalize_critic_markup_comment_mentions(v))),
        "critic.normalizeAttachments" => args
            .first()
            .ok_or("missing value".to_owned())
            .and_then(|v| option_json(&normalize_critic_markup_comment_attachments(v))),
        "critic.normalizeFormatRanges" => (|| {
            let length: usize = arg(args, 1)?;
            let value = args.first().ok_or("missing value")?;
            option_json(&normalize_critic_markup_comment_format_ranges(
                value, length,
            ))
        })(),
        "critic.parseCommentFormat" => (|| {
            let encoded: Option<String> = arg(args, 0)?;
            option_json(&parse_critic_markup_comment_format(
                encoded.as_deref(),
                &text(args, 1)?,
            ))
        })(),
        "critic.bodyHash" => {
            text(args, 0).map(|b| Json::String(critic_markup_comment_body_hash(&b)))
        }
        "critic.acceptCriticMark"
        | "critic.rejectCriticMark"
        | "critic.resolveCriticMark"
        | "critic.deleteCriticMark" => (|| {
            let (plain, marks, id) = (text(args, 0)?, marks_of(args, 1)?, text(args, 2)?);
            transform(match name {
                "critic.acceptCriticMark" => accept_critic_mark(&plain, &marks, &id),
                "critic.rejectCriticMark" => reject_critic_mark(&plain, &marks, &id),
                "critic.resolveCriticMark" => resolve_critic_mark(&plain, &marks, &id),
                _ => delete_critic_mark(&plain, &marks, &id),
            })
        })(),

        "writing.decodeWritingMarkers" => text(args, 0).and_then(|m| {
            let decoded = decode_writing_markers(&m);
            Ok(json!({"text": decoded.text, "sentinels": to_json(&decoded.sentinels)?}))
        }),
        "writing.stripWritingSentinels" => (|| {
            let sentinels: WritingSentinelMap = arg(args, 1)?;
            Ok(Json::String(strip_writing_sentinels(
                &text(args, 0)?,
                &sentinels,
            )))
        })(),
        "writing.withoutWritingSentinels" => (|| {
            let parsed: ParsedCriticMarkup = arg(args, 0)?;
            let sentinels: WritingSentinelMap = arg(args, 1)?;
            to_json(&without_writing_sentinels(&parsed, &sentinels))
        })(),
        "writing.encodeWritingBody" => (|| {
            let sentinels: WritingSentinelMap = arg(args, 1)?;
            Ok(Json::String(encode_writing_body(
                &text(args, 0)?,
                &sentinels,
                &marks_of(args, 2)?,
            )))
        })(),
        "writing.createSentinelAllocator" => (|| {
            let count: usize = arg(args, 1)?;
            let mut allocate = create_sentinel_allocator(&text(args, 0)?);
            Ok(Json::Array(
                (0..count)
                    .map(|_| allocate().map_or(Json::Null, |ch| Json::String(ch.to_string())))
                    .collect(),
            ))
        })(),
        "writing.isWritingAlternativeId" => {
            text(args, 0).map(|id| Json::Bool(is_writing_alternative_id(&id)))
        }
        "writing.readWritingFrontmatter" => args
            .first()
            .ok_or("missing value".to_owned())
            .and_then(|v| option_json(&read_writing_frontmatter(v))),
        "writing.writingFrontmatterOf" => args
            .first()
            .ok_or("missing value".to_owned())
            .and_then(|v| to_json(&writing_frontmatter_of((!v.is_null()).then_some(v)))),
        "writing.isWritingFrontmatterValue" => args
            .first()
            .ok_or("missing value".to_owned())
            .map(|v| Json::Bool(is_writing_frontmatter_value(v))),
        "writing.toWritingFrontmatterValue" => arg::<WritingFrontmatter>(args, 0)
            .map(|w| to_writing_frontmatter_value(&w).unwrap_or(Json::Null)),

        "liftImages.liftImagesOutOfTextBlocks" => text(args, 0)
            .map(|html| lift_images_out_of_text_blocks(&html).map_or(Json::Null, Json::String)),
        // The oracle states BlockNote's HTML for the markdown; the lift reads it back.
        "liftImages.liftFromMarkdown" => expected["output"]["html"]
            .as_str()
            .ok_or("the oracle gave no html".to_owned())
            .map(|html| {
                json!({
                    "html": html,
                    "lifted": lift_images_out_of_text_blocks(html).map_or(Json::Null, Json::String),
                })
            }),
        _ => return None,
    })
}

#[test]
fn critic_layer_vectors() {
    let vectors = vector_file("markdown-convert/layer-critic");
    let mut failures = Failures::default();
    let mut names = BTreeSet::new();
    for case in vectors["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let name = case["input"]["fn"].as_str().expect("fn");
        names.insert(name.to_owned());
        let args = case["input"]["args"].as_array().expect("args");
        let expected = &case["expected"];
        let actual = dispatch(name, args, expected)
            .unwrap_or_else(|| panic!("{id}: no Rust dispatch for {name}"));
        let outcome = match (expected["status"].as_str(), actual) {
            (Some("ok"), Ok(value)) => json_equal(&expected["output"], &value),
            (Some("ok"), Err(e)) => Err(format!("failed: {e}")),
            (Some("error"), Ok(_)) => Err("the oracle threw, the port did not".into()),
            (Some("error"), Err(_)) => Ok(()),
            _ => Err("unknown status".into()),
        };
        failures.check(id, outcome);
    }
    println!(
        "layer-critic: {} cases over {} functions",
        failures.checked(),
        names.len()
    );
    failures.finish("layer-critic");
}
