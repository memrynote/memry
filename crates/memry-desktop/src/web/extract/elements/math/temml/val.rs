//! The dynamic values temml's parse tree is made of. Temml builds its parse nodes as plain JS
//! objects whose fields differ per node type, and its handlers read and mutate them freely, so
//! the port keeps the same shape: a node is a shared, mutable map and `get` of a missing field
//! is `undefined`.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use crate::web::extract::utils::json::number_to_string;

/// A temml error. `parse` is `error instanceof ParseError`; `loc` says whether the message
/// carries a position suffix (only the exact message ` Unmatched delimiter` without one triggers
/// the parser's retry).
#[derive(Debug, Clone)]
pub struct TErr {
    pub message: String,
    pub parse: bool,
    pub loc: bool,
}

pub type R<T> = Result<T, TErr>;

/// `new ParseError(message)`.
pub fn perr<T>(message: impl Into<String>) -> R<T> {
    Err(TErr {
        message: format!(" {}", message.into()),
        parse: true,
        loc: false,
    })
}

/// `new ParseError(message, token)`.
pub fn perr_at<T>(message: impl Into<String>, tok: &Tok) -> R<T> {
    Err(TErr {
        message: format!(" {}", message.into()),
        parse: true,
        loc: tok.borrow().loc.is_some(),
    })
}

/// A JS exception that is not a ParseError (a TypeError from a bad access, `Error`).
pub fn jserr<T>(message: impl Into<String>) -> R<T> {
    Err(TErr {
        message: message.into(),
        parse: false,
        loc: false,
    })
}

/// `SourceLocation`: a range of the lexer's input, in UTF-16 units.
#[derive(Clone)]
pub struct Loc {
    pub lexer: Rc<Vec<u16>>,
    pub start: usize,
    pub end: usize,
}

pub struct Token {
    pub text: String,
    pub loc: Option<Loc>,
    pub noexpand: bool,
    pub treat_as_relax: bool,
}

pub type Tok = Rc<RefCell<Token>>;

pub fn tok(text: impl Into<String>, loc: Option<Loc>) -> Tok {
    Rc::new(RefCell::new(Token {
        text: text.into(),
        loc,
        noexpand: false,
        treat_as_relax: false,
    }))
}

/// `SourceLocation.range(first, second)`.
pub fn loc_range(first: &Tok, second: Option<&Tok>) -> Option<Loc> {
    let Some(second) = second else {
        return first.borrow().loc.clone();
    };
    let (a, b) = (first.borrow(), second.borrow());
    match (&a.loc, &b.loc) {
        (Some(x), Some(y)) if Rc::ptr_eq(&x.lexer, &y.lexer) => Some(Loc {
            lexer: x.lexer.clone(),
            start: x.start,
            end: y.end,
        }),
        _ => None,
    }
}

/// `Token.range(endToken, text)`.
pub fn tok_range(first: &Tok, last: &Tok, text: String) -> Tok {
    let loc = loc_range(first, Some(last));
    tok(text, loc)
}

pub type Obj = Rc<RefCell<BTreeMap<&'static str, V>>>;

#[derive(Clone)]
pub enum V {
    Undef,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Rc<RefCell<Vec<V>>>),
    Obj(Obj),
    Loc(Loc),
    Tok(Tok),
}

impl V {
    pub fn new_obj() -> V {
        V::Obj(Rc::new(RefCell::new(BTreeMap::new())))
    }

    pub fn arr(items: Vec<V>) -> V {
        V::Arr(Rc::new(RefCell::new(items)))
    }

    pub fn str(s: impl Into<String>) -> V {
        V::Str(s.into())
    }

    pub fn is_undef(&self) -> bool {
        matches!(self, V::Undef)
    }

    pub fn is_nullish(&self) -> bool {
        matches!(self, V::Undef | V::Null)
    }

