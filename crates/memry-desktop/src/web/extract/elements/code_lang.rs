//! The language tables and `getCodeLanguage` of `dist/elements/code.js`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::elements::rule::attr;
use crate::web::extract::utils::js::{WS, to_lower};

/// `CODE_LANGUAGES`.
const CODE_LANGUAGES: &[&str] = &[
    "abap",
    "actionscript",
    "ada",
    "adoc",
    "agda",
    "antlr4",
    "applescript",
    "arduino",
    "armasm",
    "asciidoc",
    "aspnet",
    "atom",
    "bash",
    "batch",
    "c",
    "clojure",
    "cmake",
    "cobol",
    "coffeescript",
    "cpp",
    "c++",
    "crystal",
    "csharp",
    "cs",
    "dart",
    "django",
    "dockerfile",
    "dotnet",
    "elixir",
    "elm",
    "erlang",
    "fortran",
    "fsharp",
    "gdscript",
    "gitignore",
    "glsl",
    "golang",
    "gradle",
    "graphql",
    "groovy",
    "haskell",
    "hs",
    "haxe",
    "hlsl",
    "html",
    "idris",
    "java",
    "javascript",
    "js",
    "jsx",
    "jsdoc",
    "json",
    "jsonp",
    "julia",
    "kotlin",
    "latex",
    "lean",
    "lean4",
    "lisp",
    "elisp",
    "livescript",
    "lua",
    "makefile",
    "markdown",
    "md",
    "markup",
    "masm",
    "mathml",
    "matlab",
    "mongodb",
    "mysql",
    "nasm",
    "nginx",
    "nim",
    "nix",
    "objc",
    "ocaml",
    "pascal",
    "perl",
    "php",
    "postgresql",
    "powershell",
    "prolog",
    "puppet",
    "python",
    "regex",
    "rss",
    "ruby",
    "rb",
    "rust",
    "scala",
    "scheme",
    "shell",
    "sh",
    "solidity",
    "sparql",
    "sql",
    "ssml",
    "svg",
    "swift",
    "tcl",
    "terraform",
    "tex",
    "toml",
    "typescript",
    "ts",
    "tsx",
    "unrealscript",
    "verilog",
    "vhdl",
    "webassembly",
    "wasm",
    "xml",
    "yaml",
    "yml",
    "zig",
];

pub fn is_language(name: &str) -> bool {
    CODE_LANGUAGES.contains(&name)
}

/// `HIGHLIGHTER_PATTERNS`, in order. `\w` is ASCII; the last pattern carries the `i` flag.
static HIGHLIGHTER_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let patterns = [
        r"^language-(\w+)$".to_string(),
        r"^lang-(\w+)$".to_string(),
        r"^(\w+)-code$".to_string(),
        r"^code-(\w+)$".to_string(),
        r"^syntax-(\w+)$".to_string(),
        r"^code-snippet__(\w+)$".to_string(),
        r"^highlight-(\w+)$".to_string(),
        r"^(\w+)-snippet$".to_string(),
        format!(r"(?:^|{WS})(?i-u:(?:language|lang|brush|syntax))-(\w+)(?:{WS}|$)"),
    ];
    patterns
        .iter()
        .map(|p| Regex::new(&p.replace(r"\w", "[A-Za-z0-9_]")).expect("static pattern"))
        .collect()
});

/// `getCodeLanguage(element)`: `data-lang`, then the class names, `''` when none is a language.
pub fn get_code_language(doc: &Document, element: NodeId) -> String {
    for name in ["data-lang", "data-language", "language"] {
        if let Some(value) = attr(doc, element, name).filter(|v| !v.is_empty()) {
            return to_lower(&value);
        }
    }
    let class_names = doc.class_list(element);
    if doc.class_list_contains(element, "syntaxhighlighter")
        && let Some(class) = class_names
            .iter()
            .find(|c| !["syntaxhighlighter", "nogutter"].contains(&c.as_str()))
        && is_language(&to_lower(class))
    {
        return to_lower(class);
    }
    for class in &class_names {
        let lower = to_lower(class);
        for pattern in HIGHLIGHTER_PATTERNS.iter() {
            if let Some(caps) = pattern.captures(&lower) {
                let name = to_lower(&caps[1]);
                if !name.is_empty() && is_language(&name) {
                    return name;
                }
            }
        }
    }
    for class in &class_names {
        let lower = to_lower(class);
        if is_language(&lower) {
            return lower;
        }
    }
    String::new()
}
