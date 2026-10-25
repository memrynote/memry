//! One arm per oracle function name: JSON arguments in, the JSON the
//! TypeScript returned out. `Err` is the oracle's "threw".

use memry_core::markdown::schema::blocks::callout::{
    CalloutRun, callout_marker, read_callout_run, resolve_callout_run, serialize_callout_block,
};
use memry_core::markdown::schema::blocks::embeds::{
    bookmark_line_url, parse_whiteboard_line, parse_youtube_embed_line, serialize_bookmark,
    serialize_whiteboard, serialize_youtube_embed, whiteboard_url,
};
use memry_core::markdown::schema::blocks::file::{
    FileBlockProps, file_block_comment_data, is_file_block_line, parse_file_block_marker,
    serialize_file_block,
};
use memry_core::markdown::schema::blocks::math::{read_math_run, serialize_math_block};
use memry_core::markdown::schema::blocks::toggle::{
    restore_details_markup, serialize_toggle_block, split_markdown_by_toggles,
};
use memry_core::markdown::schema::callout_types::{
    CalloutTypeDefinition, CalloutTypes, is_built_in_callout_type, is_callout_type_name_syntax,
    sanitize_callout_type_definitions,
};
use memry_core::markdown::schema::columns::{
    ColumnContentSegment, build_column_list_block, column_region_id_for, column_settings_for,
    column_widths_from_settings, serialize_column_list_block, serialize_column_region,
    split_markdown_by_column_regions,
};
use memry_core::markdown::schema::quote::{
    QuoteRun, item_holds_non_list, read_structured_quote_run, resolve_quote_run,
    serialize_quote_block,
};
use memry_core::markdown::shared::youtube::{extract_youtube_video_id, get_youtube_thumbnail_url};
use serde_json::{Value, json};

use crate::scan::scan_all;
use crate::stubs::Stub;

struct Args<'a>(&'a [Value]);

impl Args<'_> {
    fn str(&self, i: usize) -> &str {
        self.0[i].as_str().expect("string argument")
    }
    fn opt_str(&self, i: usize) -> Option<&str> {
        self.0[i].as_str()
    }
    fn usize(&self, i: usize) -> usize {
        usize::try_from(self.0[i].as_u64().expect("integer argument")).expect("fits")
    }
    fn bool(&self, i: usize) -> bool {
        self.0[i].as_bool().expect("boolean argument")
    }
    fn strings(&self, i: usize) -> Vec<String> {
        self.0[i]
            .as_array()
            .expect("array argument")
            .iter()
            .map(|s| s.as_str().expect("string item").to_owned())
            .collect()
    }
    fn numbers(&self, i: usize) -> Vec<f64> {
        self.0[i]
            .as_array()
            .expect("array argument")
            .iter()
            .map(|n| n.as_f64().expect("number item"))
            .collect()
    }
    fn stub(&self, i: usize) -> Stub {
        Stub::from_spec(&self.0[i])
    }
    fn custom(&self, i: usize) -> CalloutTypes {
        custom_types(&self.strings(i))
    }
    fn typed<T: serde::de::DeserializeOwned>(&self, i: usize) -> T {
        serde_json::from_value(self.0[i].clone()).expect("typed argument")
    }
}

fn custom_types(names: &[String]) -> CalloutTypes {
    CalloutTypes::new(names.iter().map(|name| CalloutTypeDefinition {
        name: name.clone(),
        label: name.clone(),
        color: "#000000".to_owned(),
        icon: "x".to_owned(),
    }))
}

fn json_of<T: serde::Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

fn file_props(value: &Value) -> FileBlockProps {
    let text = |key: &str| value[key].as_str().unwrap_or("").to_owned();
    FileBlockProps {
        url: text("url"),
        name: text("name"),
        size: value["size"].as_f64().unwrap_or(f64::NAN),
        mime_type: text("mimeType"),
        width: value["width"].as_f64(),
        height: value["height"].as_f64(),
        align: value["align"].as_str().map(str::to_owned),
        display: value["display"].as_str().map(str::to_owned),
    }
}

fn segment_of(value: &Value) -> ColumnContentSegment {
    if value["kind"] == "columns" {
        ColumnContentSegment::Columns {
            region_id: value["regionId"].as_str().expect("regionId").to_owned(),
            settings: value["settings"].as_str().expect("settings").to_owned(),
            columns: value["columns"]
                .as_array()
                .expect("columns")
                .iter()
                .map(|c| c.as_str().expect("column").to_owned())
                .collect(),
        }
    } else {
        ColumnContentSegment::Markdown {
            text: value["text"].as_str().unwrap_or("").to_owned(),
        }
    }
}

