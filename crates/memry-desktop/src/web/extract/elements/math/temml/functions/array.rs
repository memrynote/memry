//! `environments/array.js`: `parseArray` and the handlers of the array-based environments.
//! The group builder is in `array_build.rs`.

use super::array_build::array_builder;
use super::border_tree::bordermatrix_parse_tree;
use super::cd::parse_cd;
use super::delimiter::check_symbol_node;
use super::{EnvCtx, Registry, assert_node_type};
use crate::node;
use crate::web::extract::elements::math::temml::macro_expander::MacroDef;
use crate::web::extract::elements::math::temml::macros::string_from_arg;
use crate::web::extract::elements::math::temml::parser::Parser;
use crate::web::extract::elements::math::temml::val::{R, V, jserr, perr, perr_at, tok};
use crate::web::extract::utils::js::to_number;
use regex::Regex;
use std::sync::LazyLock;

/// `getHLines(parser)`: for each `\hline` or `\hdashline`, whether it is dashed.
fn get_hlines(parser: &mut Parser) -> R<V> {
    let info = V::arr(Vec::new());
    parser.consume_spaces()?;
    let mut nxt = parser.fetch_text()?;
    if nxt == "\\relax" {
        parser.consume();
        parser.consume_spaces()?;
        nxt = parser.fetch_text()?;
    }
    while nxt == "\\hline" || nxt == "\\hdashline" {
        parser.consume();
        info.push(V::Bool(nxt == "\\hdashline"));
        parser.consume_spaces()?;
        nxt = parser.fetch_text()?;
    }
    Ok(info)
}

fn validate_ams_environment_context(ctx: &EnvCtx) -> R<()> {
    if !ctx.parser.settings.display_mode {
        return perr(format!(
            "{{{}}} can be used only in display mode.",
            ctx.env_name
        ));
    }
    Ok(())
}

static SIZE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"([-+]?) *([0-9]+(?:\.[0-9]*)?|\.[0-9]+) *([a-z]{2})").expect("regex")
});

/// A macro's text, as `typeof m === "string" ? m : stringFromArg(m.tokens)`.
fn macro_text(def: Option<MacroDef>) -> R<String> {
    match def {
        Some(MacroDef::Text(s)) => Ok(s),
        Some(MacroDef::Exp(e)) => Ok(string_from_arg(&e.tokens)),
        _ => jserr("Cannot read properties of undefined (reading 'tokens')"),
    }
}

/// `arrayGaps(macros)`: `[arraystretch, arraycolsep]` as a number or null, and a size or null.
fn array_gaps(parser: &Parser) -> R<(V, V)> {
    let stretch = macro_text(parser.gullet.macros.get("\\arraystretch"))?;
    let stretch = to_number(&stretch);
    let arraystretch = if stretch.is_nan() {
        V::Null
    } else {
        V::Num(stretch)
    };
    let colsep = macro_text(parser.gullet.macros.get("\\arraycolsep"))?;
    let arraycolsep = match SIZE_RE.captures(&colsep) {
        Some(m) => {
            let size = V::new_obj();
            size.set("number", V::Num(to_number(&format!("{}{}", &m[1], &m[2]))));
            size.set("unit", V::Str(m[3].to_string()));
            size
        }
        None => V::Null,
    };
    Ok((arraystretch, arraycolsep))
}

/// `checkCellForLabels(cell)`.
fn check_cell_for_labels(cell: &[V]) -> R<String> {
    let mut row_label = String::new();
    for item in cell {
        if item.is_type("label") {
            if !row_label.is_empty() {
                return perr("Multiple \\labels in one row");
            }
            row_label = item.text("string");
        }
    }
    Ok(row_label)
}

/// `getAutoTag(name)`: undefined for a not-top-level environment.
fn get_auto_tag(name: &str) -> Option<bool> {
    if !name.contains("ed") {
        return Some(!name.contains('*'));
    }
    None
}

#[derive(Default)]
pub struct ArrayOpts {
    pub cols: Option<V>,
    pub env_classes: Vec<&'static str>,
    pub auto_tag: Option<bool>,
    pub single_row: bool,
    pub empty_single_row: bool,
    pub max_num_cols: usize,
    pub leqno: bool,
    pub arraystretch: Option<V>,
    pub arraycolsep: Option<V>,
}

