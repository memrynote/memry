//! `functions/environment.js` (`\begin`, `\end`), `functions/bordermatrix.js` and the `\hline`
//! catcher of `environments/array.js`.

use super::{Ctx, EnvCtx, Props, Registry, assert_node_type, env_data};
use crate::node;
use crate::web::extract::elements::math::temml::val::{R, V, jserr, perr, perr_at};

fn environment_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let name_group = args[0].clone();
    if !name_group.is_type("ordgroup") {
        return perr("Invalid environment name");
    }
    let mut env_name = String::new();
    for item in name_group.get("body").items() {
        env_name.push_str(&assert_node_type(&item, "textord")?.text("text"));
    }

    if ctx.func_name == "\\begin" {
        let Some(env) = env_data(&env_name) else {
            return perr(format!("No such environment: {env_name}"));
        };
        let parser = &mut *ctx.parser;
        let (args, opt_args) =
            parser.parse_arguments(&format!("\\begin{{{env_name}}}"), &env.func)?;
        let mode = parser.mode;
        let result = {
            let mut context = EnvCtx {
                env_name: env_name.clone(),
                mode,
                parser,
                delimiters: V::Undef,
            };
            (env.handler)(&mut context, &args, &opt_args)?
        };
        let parser = &mut *ctx.parser;
        parser.expect("\\end", false)?;
        let end_name_token = parser.fetch()?;
        let Some(end) = parser.parse_function(None, None)? else {
            return jserr("Expected node of type environment, but got null");
        };
        let end = assert_node_type(&end, "environment")?;
        if end.text("name") != env_name {
            return perr_at(
                format!(
                    "Mismatch: \\begin{{{env_name}}} matched by \\end{{{}}}",
                    end.text("name")
                ),
                &end_name_token,
            );
        }
        return Ok(result);
    }

    Ok(
        node! {"type" => "environment", "mode" => ctx.parser.mode, "name" => env_name}
            .with("nameGroup", name_group),
    )
}

fn bordermatrix_handler(ctx: &mut Ctx, _args: &[V], opt: &[V]) -> R<V> {
    let mut delimiters = V::arr(vec![V::str("("), V::str(")")]);
    if ctx.func_name == "\\bordermatrix" && opt[0].truthy() && opt[0].get("body").truthy() {
        let body = opt[0].get("body");
        if body.len() == 1 && body.at(0).is_type("delimiter") {
            delimiters = V::arr(vec![body.at(0).get("left"), body.at(0).get("right")]);
        }
    }
    let parser = &mut *ctx.parser;
    parser.consume_spaces()?;
    parser.consume();
    let env = env_data("bordermatrix").expect("bordermatrix is registered");
    let mode = parser.mode;
    let result = {
        let mut context = EnvCtx {
            env_name: ctx.func_name[1..].to_string(),
            mode,
            parser,
            delimiters,
        };
        (env.handler)(&mut context, &[], &[])?
    };
    ctx.parser.expect("}", true)?;
    Ok(result)
}

fn hline_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    perr(format!(
        "{} valid only within array environment",
        ctx.func_name
    ))
}

pub fn register(r: &mut Registry) {
    r.define(
        "environment",
        &["\\begin", "\\end"],
        Props {
            num_args: 1,
            arg_types: Some(&["text"]),
            ..Props::D
        },
        environment_handler,
        None,
    );
    r.define(
        "bordermatrix",
        &["\\bordermatrix", "\\matrix"],
        Props {
            num_optional_args: 1,
            ..Props::D
        },
        bordermatrix_handler,
        None,
    );
    r.define(
        "text",
        &["\\hline", "\\hdashline"],
        Props {
            allowed_in_text: true,
            allowed_in_math: true,
            ..Props::D
        },
        hline_handler,
        None,
    );
}
