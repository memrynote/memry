//! The per-element converters of mathml-to-latex (`mi.ts`, `mfrac.ts`, ...) and the iterative
//! driver `convertTreeToLatex`.

use super::tables::TABLES;
use super::thickness::line_thickness;
use super::tree::{MNode, Tree};
use super::xml::OBJECT_PROTOTYPE_NAMES;
use crate::web::extract::utils::js::{is_js_whitespace, trim, utf16_len};

/// What a throwing converter raises; the message is only logged.
pub type ConvertError = String;

/// `normalizeWhiteSpaces`: every run of JS whitespace becomes one space.
pub fn normalize_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for c in s.chars() {
        if is_js_whitespace(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

fn has_ascii_alnum(s: &str) -> bool {
    s.chars().any(|c| c.is_ascii_alphanumeric())
}

/// `HashUTF8ToLtXConverter.convert`.
fn utf8_to_latex(value: &str) -> String {
    if has_ascii_alnum(value) {
        return value.to_string();
    }
    if let Some(accent) = TABLES.vowels_with_accents.get(value) {
        return match TABLES.accent_command.get(&accent.accent) {
            Some(command) if !command.is_empty() => format!("\\{command}{{{}}}", accent.vowel),
            _ => value.to_string(),
        };
    }
    match TABLES.special_font_chars.get(value) {
        Some(font) if !font.letter.is_empty() => {
            format!("\\{}{{{}}}", font.command, font.letter)
        }
        _ => value.to_string(),
    }
}

/// `Character.apply` (symbols) or `Operator.operate` (operators): char table, glyph table,
/// number table, then the UTF-8 conversion. An empty mapped value is a hit.
fn lookup(
    by_char: &std::collections::HashMap<String, String>,
    by_glyph: &std::collections::HashMap<String, String>,
    value: &str,
) -> String {
    by_char
        .get(value)
        .or_else(|| by_glyph.get(value))
        .or_else(|| TABLES.number_by_glyph.get(value))
        .cloned()
        .unwrap_or_else(|| utf8_to_latex(value))
}

fn character(value: &str) -> String {
    lookup(&TABLES.symbols_by_char, &TABLES.symbols_by_glyph, value)
}

fn operator(value: &str) -> String {
    lookup(&TABLES.operators_by_char, &TABLES.operators_by_glyph, value)
}

fn wrap_math_variant(value: &str, variant: Option<&str>) -> String {
    match variant {
        Some("bold") => format!("\\mathbf{{{value}}}"),
        Some("italic") => format!("\\mathit{{{value}}}"),
        Some("bold-italic") => format!("\\mathbf{{\\mathit{{{value}}}}}"),
        Some("double-struck") => format!("\\mathbb{{{value}}}"),
        Some("bold-fraktur") => format!("\\mathbf{{\\mathfrak{{{value}}}}}"),
        Some("script") => format!("\\mathcal{{{value}}}"),
        Some("bold-script") => format!("\\mathbf{{\\mathcal{{{value}}}}}"),
        Some("fraktur") => format!("\\mathfrak{{{value}}}"),
        Some("sans-serif") => format!("\\mathsf{{{value}}}"),
        Some("bold-sans-serif") => format!("\\mathbf{{\\mathsf{{{value}}}}}"),
        Some("sans-serif-italic") => format!("\\mathsf{{\\mathit{{{value}}}}}"),
        Some("sans-serif-bold-italic") => format!("\\mathbf{{\\mathsf{{\\mathit{{{value}}}}}}}"),
        Some("monospace") => format!("\\mathtt{{{value}}}"),
        _ => value.to_string(),
    }
}

/// `MI.convert` on a value and `mathvariant`.
fn mi(value: &str, variant: Option<&str>) -> String {
    let normalized = normalize_ws(value);
    if normalized == " " {
        return character(&normalized);
    }
    let converted = character(trim(&normalized));
    let parsed = utf8_to_latex(&converted);
    if parsed != converted {
        return parsed;
    }
    wrap_math_variant(&converted, variant)
}

fn wrap_parens_if_long(s: &str) -> String {
    if utf16_len(s) <= 1 {
        s.to_string()
    } else {
        format!("\\left({s}\\right)")
    }
}

fn double_bar(glyph: &str) -> bool {
    matches!(glyph, "||" | "\u{2016}" | "\u{2225}")
}

/// `GenericWrapper`: `\left` / `\right` with the delimiter translations.
fn fence_wrap(open: &str, close: &str, content: &str) -> String {
    let translate = |d: &str| -> String {
        match d {
            "{" => "\\{".to_string(),
            "}" => "\\}".to_string(),
            d if double_bar(d) => "\\|".to_string(),
            d => d.to_string(),
        }
    };
    format!(
        "\\left{}{content}\\right{}",
        translate(open),
        translate(close)
    )
}

fn error_children(name: &str, expected: usize, actual: usize, comparison: &str) -> ConvertError {
    format!("{name} tag must have {comparison} {expected} children. It's actually {actual}")
}

pub(super) const DEFAULT_RULE_THICKNESS_PT: f64 = 0.4;
fn text_command(variant: Option<&str>, value: &str) -> String {
    let commands: &[&str] = match variant.filter(|v| !v.is_empty()).unwrap_or("normal") {
        "bold" => &["\\textbf"],
        "italic" => &["\\textit"],
        "bold-italic" => &["\\textit", "\\textbf"],
        "double-struck" => &["\\mathbb"],
        "monospace" => &["\\mathtt"],
        "bold-fraktur" | "fraktur" => &["\\mathfrak"],
        _ => &["\\text"],
    };
    commands
        .iter()
        .enumerate()
        .fold(String::new(), |acc, (i, command)| {
            if i == 0 {
                format!("{command}{{{value}}}")
            } else {
                format!("{command}{{{acc}}}")
            }
        })
}

fn mtext(node: &MNode) -> String {
    struct Run {
        value: String,
        alnum: bool,
    }
    let mut runs: Vec<Run> = Vec::new();
    for c in node.value.chars() {
        let alnum = c.is_ascii_alphanumeric() || c == ' ';
        if alnum && let Some(last) = runs.last_mut().filter(|r| r.alnum) {
            last.value.push(c);
            continue;
        }
        runs.push(Run {
            value: c.to_string(),
            alnum,
        });
    }
    let variant = node.attr("mathvariant");
    runs.iter()
        .map(|run| {
            if run.alnum {
                text_command(variant, &run.value)
            } else {
                mi(&run.value, None)
            }
        })
        .collect()
}

fn joined(node: &MNode, memo: &[Option<String>], sep: &str) -> String {
    node.children
        .iter()
        .map(|c| memo[*c].as_deref().unwrap_or(""))
        .collect::<Vec<_>>()
        .join(sep)
}

fn has_descendant_named(tree: &Tree, children: &[usize], name: &str) -> bool {
    let mut stack: Vec<usize> = children.to_vec();
    while let Some(id) = stack.pop() {
        let n = tree.node(id);
        if n.name == name {
            return true;
        }
        stack.extend(n.children.iter().copied());
    }
    false
}

fn matrix_command(open: &str, close: &str) -> &'static str {
    match (open, close) {
        ("(", ")") => "pmatrix",
        ("[", "]") => "bmatrix",
        ("{", "}") => "Bmatrix",
        ("|", "|") => "vmatrix",
        (o, c) if o == c && double_bar(o) => "Vmatrix",
        (o, c) if o != c => "matrix",
        _ => "bmatrix",
    }
}

fn mfenced(tree: &Tree, node: &MNode, memo: &[Option<String>]) -> String {
    let open = node.attr("open").filter(|v| !v.is_empty()).unwrap_or("");
    let close = node.attr("close").filter(|v| !v.is_empty()).unwrap_or("");
    let latex: Vec<&str> = node
        .children
        .iter()
        .map(|c| memo[*c].as_deref().unwrap_or(""))
        .collect();
    if has_descendant_named(tree, &node.children, "mtable") {
        let command = matrix_command(open, close);
        let body = format!(
            "\\begin{{{command}}}\n{}\n\\end{{{command}}}",
            latex.join("")
        );
        return if command == "matrix" {
            fence_wrap(open, close, &body)
        } else {
            body
        };
    }
    let separators = node.attr("separators");
    let separator_chars: Vec<String> = separators
        .map(|s| s.chars().map(String::from).collect())
        .unwrap_or_default();
    // A missing `separators` attribute defaults to a comma; an empty one to nothing.
    let effective: Vec<String> = if separator_chars.is_empty() {
        vec![if separators.is_none() { "," } else { "" }.to_string()]
    } else {
        separator_chars
    };
    let mut body = String::new();
    for (i, item) in latex.iter().enumerate() {
        body.push_str(item);
        if i != latex.len() - 1 {
            let sep = effective
                .get(i)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| effective.last().expect("non-empty"));
            body.push_str(sep);
        }
    }
    let open = if open.is_empty() { "(" } else { open };
    let close = if close.is_empty() { ")" } else { close };
    fence_wrap(open, close, &body)
}