fn classes(list: &[&str]) -> V {
    V::arr(list.iter().map(|c| V::str(*c)).collect())
}

fn end_row(parser: &mut Parser, tags: &Option<V>, auto_tag: Option<bool>) -> R<()> {
    let Some(tags) = tags else { return Ok(()) };
    let df_tag = match parser.gullet.macros.get("\\df@tag") {
        Some(MacroDef::Text(s)) => !s.is_empty(),
        Some(_) => true,
        None => false,
    };
    if df_tag {
        let parsed = parser.subparse(vec![tok("\\df@tag", None)])?;
        tags.push(V::arr(parsed));
        parser.gullet.macros.set_global_undefined("\\df@tag");
    } else {
        let eqnsw =
            matches!(parser.gullet.macros.get("\\@eqnsw"), Some(MacroDef::Text(s)) if s == "1");
        tags.push(V::Bool(auto_tag == Some(true) && eqnsw));
    }
    Ok(())
}

/// `parseArray(parser, opts, scriptLevel)`.
pub fn parse_array(parser: &mut Parser, opts: ArrayOpts, script_level: &str) -> R<V> {
    let end_token = if opts.env_classes.contains(&"bordermatrix") {
        "}"
    } else {
        "\\end"
    };
    parser.gullet.begin_group();
    if !opts.single_row {
        parser
            .gullet
            .macros
            .set("\\cr", MacroDef::Text("\\\\\\relax".to_string()), false);
    }
    parser.gullet.begin_group();

    let mut row = V::arr(Vec::new());
    let body = V::arr(vec![row.clone()]);
    let row_gaps = V::arr(Vec::new());
    let labels = V::arr(Vec::new());
    let hlines_before_row = V::arr(Vec::new());
    let tags = opts.auto_tag.map(|_| V::arr(Vec::new()));
    let auto_tag = opts.auto_tag;
    let begin_row = |parser: &mut Parser| {
        if auto_tag == Some(true) {
            parser
                .gullet
                .macros
                .set("\\@eqnsw", MacroDef::Text("1".to_string()), true);
        }
    };
    begin_row(parser);
    hlines_before_row.push(get_hlines(parser)?);

    loop {
        let cell_body = parser.parse_expression(
            false,
            Some(if opts.single_row { "\\end" } else { "\\\\" }),
            false,
        )?;
        parser.gullet.end_group()?;
        parser.gullet.begin_group();
        let cell = node! {"type" => "ordgroup", "mode" => parser.mode, "semisimple" => true}
            .with("body", V::arr(cell_body));
        row.push(cell.clone());
        let next_tok = parser.fetch()?;
        let next = next_tok.borrow().text.clone();
        if next == "&" {
            if opts.max_num_cols != 0 && row.len() == opts.max_num_cols {
                if opts.env_classes.contains(&"array") {
                    if parser.settings.strict {
                        return perr_at(
                            "Too few columns specified in the {array} column argument.",
                            &next_tok,
                        );
                    }
                } else if opts.max_num_cols == 2 {
                    return perr_at(
                        "The split environment accepts no more than two columns",
                        &next_tok,
                    );
                } else {
                    return perr_at(
                        "The equation environment accepts only one column",
                        &next_tok,
                    );
                }
            }
            parser.consume();
        } else if next == end_token {
            end_row(parser, &tags, auto_tag)?;
            if row.len() == 1
                && cell.get("body").len() == 0
                && (body.len() > 1 || !opts.empty_single_row)
            {
                body.pop();
            }
            labels.push(V::Str(check_cell_for_labels(&cell.get("body").items())?));
            if hlines_before_row.len() < body.len() + 1 {
                hlines_before_row.push(V::arr(Vec::new()));
            }
            break;
        } else if next == "\\\\" {
            parser.consume();
            let size = if parser.gullet.future()?.borrow().text != " " {
                parser.parse_size_group(true)?
            } else {
                None
            };
            row_gaps.push(size.map_or(V::Null, |s| s.get("value")));
            end_row(parser, &tags, auto_tag)?;
            labels.push(V::Str(check_cell_for_labels(&cell.get("body").items())?));
            hlines_before_row.push(get_hlines(parser)?);
            row = V::arr(Vec::new());
            body.push(row.clone());
            begin_row(parser);
        } else {
            return perr_at(
                format!("Expected & or \\\\ or \\cr or {end_token}"),
                &next_tok,
            );
        }
    }
    parser.gullet.end_group()?;
    parser.gullet.end_group()?;

    let res = node! {"type" => "array", "mode" => parser.mode, "scriptLevel" => script_level}
        .with("body", body)
        .with("cols", opts.cols.unwrap_or(V::Undef))
        .with("rowGaps", row_gaps)
        .with("hLinesBeforeRow", hlines_before_row)
        .with("envClasses", classes(&opts.env_classes))
        .with("autoTag", opts.auto_tag.map_or(V::Undef, V::Bool))
        .with("tags", tags.unwrap_or(V::Undef))
        .with("labels", labels)
        .with("leqno", V::Bool(opts.leqno))
        .with("arraystretch", opts.arraystretch.unwrap_or(V::Undef))
        .with("arraycolsep", opts.arraycolsep.unwrap_or(V::Undef));
    Ok(res)
}

