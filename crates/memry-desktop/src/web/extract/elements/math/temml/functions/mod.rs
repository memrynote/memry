//! The function table (`defineFunction`) and the group builders registered with it.
//!
//! Each family module registers its functions and the builder of its parse-node type, as the
//! matching `functions/*.js` file of temml does.

use std::collections::HashMap;
use std::sync::LazyLock;

use super::parser::Parser;
use super::style::Style;
use super::tree::Tree;
use super::val::{R, Tok, V};

mod accent;
mod arrow;
mod cancelto;
mod color;
mod def;
mod delimiter;
mod misc;
mod spacing;
mod symbols;
mod supsub;
mod text_font;

pub use accent::unicode_accent;

/// What a handler is called with: `context` of `defineFunction`.
pub struct Ctx<'a> {
    pub func_name: String,
    pub parser: &'a mut Parser,
    pub token: Option<Tok>,
    pub break_on_token_text: Option<String>,
}

pub type Handler = for<'a> fn(&mut Ctx<'a>, &[V], &[V]) -> R<V>;
pub type Builder = fn(&V, &Style) -> R<Tree>;

pub struct FuncData {
    pub ty: &'static str,
    pub num_args: usize,
    pub arg_types: Option<&'static [&'static str]>,
    pub allowed_in_argument: bool,
    pub allowed_in_text: bool,
    pub allowed_in_math: bool,
    pub num_optional_args: usize,
    pub infix: bool,
    pub primitive: bool,
    pub handler: Handler,
}

/// `props` of `defineFunction`.
#[derive(Clone, Copy)]
pub struct Props {
    pub num_args: usize,
    pub arg_types: Option<&'static [&'static str]>,
    pub allowed_in_argument: bool,
    pub allowed_in_text: bool,
    pub allowed_in_math: bool,
    pub num_optional_args: usize,
    pub infix: bool,
    pub primitive: bool,
}

impl Props {
    pub const D: Props = Props {
        num_args: 0,
        arg_types: None,
        allowed_in_argument: false,
        allowed_in_text: false,
        allowed_in_math: true,
        num_optional_args: 0,
        infix: false,
        primitive: false,
    };
}

#[derive(Default)]
pub struct Registry {
    funcs: HashMap<&'static str, FuncData>,
    builders: HashMap<&'static str, Builder>,
}

impl Registry {
    /// `defineFunction({ type, names, props, handler, mathmlBuilder })`.
    pub fn define(
        &mut self,
        ty: &'static str,
        names: &[&'static str],
        props: Props,
        handler: Handler,
        builder: Option<Builder>,
    ) {
        for name in names {
            self.funcs.insert(
                name,
                FuncData {
                    ty,
                    num_args: props.num_args,
                    arg_types: props.arg_types,
                    allowed_in_argument: props.allowed_in_argument,
                    allowed_in_text: props.allowed_in_text,
                    allowed_in_math: props.allowed_in_math,
                    num_optional_args: props.num_optional_args,
                    infix: props.infix,
                    primitive: props.primitive,
                    handler,
                },
            );
        }
        if let Some(b) = builder {
            self.builders.insert(ty, b);
        }
    }

    /// `defineFunctionBuilders({ type, mathmlBuilder })`.
    pub fn builder(&mut self, ty: &'static str, builder: Builder) {
        self.builders.insert(ty, builder);
    }
}

static REGISTRY: LazyLock<Registry> = LazyLock::new(|| {
    let mut r = Registry::default();
    accent::register(&mut r);
    arrow::register(&mut r);
    cancelto::register(&mut r);
    color::register(&mut r);
    def::register(&mut r);
    delimiter::register(&mut r);
    misc::register(&mut r);
    spacing::register(&mut r);
    symbols::register(&mut r);
    supsub::register(&mut r);
    text_font::register(&mut r);
    r
});

pub fn get(name: &str) -> Option<&'static FuncData> {
    REGISTRY.funcs.get(name)
}

pub fn builder(ty: &str) -> Option<Builder> {
    REGISTRY.builders.get(ty).copied()
}

/// `isDelimiter(str)` of `functions/delimiter.js`.
pub fn is_delimiter(text: &str) -> bool {
    delimiter::is_delimiter(text)
}

/// `normalizeArgument(arg)`.
pub fn normalize_argument(arg: &V) -> V {
    if arg.is_type("ordgroup") && arg.get("body").len() == 1 {
        arg.get("body").items()[0].clone()
    } else {
        arg.clone()
    }
}

/// `ordargument(arg)`.
pub fn ordargument(arg: &V) -> V {
    if arg.is_type("ordgroup") {
        arg.get("body")
    } else {
        V::arr(vec![arg.clone()])
    }
}

/// `assertNodeType(node, type)`.
pub fn assert_node_type(node: &V, ty: &str) -> R<V> {
    if !node.is_type(ty) {
        return super::val::jserr(format!("Expected node of type {ty}"));
    }
    Ok(node.clone())
}

/// `isCharacterBox(group)`.
pub fn is_character_box(group: &V) -> bool {
    let base = get_base_elem(group);
    base.is_type("mathord") || base.is_type("textord") || base.is_type("atom")
}

fn get_base_elem(group: &V) -> V {
    match group.ty().as_str() {
        "ordgroup" | "color" => {
            let body = group.get("body");
            if body.len() == 1 {
                get_base_elem(&body.items()[0])
            } else {
                group.clone()
            }
        }
        "font" => get_base_elem(&group.get("body")),
        _ => group.clone(),
    }
}
