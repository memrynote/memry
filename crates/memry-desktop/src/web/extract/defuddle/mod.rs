//! The `Defuddle` class of `dist/defuddle.js`, ported across the stages of Step 26 (#3543). The
//! pieces so far: the ones that read the page (`boundary`, `schema_org`) and the option flags the
//! removal steps obey (`settings`).

pub mod boundary;
pub mod schema_org;
pub mod settings;