/// `dCellStyle(envName)`.
fn d_cell_style(env_name: &str) -> &'static str {
    if env_name.starts_with('d') {
        "display"
    } else {
        "text"
    }
}

fn align_col(align: &str) -> V {
    node! {"type" => "align", "align" => align}
}

fn separator_col(sep: &str) -> V {
    node! {"type" => "separator", "separator" => sep}
}

/// The column spec shared by `{array}` and `{subarray}`: the symbol nodes of the argument.
fn colalign(arg: &V) -> R<Vec<V>> {
    if check_symbol_node(arg) {
        Ok(vec![arg.clone()])
    } else {
        Ok(assert_node_type(arg, "ordgroup")?.get("body").items())
    }
}

pub fn assert_symbol(node: &V) -> R<V> {
    if !check_symbol_node(node) {
        return jserr("Expected node of symbol group type");
    }
    Ok(node.clone())
}

fn array_handler(ctx: &mut EnvCtx, args: &[V], _opt: &[V]) -> R<V> {
    let mut cols = Vec::new();
    for nde in colalign(&args[0])? {
        let ca = assert_symbol(&nde)?.text("text");
        if "lcr".contains(ca.as_str()) {
            cols.push(align_col(&ca));
        } else if ca == "|" || ca == ":" {
            cols.push(separator_col(&ca));
        } else {
            return perr(format!("Unknown column alignment: {ca}"));
        }
    }
    let (arraystretch, arraycolsep) = array_gaps(ctx.parser)?;
    let opts = ArrayOpts {
        max_num_cols: cols.len(),
        cols: Some(V::arr(cols)),
        env_classes: vec!["array"],
        arraystretch: Some(arraystretch),
        arraycolsep: Some(arraycolsep),
        ..ArrayOpts::default()
    };
    parse_array(ctx.parser, opts, d_cell_style(&ctx.env_name))
}

fn matrix_handler(ctx: &mut EnvCtx, _args: &[V], _opt: &[V]) -> R<V> {
    let base = ctx.env_name.replace('*', "");
    let delimiters: Option<(&str, &str)> = match base.as_str() {
        "pmatrix" => Some(("(", ")")),
        "bmatrix" => Some(("[", "]")),
        "Bmatrix" => Some(("\\{", "\\}")),
        "vmatrix" => Some(("|", "|")),
        "Vmatrix" => Some(("\\Vert", "\\Vert")),
        _ => None,
    };
    let mut col_align = "c".to_string();
    if ctx.env_name.ends_with('*') {
        let parser = &mut *ctx.parser;
        parser.consume_spaces()?;
        if parser.fetch_text()? == "[" {
            parser.consume();
            parser.consume_spaces()?;
            let tok = parser.fetch()?;
            col_align = tok.borrow().text.clone();
            if !"lcr".contains(col_align.as_str()) {
                return perr_at("Expected l or c or r", &tok);
            }
            parser.consume();
            parser.consume_spaces()?;
            parser.expect("]", true)?;
        }
    }
    let res = parse_array(ctx.parser, ArrayOpts::default(), "text")?;
    let first_len = res.get("body").at(0).len();
    let cols: Vec<V> = if res.get("body").len() > 0 {
        let col = align_col(&col_align);
        (0..first_len).map(|_| col.clone()).collect()
    } else {
        Vec::new()
    };
    res.set("cols", V::arr(cols));
    let (arraystretch, arraycolsep) = array_gaps(ctx.parser)?;
    res.set("arraystretch", arraystretch);
    // The source tests `arraycolsep === 6 && arraycolsep === "pt"`, which is never true.
    if arraycolsep.truthy() {
        res.set("arraycolsep", arraycolsep);
    }
    Ok(match delimiters {
        Some((left, right)) => leftright(ctx.mode, res, left, right),
        None => res,
    })
}

