//! The `markdown-convert/layer-critic.json` conformance file: CriticMarkup
//! parsing and transforms, the per-id write of the `criticMarkupMarks` root,
//! the writing tools marker codec and frontmatter, and the image lift of
//! editor-schema, against the TypeScript they port.

#![cfg(feature = "markdown")]

#[allow(unused_imports)]
use crate::support;

use std::collections::BTreeSet;

use memry_core::markdown::convert::roots::{
    CRITIC_MARKUP_MARKS_ARRAY, critic_mark_array_operations, read_array_json, read_critic_marks,
    write_critic_marks,
};
use memry_core::markdown::pm::model::json_to_any;
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
use memry_test_kit::assert_steps_at_most;
use serde::de::DeserializeOwned;
use serde_json::{Value as Json, json};
use support::vector_compare::{Failures, json_equal};
use support::vector_file;
use yrs::updates::decoder::Decode;
use yrs::{Any, Array as _, Doc, ReadTxn, StateVector, Transact, Update};

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

fn full_update(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn apply(doc: &Doc, update: &[u8]) -> Result<(), String> {
    let update = Update::decode_v1(update).map_err(|e| e.to_string())?;
    doc.transact_mut()
        .apply_update(update)
        .map_err(|e| e.to_string())
}

/// `yjsWrite` of the oracle (`critic-fns.ts`): each writer writes on its own
/// replica of `base` (client id `10 + i`), and one document merges them all.
fn yjs_write(args: &[Json]) -> Result<Json, String> {
    let base: Vec<Json> = arg(args, 0)?;
    let writes: Vec<Vec<CriticMarkupMark>> = arg(args, 1)?;
    let origin = Doc::with_client_id(1);
    let array = origin.get_or_insert_array(CRITIC_MARKUP_MARKS_ARRAY);
    array.insert_range(
        &mut origin.transact_mut(),
        0,
        base.iter().map(json_to_any).collect::<Vec<Any>>(),
    );
    let start = full_update(&origin);
    let merged = Doc::with_client_id(2);
    apply(&merged, &start)?;
    let mut changed = Vec::new();
    for (index, marks) in writes.iter().enumerate() {
        let replica = Doc::with_client_id(10 + index as u64);
        apply(&replica, &start)?;
        let before = full_update(&replica);
        write_critic_marks(&mut replica.transact_mut(), marks);
        let after = full_update(&replica);
        apply(&merged, &after)?;
        changed.push(Json::Bool(before != after));
    }
    let txn = merged.transact();
    Ok(json!({
        "changed": changed,
        "elements": read_array_json(&txn, CRITIC_MARKUP_MARKS_ARRAY),
        "marks": to_json(&read_critic_marks(&txn))?,
    }))
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

        "critic.yjsWrite" => yjs_write(args),

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

/// Every yrs array operation walks the array from its start, so a write
/// coalesces runs: one operation per run of deletes, two per run of
/// replacements, and none for an untouched element.
#[test]
fn critic_mark_writes_make_one_array_operation_per_changed_run() {
    let many: Vec<CriticMarkupMark> = (0..1000)
        .map(|index| {
            serde_json::from_value(json!({
                "id": format!("m{index}"), "kind": "addition", "visibleText": "more",
                "start": index * 10, "end": index * 10 + 4,
            }))
            .expect("mark")
        })
        .collect();
    let edited = |mark: &CriticMarkupMark| CriticMarkupMark {
        visible_text: "edit".into(),
        ..mark.clone()
    };
    let cases: Vec<(&str, Vec<CriticMarkupMark>, usize)> = vec![
        ("every mark edited", many.iter().map(edited).collect(), 2),
        (
            "every other mark edited",
            many.iter()
                .enumerate()
                .map(|(i, m)| if i % 2 == 0 { edited(m) } else { m.clone() })
                .collect(),
            1000,
        ),
        (
            "every other mark deleted",
            many.iter().step_by(2).cloned().collect(),
            500,
        ),
        (
            "every hundredth mark edited",
            many.iter()
                .enumerate()
                .map(|(i, m)| if i % 100 == 0 { edited(m) } else { m.clone() })
                .collect(),
            20,
        ),
        (
            "offsets moved only",
            many.iter()
                .map(|m| CriticMarkupMark {
                    start: m.start + 1,
                    end: m.end + 1,
                    ..m.clone()
                })
                .collect(),
            0,
        ),
    ];
    for (what, next, bound) in cases {
        let doc = Doc::new();
        write_critic_marks(&mut doc.transact_mut(), &many);
        assert_steps_at_most(what, critic_mark_array_operations, bound, || {
            write_critic_marks(&mut doc.transact_mut(), &next);
        });
        let read = read_critic_marks(&doc.transact());
        let expected: Vec<&str> = next.iter().map(|mark| mark.visible_text.as_str()).collect();
        assert_eq!(
            read.iter()
                .map(|mark| mark.visible_text.as_str())
                .collect::<Vec<_>>(),
            expected,
            "{what}"
        );
    }
}

/// REVIEW-5839B: the whole-list write (`apply_fragment_side_channels`) keeps
/// an element this build cannot read, such as a newer build's `kind`, and the
/// unknown fields of a known mark, as `updateCriticMarkupMarksInYDoc` does.
#[test]
fn critic_mark_write_keeps_unreadable_elements_and_unknown_fields() {
    let c1 = json!({"id": "c1", "kind": "comment", "visibleText": "alpha", "body": "one", "start": 0, "end": 5, "future": 1});
    let newer = json!({"id": "n1", "kind": "highlight", "visibleText": "x", "start": 0, "end": 1, "tone": "y"});
    let unreadable = [
        Json::Null,
        json!("x"),
        json!({"id": "c2", "kind": "comment", "visibleText": "b", "start": 0, "end": -1}),
    ];
    let mut base = vec![c1.clone(), newer.clone()];
    base.extend(unreadable.iter().cloned());
    let doc = Doc::new();
    doc.get_or_insert_array(CRITIC_MARKUP_MARKS_ARRAY)
        .insert_range(
            &mut doc.transact_mut(),
            0,
            base.iter().map(json_to_any).collect::<Vec<Any>>(),
        );
    let mut edited: CriticMarkupMark = serde_json::from_value(c1.clone()).expect("mark");
    edited.body = Some("edit".into());

    write_critic_marks(&mut doc.transact_mut(), &[edited]);

    let mut expected = vec![
        json!({"id": "c1", "kind": "comment", "visibleText": "alpha", "body": "edit", "start": 0, "end": 5, "future": 1}),
        newer,
    ];
    expected.extend(unreadable);
    assert_eq!(
        read_array_json(&doc.transact(), CRITIC_MARKUP_MARKS_ARRAY),
        expected
    );
}
