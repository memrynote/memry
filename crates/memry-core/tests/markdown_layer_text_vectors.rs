//! The `markdown-convert/layer-text.json` conformance file: the shared text
//! layers (`empty-lines`, `html-comments`, `hard-breaks`, `block-nesting`,
//! `link-references`, `markdown-code`) and the inline masks of editor-schema
//! (`token-masking`, `link-destinations`, `link-code-spans`, `cell-code-spaces`),
//! one function per case.
//!
//! The oracle shows the two per-process random words as `ABCDEFGHIJKL`; the test
//! pins the same word. Callbacks are the named stubs of `text.ts`.

#![cfg(feature = "markdown")]

mod support;

use std::collections::BTreeMap;

use memry_core::markdown::schema::{
    cell_code_spaces, link_code_spans, link_destinations, token_masking,
};
use memry_core::markdown::shared::{
    block_nesting, empty_lines, hard_breaks, html_comments, link_references, markdown_code,
};
use serde::Serialize;
use serde_json::{Value as Json, json};
use support::vector_compare::{Failures, json_equal};
use support::vector_file;

type Replacer = Box<dyn FnMut(&str, bool, bool) -> String>;

const WORD: &str = "ABCDEFGHIJKL";

fn to_json<T: Serialize>(value: &T) -> Result<Json, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

fn text(args: &[Json], at: usize) -> Result<&str, String> {
    args.get(at)
        .and_then(Json::as_str)
        .ok_or_else(|| format!("argument {at} is not a string"))
}

fn strings(args: &[Json], at: usize) -> Result<Vec<String>, String> {
    args.get(at)
        .and_then(Json::as_array)
        .ok_or_else(|| format!("argument {at} is not an array"))?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or("not a string".to_owned())
        })
        .collect()
}

fn typed<T: serde::de::DeserializeOwned>(args: &[Json], at: usize) -> Result<T, String> {
    let value = args
        .get(at)
        .ok_or_else(|| format!("argument {at} is missing"))?;
    serde_json::from_value(value.clone()).map_err(|e| e.to_string())
}

fn parse_stub(name: &str) -> Result<fn(&str) -> Vec<Json>, String> {
    Ok(match name {
        "paragraph" => |chunk| vec![json!({"type": "paragraph", "content": chunk, "children": []})],
        "lines" => |chunk| {
            chunk
                .split('\n')
                .map(|line| json!({"type": "paragraph", "content": line}))
                .collect()
        },
        "kids" => |chunk| {
            vec![json!({
                "type": "paragraph",
                "content": chunk,
                "children": [{"type": "paragraph", "content": "kid", "children": []}]
            })]
        },
        "none" => |_| Vec::new(),
        "nullChildren" => {
            |chunk| vec![json!({"type": "paragraph", "content": chunk, "children": null})]
        }
        other => return Err(format!("unknown parse stub {other}")),
    })
}

fn resolve_stub(name: &str) -> Result<fn(&str) -> Option<String>, String> {
    Ok(match name {
        "prefix" => |r| Some(format!("memry-file://vault/{r}")),
        "none" => |_| None,
        "empty" => |_| Some(String::new()),
        "onlyPng" => |r| {
            r.to_ascii_lowercase()
                .ends_with(".png")
                .then(|| format!("memry-file://png/{r}"))
        },
        other => return Err(format!("unknown resolve stub {other}")),
    })
}

fn show_blocks(blocks: &[Json]) -> Vec<Json> {
    blocks
        .iter()
        .map(|block| {
            if block_nesting::is_block_nesting_marker(block) {
                json!({"$marker": true})
            } else {
                block.clone()
            }
        })
        .collect()
}

fn fold_spec(items: &[Json]) -> Vec<Json> {
    let blocks: Vec<Json> = items
        .iter()
        .map(|item| match item.get("marker").and_then(Json::as_u64) {
            Some(level) => block_nesting::nesting_marker_block(level as f64),
            None => item["block"].clone(),
        })
        .collect();
    block_nesting::fold_block_nesting_markers(&blocks)
}