pub fn leftright(mode: &'static str, body: V, left: &str, right: &str) -> V {
    node! {"type" => "leftright", "mode" => mode, "left" => left, "right" => right}
        .with("body", V::arr(vec![body]))
        .with("rightColor", V::Undef)
}

fn bordermatrix_handler(ctx: &mut EnvCtx, _args: &[V], _opt: &[V]) -> R<V> {
    let opts = ArrayOpts {
        cols: Some(V::arr(Vec::new())),
        env_classes: vec!["bordermatrix"],
        ..ArrayOpts::default()
    };
    let res = parse_array(ctx.parser, opts, "text")?;
    let cols: Vec<V> = if res.get("body").len() > 0 {
        let col = align_col("c");
        (0..res.get("body").at(0).len())
            .map(|_| col.clone())
            .collect()
    } else {
        Vec::new()
    };
    res.set("cols", V::arr(cols));
    res.set("envClasses", V::arr(Vec::new()));
    res.set("arraystretch", V::Num(1.0));
    if ctx.env_name == "matrix" {
        return Ok(res);
    }
    bordermatrix_parse_tree(&res, &ctx.delimiters)
}

fn smallmatrix_handler(ctx: &mut EnvCtx, _args: &[V], _opt: &[V]) -> R<V> {
    let opts = ArrayOpts {
        env_classes: vec!["small"],
        ..ArrayOpts::default()
    };
    parse_array(ctx.parser, opts, "script")
}

fn subarray_handler(ctx: &mut EnvCtx, args: &[V], _opt: &[V]) -> R<V> {
    let mut cols = Vec::new();
    for nde in colalign(&args[0])? {
        let ca = assert_symbol(&nde)?.text("text");
        if "lc".contains(ca.as_str()) {
            cols.push(align_col(&ca));
        } else {
            return perr(format!("Unknown column alignment: {ca}"));
        }
    }
    if cols.len() > 1 {
        return perr("{subarray} can contain only one column");
    }
    let opts = ArrayOpts {
        cols: Some(V::arr(cols)),
        env_classes: vec!["small"],
        ..ArrayOpts::default()
    };
    let res = parse_array(ctx.parser, opts, "script")?;
    if res.get("body").len() > 0 && res.get("body").at(0).len() > 1 {
        return perr("{subarray} can contain only one column");
    }
    Ok(res)
}

fn cases_handler(ctx: &mut EnvCtx, _args: &[V], _opt: &[V]) -> R<V> {
    let opts = ArrayOpts {
        cols: Some(V::arr(Vec::new())),
        env_classes: vec!["cases"],
        ..ArrayOpts::default()
    };
    let res = parse_array(ctx.parser, opts, d_cell_style(&ctx.env_name))?;
    let r = ctx.env_name.contains('r');
    Ok(leftright(
        ctx.mode,
        res,
        if r { "." } else { "\\{" },
        if r { "\\}" } else { "." },
    ))
}