fn scripts_base(tree: &Tree, base: usize, memo: &[Option<String>]) -> String {
    let s = memo[base].as_deref().unwrap_or("");
    if tree.node(base).children.len() <= 1 {
        s.to_string()
    } else {
        wrap_parens_if_long(s)
    }
}

fn mmultiscripts(
    tree: &Tree,
    node: &MNode,
    memo: &[Option<String>],
) -> Result<String, ConvertError> {
    if node.children.is_empty() {
        return Err(error_children(&node.name, 1, 0, "at least"));
    }
    let latex = |id: usize| memo[id].as_deref().unwrap_or("");
    let base = {
        let l = latex(node.children[0]);
        if l.is_empty() {
            "{}".to_string()
        } else if utf16_len(l) == 1 {
            l.to_string()
        } else {
            format!("{{{l}}}")
        }
    };
    let scripts = &node.children[1..];
    let marker = scripts
        .iter()
        .position(|c| tree.node(*c).name == "mprescripts");
    let post = marker.map_or(scripts, |m| &scripts[..m]);
    let pre = marker.map_or(&scripts[0..0], |m| &scripts[m + 1..]);
    let script = |id: Option<&usize>| -> String {
        match id {
            Some(&id) if tree.node(id).name != "none" => latex(id).to_string(),
            _ => String::new(),
        }
    };
    let pairs = |elements: &[usize], is_pre: bool| -> String {
        let mut out = String::new();
        let mut attaches = !is_pre;
        for pair in elements.chunks(2) {
            let sub = script(pair.first());
            let sup = script(pair.get(1));
            let mut scripts = String::new();
            if !sub.is_empty() {
                scripts.push_str(&format!("_{{{sub}}}"));
            }
            if !sup.is_empty() {
                scripts.push_str(&format!("^{{{sup}}}"));
            }
            if scripts.is_empty() {
                continue;
            }
            out.push_str(if attaches { "" } else { "{}" });
            out.push_str(&scripts);
            attaches = false;
        }
        out
    };
    Ok(format!("{}{base}{}", pairs(pre, true), pairs(post, false)))
}