fn replace_markdown_comments(args: &[Json]) -> Result<Json, String> {
    let replacer = text(args, 1)?;
    let mut replace: Replacer = match replacer {
        "tag" => Box::new(|source, whole, goes| {
            format!(
                "[{}{}:{source}]",
                if whole { 'W' } else { 'w' },
                if goes { 'B' } else { 'b' }
            )
        }),
        "empty" => Box::new(|_, _, _| String::new()),
        other => return Err(format!("unknown replacer {other}")),
    };
    let (open, unclosed) = match text(args, 2)? {
        "default" => ("<!--", "<!--"),
        "marked" => ("~TEXT~", "~UNCLOSED~"),
        other => return Err(format!("unknown opens {other}")),
    };
    Ok(Json::String(markdown_code::replace_markdown_comments(
        text(args, 0)?,
        &mut *replace,
        open,
        unclosed,
    )))
}

fn dispatch(name: &str, args: &[Json]) -> Result<Json, String> {
    let s = |at: usize| text(args, at);
    Ok(match name {
        "emptyLines.splitMarkdownPreservingBlanks" => {
            to_json(&empty_lines::split_markdown_preserving_blanks(s(0)?))?
        }
        "emptyLines.assembleMarkdownWithBlanks" => {
            let segments: Vec<empty_lines::MarkdownSegment> = typed(args, 0)?;
            Json::String(empty_lines::assemble_markdown_with_blanks(&segments))
        }
        "emptyLines.splitByCodeFences" => to_json(&empty_lines::split_by_code_fences(s(0)?))?,
        "emptyLines.separateBlockImages" => Json::String(empty_lines::separate_block_images(s(0)?)),
        "emptyLines.extractWikiImageEmbedRefs" => {
            to_json(&empty_lines::extract_wiki_image_embed_refs(s(0)?))?
        }
        "emptyLines.rewriteWikiImageEmbeds" => {
            let stub = resolve_stub(s(1)?)?;
            Json::String(empty_lines::rewrite_wiki_image_embeds(s(0)?, &mut |r| {
                stub(r)
            }))
        }
        "emptyLines.fenceIndentedCodeBlocks" => {
            Json::String(empty_lines::fence_indented_code_blocks(s(0)?))
        }
        "emptyLines.normalizeSerializedMarkdown" => {
            Json::String(empty_lines::normalize_serialized_markdown(s(0)?))
        }
        "emptyLines.escapeWikiLinkPipesInTableRows" => {
            Json::String(empty_lines::escape_wiki_link_pipes_in_table_rows(s(0)?))
        }

        "htmlComments.encodeHtmlCommentToken" => {
            Json::String(html_comments::encode_html_comment_token(s(0)?))
        }
        "htmlComments.hasHtmlCommentToken" => {
            Json::Bool(html_comments::has_html_comment_token(s(0)?))
        }
        "htmlComments.decodeHtmlCommentTokens" => {
            Json::String(html_comments::decode_html_comment_tokens(s(0)?))
        }
        "htmlComments.splitHtmlCommentTokens" => {
            to_json(&html_comments::split_html_comment_tokens(s(0)?))?
        }
        "htmlComments.maskHtmlComments" => Json::String(html_comments::mask_html_comments(s(0)?)),
        "htmlComments.maskDecodeSplit" => {
            let masked = html_comments::mask_html_comments(s(0)?);
            json!({
                "masked": masked,
                "decoded": html_comments::decode_html_comment_tokens(&masked),
                "parts": html_comments::split_html_comment_tokens(&masked),
                "has": html_comments::has_html_comment_token(&masked),
            })
        }

        "hardBreaks.maskHardBreaks" => to_json(&hard_breaks::mask_hard_breaks(s(0)?))?,
        "hardBreaks.unmaskHardBreaks" => Json::String(hard_breaks::unmask_hard_breaks(s(0)?)),
        "hardBreaks.restoreHardBreakSpelling" => Json::String(
            hard_breaks::restore_hard_break_spelling(s(0)?, &strings(args, 1)?),
        ),
        "hardBreaks.hasHardBreakToken" => Json::Bool(hard_breaks::has_hard_break_token(s(0)?)),
        "hardBreaks.maskThenUnmask" => {
            let masked = hard_breaks::mask_hard_breaks(s(0)?);
            json!({
                "masked": masked,
                "prose": hard_breaks::unmask_hard_breaks(&masked.markdown),
                "code": hard_breaks::restore_hard_break_spelling(&masked.markdown, &masked.breaks),
            })
        }

        "blockNesting.createBlockNestingMarker" => {
            let level = args.first().and_then(Json::as_f64).ok_or("level")?;
            Json::String(block_nesting::create_block_nesting_marker(level))
        }
        "blockNesting.splitMarkdownByBlockNestingMarkers" => to_json(
            &block_nesting::split_markdown_by_block_nesting_markers(s(0)?),
        )?,
        "blockNesting.parseMarkdownWithNestingMarkers" => {
            let stub = parse_stub(s(1)?)?;
            let blocks =
                block_nesting::parse_markdown_with_nesting_markers(s(0)?, &mut |c| stub(c));
            Json::Array(show_blocks(&blocks))
        }
        "blockNesting.parseAndFold" => {
            let stub = parse_stub(s(1)?)?;
            let blocks =
                block_nesting::parse_markdown_with_nesting_markers(s(0)?, &mut |c| stub(c));
            Json::Array(block_nesting::fold_block_nesting_markers(&blocks))
        }
        "blockNesting.restoreBlockNesting" => {
            let blocks: Vec<Json> = typed(args, 0)?;
            let levels: Vec<f64> = typed(args, 1)?;
            Json::Array(block_nesting::restore_block_nesting(&blocks, &levels))
        }
        "blockNesting.foldSpec" => {
            let items: Vec<Json> = typed(args, 0)?;
            Json::Array(fold_spec(&items))
        }

        "linkReferences.normalizeLinkReferenceLabel" => {
            Json::String(link_references::normalize_link_reference_label(s(0)?))
        }
        "linkReferences.stripLinkReferenceDefinitions" => {
            to_json(&link_references::strip_link_reference_definitions(s(0)?))?
        }
        "linkReferences.inlineLinkReferences" => {
            let usages: Vec<link_references::LinkReferenceUsage> = typed(args, 1)?;
            Json::String(link_references::inline_link_references(s(0)?, &usages))
        }
        "linkReferences.restoreLinkReferences" => {
            let definitions: Vec<link_references::LinkReferenceDefinition> = typed(args, 1)?;
            let usages: Vec<link_references::LinkReferenceUsage> = typed(args, 2)?;
            Json::String(link_references::restore_link_references(
                s(0)?,
                &definitions,
                &usages,
            ))
        }
        "linkReferences.stripInlineRestore" => {
            let stripped = link_references::strip_link_reference_definitions(s(0)?);
            let inlined =
                link_references::inline_link_references(&stripped.markdown, &stripped.usages);
            let restored = link_references::restore_link_references(
                &inlined,
                &stripped.definitions,
                &stripped.usages,
            );
            json!({"stripped": stripped, "inlined": inlined, "restored": restored})
        }

        "markdownCode.blankMarkdownCode" => Json::String(markdown_code::blank_markdown_code(s(0)?)),
        "markdownCode.maskMarkdownCode" => Json::String(markdown_code::mask_markdown_code(s(0)?)),
        "markdownCode.stripMarkdownComments" => {
            Json::String(markdown_code::strip_markdown_comments(s(0)?))
        }
        "markdownCode.replaceMarkdownComments" => replace_markdown_comments(args)?,

        "tokenMasking.maskInlineTokens" => to_json(&token_masking::mask_inline_tokens(s(0)?))?,
        "tokenMasking.maskRestore" => {
            let masked = token_masking::mask_inline_tokens(s(0)?);
            let restored = token_masking::restore_inline_tokens(&masked.markdown, &masked.tokens);
            json!({"masked": masked, "restored": restored})
        }
        "tokenMasking.restoreInlineTokens" => Json::String(token_masking::restore_inline_tokens(
            s(0)?,
            &strings(args, 1)?,
        )),

        "linkDestinations.linkDestination" => {
            Json::String(link_destinations::link_destination(s(0)?))
        }
        "linkDestinations.withLinkDestination" => {
            Json::String(link_destinations::with_link_destination(s(0)?, s(1)?))
        }
        "linkDestinations.maskLinkDestinations" => {
            to_json(&link_destinations::mask_link_destinations(s(0)?))?
        }
        "linkDestinations.maskRestore" => {
            let masked = link_destinations::mask_link_destinations(s(0)?);
            let restored = link_destinations::restore_link_destinations(
                &masked.markdown,
                &masked.destinations,
            );
            json!({"masked": masked, "restored": restored})
        }
        "linkDestinations.restoreLinkDestinations" => Json::String(
            link_destinations::restore_link_destinations(s(0)?, &strings(args, 1)?),
        ),

        "linkCodeSpans.linkCodeAsText" => Json::String(link_code_spans::link_code_as_text(s(0)?)),
        "linkCodeSpans.codeSpanRanges" => to_json(&link_code_spans::code_span_ranges(s(0)?))?,

        "cellCodeSpaces.maskCellCodeSpaces" => {
            to_json(&cell_code_spaces::mask_cell_code_spaces(s(0)?))?
        }
        "cellCodeSpaces.maskRestore" => {
            let masked = cell_code_spaces::mask_cell_code_spaces(s(0)?);
            let restored =
                cell_code_spaces::restore_cell_code_spaces(&masked.markdown, &masked.spaces);
            json!({"masked": masked, "restored": restored})
        }
        "cellCodeSpaces.restoreCellCodeSpaces" => Json::String(
            cell_code_spaces::restore_cell_code_spaces(s(0)?, &strings(args, 1)?),
        ),

        other => return Err(format!("no Rust function for {other}")),
    })
}