    /// JS truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            V::Undef | V::Null => false,
            V::Bool(b) => *b,
            V::Num(n) => *n != 0.0 && !n.is_nan(),
            V::Str(s) => !s.is_empty(),
            _ => true,
        }
    }

    /// `node[key]`; `undefined` for a missing field or a non-object.
    pub fn get(&self, key: &str) -> V {
        match self {
            V::Obj(o) => o.borrow().get(key).cloned().unwrap_or(V::Undef),
            _ => V::Undef,
        }
    }

    /// `{ ...node, key: value }` for a freshly built node: sets the field and returns it.
    pub fn with(self, key: &'static str, value: V) -> V {
        self.set(key, value);
        self
    }

    pub fn set(&self, key: &'static str, value: V) {
        if let V::Obj(o) = self {
            o.borrow_mut().insert(key, value);
        }
    }

    /// `node.type`, or `""` when there is none.
    pub fn ty(&self) -> String {
        self.get("type").as_string().unwrap_or_default()
    }

    pub fn is_type(&self, ty: &str) -> bool {
        matches!(self.get("type"), V::Str(s) if s == ty)
    }

    pub fn as_string(&self) -> Option<String> {
        match self {
            V::Str(s) => Some(s.clone()),
            _ => None,
        }
    }

    /// `node[key]` as a string; `""` when it is not one.
    pub fn text(&self, key: &str) -> String {
        self.get(key).as_string().unwrap_or_default()
    }

    pub fn as_num(&self) -> Option<f64> {
        match self {
            V::Num(n) => Some(*n),
            _ => None,
        }
    }

    /// The items of an array value (a snapshot).
    pub fn items(&self) -> Vec<V> {
        match self {
            V::Arr(a) => a.borrow().clone(),
            _ => Vec::new(),
        }
    }

    /// `array.push(value)`.
    pub fn push(&self, value: V) {
        if let V::Arr(a) = self {
            a.borrow_mut().push(value);
        }
    }

    /// `array[i]`.
    pub fn at(&self, i: usize) -> V {
        match self {
            V::Arr(a) => a.borrow().get(i).cloned().unwrap_or(V::Undef),
            _ => V::Undef,
        }
    }

    /// `array[i] = value`, growing the array with `undefined` as JS does.
    pub fn set_at(&self, i: usize, value: V) {
        if let V::Arr(a) = self {
            let mut a = a.borrow_mut();
            if a.len() <= i {
                a.resize(i + 1, V::Undef);
            }
            a[i] = value;
        }
    }

    /// `array.shift()`.
    pub fn shift(&self) -> V {
        match self {
            V::Arr(a) if !a.borrow().is_empty() => a.borrow_mut().remove(0),
            _ => V::Undef,
        }
    }

    /// `array.pop()`.
    pub fn pop(&self) -> V {
        match self {
            V::Arr(a) => a.borrow_mut().pop().unwrap_or(V::Undef),
            _ => V::Undef,
        }
    }

    /// `array.includes(string)`.
    pub fn includes(&self, s: &str) -> bool {
        self.items()
            .iter()
            .any(|v| matches!(v, V::Str(x) if x == s))
    }

    pub fn is_arr(&self) -> bool {
        matches!(self, V::Arr(_))
    }

    pub fn len(&self) -> usize {
        match self {
            V::Arr(a) => a.borrow().len(),
            _ => 0,
        }
    }

    pub fn loc(&self) -> Option<Loc> {
        match self.get("loc") {
            V::Loc(l) => Some(l),
            _ => None,
        }
    }
}

impl From<&str> for V {
    fn from(s: &str) -> V {
        V::Str(s.to_string())
    }
}

impl From<String> for V {
    fn from(s: String) -> V {
        V::Str(s)
    }
}

impl From<bool> for V {
    fn from(b: bool) -> V {
        V::Bool(b)
    }
}

impl From<f64> for V {
    fn from(n: f64) -> V {
        V::Num(n)
    }
}

impl From<Option<Loc>> for V {
    fn from(l: Option<Loc>) -> V {
        l.map_or(V::Undef, V::Loc)
    }
}

/// `{ type: ..., mode: ..., ... }`.
#[macro_export]
macro_rules! node {
    ($($k:literal => $v:expr),* $(,)?) => {{
        let n = $crate::web::extract::elements::math::temml::val::V::new_obj();
        $( n.set($k, $crate::web::extract::elements::math::temml::val::V::from($v)); )*
        n
    }};
}

/// `String(number)`.
pub fn num_str(n: f64) -> String {
    number_to_string(n)
}

/// UTF-16 length of a string, as JS `.length`.
pub fn ulen(s: &str) -> usize {
    s.encode_utf16().count()
}