fn equation_alignment_matches(tree: &Tree, table: &MNode) -> bool {
    let rows: Vec<&MNode> = table
        .children
        .iter()
        .map(|c| tree.node(*c))
        .filter(|n| n.name == "mtr")
        .collect();
    let cells = rows.iter().flat_map(|row| {
        row.children
            .iter()
            .map(|c| tree.node(*c))
            .filter(|n| n.name == "mtd")
    });
    let mut tokens: Vec<&str> = Vec::new();
    for element in std::iter::once(table)
        .chain(rows.iter().copied())
        .chain(cells)
    {
        if let Some(value) = element.attr("columnalign").filter(|v| !v.is_empty()) {
            tokens.extend(trim(value).split(is_js_whitespace));
        }
    }
    tokens.contains(&"right") && tokens.contains(&"left")
}

fn menclose(node: &MNode, content: &str) -> String {
    let notation = node
        .attr("notation")
        .filter(|v| !v.is_empty())
        .unwrap_or("longdiv");
    match notation {
        "actuarial" => format!("\\overline{{\\left.{content}\\right|}}"),
        "radical" => format!("\\sqrt{{{content}}}"),
        "box" | "roundedbox" | "circle" => format!("\\boxed{{{content}}}"),
        "left" => format!("\\left|{content}"),
        "right" => format!("{content}\\right|"),
        "top" => format!("\\overline{{{content}}}"),
        "bottom" => format!("\\underline{{{content}}}"),
        "updiagonalstrike" => format!("\\cancel{{{content}}}"),
        "downdiagonalstrike" => format!("\\bcancel{{{content}}}"),
        "updiagonalarrow" => format!("\\cancelto{{}}{{{content}}}"),
        "verticalstrike" | "horizontalstrike" => format!("\\hcancel{{{content}}}"),
        "madruwb" => format!("\\underline{{{content}\\right|}}"),
        "phasorangle" => format!("{{\\angle \\underline{{{content}}}}}"),
        _ => format!("\\overline{{\\left.\\right){content}}}"),
    }
}