#[test]
fn text_layer_vectors() {
    html_comments::pin_process_word(WORD).expect("pin the comment token word");
    link_destinations::pin_process_word(WORD).expect("pin the placeholder word");

    let vectors = vector_file("markdown-convert/layer-text");
    let mut failures = Failures::default();
    let mut per_fn: BTreeMap<String, usize> = BTreeMap::new();
    for case in vectors["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let name = case["input"]["fn"].as_str().expect("fn");
        let args = case["input"]["args"].as_array().expect("args");
        *per_fn.entry(name.to_owned()).or_default() += 1;
        let expected = &case["expected"];
        let actual = dispatch(name, args);
        let outcome = match (expected["status"].as_str(), actual) {
            (Some("ok"), Ok(value)) => json_equal(&expected["output"], &value),
            (Some("ok"), Err(e)) => Err(format!("failed: {e}")),
            (Some("error"), Ok(_)) => Err("the oracle threw, the port did not".into()),
            (Some("error"), Err(_)) => Ok(()),
            _ => Err("unknown status".into()),
        };
        failures.check(id, outcome);
    }
    for (name, count) in &per_fn {
        println!("{name}: {count}");
    }
    println!(
        "layer-text: {} cases, {} functions",
        failures.checked(),
        per_fn.len()
    );
    assert!(
        failures.checked() > 1000,
        "the vector file is missing cases"
    );
    failures.finish("layer-text");
}
