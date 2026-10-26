//! `functions/html.js` and `functions/includegraphics.js`.
//!
//! Temml's `trust` option defaults to false, and Defuddle does not set it, so `isTrusted` is
//! false for every `\class`, `\id`, `\style`, `\data` and `\includegraphics`: the handlers
//! always end in a ParseError, whatever they parse first. Only the table entries matter (an
//! argument that fails to parse also errors, and `\newcommand` of these names is refused).

use super::{Ctx, Props, Registry};
use crate::web::extract::elements::math::temml::val::{R, V, perr};

fn untrusted_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    perr(format!("Function \"{}\" is not trusted", ctx.func_name))
}

pub fn register(r: &mut Registry) {
    r.define(
        "html",
        &["\\class", "\\id", "\\style", "\\data"],
        Props {
            num_args: 2,
            arg_types: Some(&["raw", "original"]),
            allowed_in_text: true,
            ..Props::D
        },
        untrusted_handler,
        None,
    );
    r.define(
        "includegraphics",
        &["\\includegraphics"],
        Props {
            num_args: 1,
            num_optional_args: 1,
            arg_types: Some(&["raw", "url"]),
            ..Props::D
        },
        untrusted_handler,
        None,
    );
}