fn convert_node(tree: &Tree, id: usize, memo: &[Option<String>]) -> Result<String, ConvertError> {
    let node = tree.node(id);
    if OBJECT_PROTOTYPE_NAMES.contains(&node.name.as_str()) {
        return Err(format!("{} is not a constructor", node.name));
    }
    let child = |i: usize| memo[node.children[i]].as_deref().unwrap_or("");
    let count = node.children.len();
    let exactly = |n: usize| -> Result<(), ConvertError> {
        if count == n {
            Ok(())
        } else {
            Err(error_children(&node.name, n, count, "exactly"))
        }
    };
    Ok(match node.name.as_str() {
        "math" => normalize_ws(&joined(node, memo, " ")),
        "mi" => mi(
            &node.value,
            node.attr("mathvariant").filter(|v| !v.is_empty()),
        ),
        "mo" => operator(trim(&normalize_ws(&node.value))),
        "mn" => {
            let normalized = trim(&normalize_ws(&node.value)).to_string();
            match TABLES.number_by_glyph.get(&normalized) {
                Some(v) if !v.is_empty() => v.clone(),
                _ => normalized,
            }
        }
        "msqrt" => format!("\\sqrt{{{}}}", joined(node, memo, " ")),
        "mfenced" => mfenced(tree, node, memo),
        "mfrac" => {
            exactly(2)?;
            let (num, den) = (child(0), child(1));
            if node.flag("bevelled") {
                return Ok(format!(
                    "{}/{}",
                    wrap_parens_if_long(num),
                    wrap_parens_if_long(den)
                ));
            }
            match line_thickness(node.attr("linethickness")) {
                Some(t) => format!("\\genfrac{{}}{{}}{{{t}}}{{}}{{{num}}}{{{den}}}"),
                None => format!("\\frac{{{num}}}{{{den}}}"),
            }
        }
        "mroot" => {
            exactly(2)?;
            format!("\\sqrt[{}]{{{}}}", child(1), child(0))
        }
        "maction" => {
            let toggle = node
                .attr("actiontype")
                .is_none_or(|a| a == "toggle" || a.is_empty());
            if toggle {
                joined(node, memo, " \\Longrightarrow ")
            } else {
                node.children
                    .first()
                    .and_then(|c| memo[*c].as_deref())
                    .unwrap_or("")
                    .to_string()
            }
        }
        "menclose" => menclose(node, &joined(node, memo, " ")),
        "merror" => format!("\\color{{red}}{{{}}}", joined(node, memo, " ")),
        "mphantom" | "void" => String::new(),
        "msup" => {
            exactly(2)?;
            format!(
                "{}^{{{}}}",
                scripts_base(tree, node.children[0], memo),
                child(1)
            )
        }
        "msub" => {
            exactly(2)?;
            format!(
                "{}_{{{}}}",
                scripts_base(tree, node.children[0], memo),
                child(1)
            )
        }
        "msubsup" => {
            exactly(3)?;
            format!(
                "{}_{{{}}}^{{{}}}",
                scripts_base(tree, node.children[0], memo),
                child(1),
                child(2)
            )
        }
        "mmultiscripts" => mmultiscripts(tree, node, memo)?,
        "mtext" => mtext(node),
        "munderover" => {
            exactly(3)?;
            format!("{}_{{{}}}^{{{}}}", child(0), child(1), child(2))
        }
        "mtable" => {
            let content = joined(node, memo, " \\\\\n");
            let wrap = |env: &str| format!("\\begin{{{env}}}{content}\\end{{{env}}}");
            if node.flag("innerTable") {
                wrap("matrix")
            } else if node.flag("bareTable") {
                wrap(if equation_alignment_matches(tree, node) {
                    "aligned"
                } else {
                    "matrix"
                })
            } else {
                content
            }
        }
        "mtr" => {
            let row = joined(node, memo, " & ");
            if node.flag("bareRow") {
                format!("\\begin{{matrix}}{row}\\end{{matrix}}")
            } else {
                row
            }
        }
        "mover" | "munder" => {
            exactly(2)?;
            let (content, accent) = (child(0), child(1));
            let command = if node.name.contains("under") {
                "\\underset"
            } else {
                "\\overset"
            };
            if matches!(accent, "\\hat" | "\\bar" | "\\underbrace" | "\\overbrace") {
                format!("{accent}{{{content}}}")
            } else {
                format!("{command}{{{accent}}}{{{content}}}")
            }
        }
        "mrow" => {
            if tree.is_linear_system(id) {
                let table = tree.node(node.children[1]);
                let content = joined(table, memo, " \\\\ ");
                format!("\\begin{{cases}} {content} \\end{{cases}}")
            } else {
                joined(node, memo, " ")
            }
        }
        "mspace" => {
            if node.attr("linebreak") == Some("newline") {
                " \\\\ ".to_string()
            } else {
                " ".to_string()
            }
        }
        _ => joined(node, memo, " "),
    })
}

/// `convertTreeToLatex(root)`: normalizes, then converts every node after its children.
pub fn convert_tree(tree: &mut Tree, root: usize) -> Result<String, ConvertError> {
    tree.normalize(root);
    let mut order = Vec::new();
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        order.push(id);
        stack.extend(tree.node(id).children.iter().copied());
    }
    let mut memo: Vec<Option<String>> = vec![None; tree.nodes.len()];
    // `order` lists parents before children; reversed, every child precedes its parent.
    for &id in order.iter().rev() {
        let latex = convert_node(tree, id, &memo)?;
        memo[id] = Some(latex);
    }
    Ok(memo[root].take().unwrap_or_default())
}