fn aligned_handler(ctx: &mut EnvCtx, args: &[V], _opt: &[V]) -> R<V> {
    if !ctx.env_name.contains("ed") {
        validate_ams_environment_context(ctx)?;
    }
    let is_split = ctx.env_name == "split";
    let cols = V::arr(Vec::new());
    let opts = ArrayOpts {
        cols: Some(cols.clone()),
        empty_single_row: true,
        auto_tag: if is_split {
            None
        } else {
            get_auto_tag(&ctx.env_name)
        },
        env_classes: vec!["abut", "jot"],
        max_num_cols: if is_split { 2 } else { 0 },
        leqno: false,
        ..ArrayOpts::default()
    };
    let res = parse_array(ctx.parser, opts, "display")?;
    let mut num_maths = f64::NAN;
    let mut num_cols = 0usize;
    let is_aligned_at = ctx.env_name.contains("at");
    if args.first().is_some_and(V::truthy) && is_aligned_at {
        let arg_body = args[0].get("body");
        if !arg_body.is_arr() {
            return jserr("Cannot read properties of undefined (reading 'length')");
        }
        let mut arg0 = String::new();
        for item in arg_body.items() {
            arg0.push_str(&assert_node_type(&item, "textord")?.text("text"));
        }
        let n = to_number(&arg0);
        if n.is_nan() {
            return perr("The alignat enviroment requires a numeric first argument.");
        }
        num_maths = n;
        num_cols = (n * 2.0) as usize;
    }
    for row in res.get("body").items() {
        if is_aligned_at {
            let cur_maths = row.len() as f64 / 2.0;
            if num_maths < cur_maths {
                return perr(format!(
                    "Too many math in a row: expected {}, but got {}",
                    crate::web::extract::elements::math::temml::val::num_str(num_maths),
                    crate::web::extract::elements::math::temml::val::num_str(cur_maths)
                ));
            }
        } else if num_cols < row.len() {
            num_cols = row.len();
        }
    }
    for i in 0..num_cols {
        cols.set_at(i, align_col(if i % 2 == 1 { "l" } else { "r" }));
    }
    let env_classes = res.get("envClasses");
    if ctx.env_name == "split" {
    } else if is_aligned_at {
        env_classes.push(V::str("alignat"));
    } else {
        env_classes.set_at(0, V::str("align"));
    }
    Ok(res)
}

fn gathered_handler(ctx: &mut EnvCtx, _args: &[V], _opt: &[V]) -> R<V> {
    if ctx.env_name != "gathered" {
        validate_ams_environment_context(ctx)?;
    }
    let opts = ArrayOpts {
        cols: Some(V::arr(Vec::new())),
        env_classes: vec!["abut", "jot"],
        auto_tag: get_auto_tag(&ctx.env_name),
        empty_single_row: true,
        ..ArrayOpts::default()
    };
    parse_array(ctx.parser, opts, "display")
}

fn equation_handler(ctx: &mut EnvCtx, _args: &[V], _opt: &[V]) -> R<V> {
    validate_ams_environment_context(ctx)?;
    let opts = ArrayOpts {
        auto_tag: get_auto_tag(&ctx.env_name),
        empty_single_row: true,
        single_row: true,
        max_num_cols: 1,
        env_classes: vec!["align"],
        ..ArrayOpts::default()
    };
    parse_array(ctx.parser, opts, "display")
}

fn multline_handler(ctx: &mut EnvCtx, _args: &[V], _opt: &[V]) -> R<V> {
    validate_ams_environment_context(ctx)?;
    let opts = ArrayOpts {
        auto_tag: Some(ctx.env_name == "multline"),
        max_num_cols: 1,
        env_classes: vec!["jot", "multline"],
        ..ArrayOpts::default()
    };
    parse_array(ctx.parser, opts, "display")
}

fn cd_handler(ctx: &mut EnvCtx, _args: &[V], _opt: &[V]) -> R<V> {
    validate_ams_environment_context(ctx)?;
    parse_cd(ctx.parser)
}

pub fn register(r: &mut Registry) {
    let b = Some(array_builder as super::Builder);
    r.define_env(&["array", "darray"], 1, array_handler, b);
    r.define_env(
        &[
            "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "matrix*", "pmatrix*",
            "bmatrix*", "Bmatrix*", "vmatrix*", "Vmatrix*",
        ],
        0,
        matrix_handler,
        b,
    );
    r.define_env(&["bordermatrix"], 0, bordermatrix_handler, b);
    r.define_env(&["smallmatrix"], 0, smallmatrix_handler, b);
    r.define_env(&["subarray"], 1, subarray_handler, b);
    r.define_env(
        &["cases", "dcases", "rcases", "drcases"],
        0,
        cases_handler,
        b,
    );
    r.define_env(
        &["align", "align*", "aligned", "split"],
        0,
        aligned_handler,
        b,
    );
    r.define_env(&["alignat", "alignat*", "alignedat"], 1, aligned_handler, b);
    r.define_env(&["gathered", "gather", "gather*"], 0, gathered_handler, b);
    r.define_env(&["equation", "equation*"], 0, equation_handler, b);
    r.define_env(&["multline", "multline*"], 0, multline_handler, b);
    r.define_env(&["CD"], 0, cd_handler, b);
}
