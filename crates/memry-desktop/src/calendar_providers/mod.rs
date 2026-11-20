//! Calendar providers on the native app (#3546): the shell side of each provider, which owns the
//! helper processes, HTTP and the keychain while the core owns the calendar model.

pub mod eventkit;