pub fn run(name: &str, args: &[Value]) -> Result<Value, String> {
    let a = Args(args);
    match name {
        "calloutTypes.sanitize" => json_of(&sanitize_callout_type_definitions(&args[0])),
        "calloutTypes.isName" => Ok(json!(a.custom(1).is_callout_type_name(a.str(0)))),
        "calloutTypes.isBuiltIn" => Ok(json!(is_built_in_callout_type(a.str(0)))),
        "calloutTypes.isNameSyntax" => Ok(json!(is_callout_type_name_syntax(a.str(0)))),
        "calloutTypes.definitions" => {
            let definitions: Vec<CalloutTypeDefinition> = a.typed(0);
            json_of(&CalloutTypes::new(definitions).definitions())
        }

        "callout.marker" => Ok(json!(callout_marker(a.str(0), a.opt_str(1)))),
        "callout.serialize" => Ok(json!(serialize_callout_block(
            a.str(0),
            a.str(1),
            a.opt_str(2)
        ))),
        "callout.read" => json_of(&read_callout_run(
            &a.strings(0),
            a.usize(1),
            a.bool(2),
            &a.custom(3),
        )),
        "callout.resolve" => {
            let run: CalloutRun = a.typed(0);
            let stub = a.stub(2);
            let resolved =
                resolve_callout_run(&run, &a.custom(1), &mut |m| stub.parse(m), &mut |b| {
                    stub.serialize(b)
                })?;
            json_of(&resolved)
        }
        "callout.readAndResolve" => {
            let types = a.custom(3);
            let stub = a.stub(4);
            let Some(run) = read_callout_run(&a.strings(0), a.usize(1), a.bool(2), &types) else {
                return Ok(Value::Null);
            };
            let resolved = resolve_callout_run(&run, &types, &mut |m| stub.parse(m), &mut |b| {
                stub.serialize(b)
            })?;
            json_of(&resolved)
        }

        "quote.serialize" => Ok(json!(serialize_quote_block(a.str(0)))),
        "quote.read" => json_of(&read_structured_quote_run(&a.strings(0), a.usize(1))),
        "quote.resolve" => {
            let run: QuoteRun = a.typed(0);
            let stub = a.stub(1);
            let resolved =
                resolve_quote_run(&run, &mut |m| stub.parse(m), &mut |b| stub.serialize(b))?;
            json_of(&resolved)
        }
        "quote.readAndResolve" => {
            let stub = a.stub(2);
            let Some(run) = read_structured_quote_run(&a.strings(0), a.usize(1)) else {
                return Ok(Value::Null);
            };
            let resolved =
                resolve_quote_run(&run, &mut |m| stub.parse(m), &mut |b| stub.serialize(b))?;
            json_of(&resolved)
        }
        "quote.itemHoldsNonList" => Ok(json!(item_holds_non_list(&args[0]))),

        "math.serialize" => Ok(json!(serialize_math_block(a.str(0)))),
        "math.read" => json_of(&read_math_run(&a.strings(0), a.usize(1), a.bool(2))),

        "toggle.serialize" => Ok(json!(serialize_toggle_block(
            a.str(0),
            a.str(1),
            a.opt_str(2),
            a.bool(3)
        ))),
        "toggle.split" => json_of(&split_markdown_by_toggles(a.str(0))),
        "toggle.restore" => Ok(json!(restore_details_markup(a.str(0)))),

        "file.parse" => Ok(parse_file_block_marker(a.str(0)).unwrap_or(Value::Null)),
        "file.isLine" => Ok(json!(is_file_block_line(a.str(0)))),
        "file.serialize" => Ok(json!(serialize_file_block(&file_props(&args[0])))),
        "file.commentData" => Ok(json!(file_block_comment_data(&file_props(&args[0])))),

        "embeds.bookmarkUrl" => Ok(json!(bookmark_line_url(a.str(0)))),
        "embeds.parseYoutube" => json_of(&parse_youtube_embed_line(a.str(0))),
        "embeds.parseWhiteboard" => Ok(json!(parse_whiteboard_line(a.str(0)))),
        "embeds.serializeYoutube" => Ok(json!(serialize_youtube_embed(a.str(0), a.opt_str(1)))),
        "embeds.serializeBookmark" => Ok(json!(serialize_bookmark(a.str(0)))),
        "embeds.serializeWhiteboard" => Ok(json!(serialize_whiteboard(a.str(0)))),
        "embeds.whiteboardUrl" => Ok(json!(whiteboard_url(a.str(0)))),

        "youtube.extractId" => Ok(json!(extract_youtube_video_id(a.str(0)))),
        "youtube.thumbnail" => Ok(json!(get_youtube_thumbnail_url(a.str(0)))),

        "columns.split" => json_of(&split_markdown_by_column_regions(a.str(0))),
        "columns.widths" => Ok(json!(column_widths_from_settings(a.str(0), a.usize(1)))),
        "columns.settingsFor" => Ok(json!(column_settings_for(a.str(0), &a.numbers(1)))),
        "columns.regionIdFor" => Ok(json!(column_region_id_for(a.str(0), a.opt_str(1)))),
        "columns.serializeRegion" => Ok(json!(serialize_column_region(
            a.str(0),
            a.str(1),
            &a.strings(2)
        ))),
        "columns.build" => {
            let stub = a.stub(1);
            let mut count = 0;
            let mut new_id = || {
                count += 1;
                format!("id-{count}")
            };
            build_column_list_block(
                &segment_of(&args[0]),
                &mut |m| stub.parse(m),
                &mut || json!({"type": "paragraph", "props": {}, "content": [], "children": []}),
                if a.bool(2) { Some(&mut new_id) } else { None },
            )
        }
        "columns.serializeList" => {
            let stub = a.stub(1);
            serialize_column_list_block(&args[0], &mut |blocks| stub.serialize(blocks))
                .map(|s| json!(s))
        }

        "scan.all" => scan_all(a.str(0), &a.custom(1)),
        other => Err(format!("no Rust dispatch for {other}")),
    }
}
