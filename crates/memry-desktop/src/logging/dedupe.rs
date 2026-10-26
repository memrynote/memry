//! Consecutive identical lines collapse into one: a port of the repeat hook of
//! `apps/desktop/src/main/lib/logger.ts`. Each `write` is one whole formatted line.

use std::io::{self, Write};

const TIMESTAMP_LEN: usize = 23;

pub struct Dedupe<W: Write> {
    inner: W,
    /// The line after its timestamp, and what the last repeat looked like.
    run: Option<Run>,
}

struct Run {
    key: String,
    repeats: u64,
    last: String,
}

/// Splits `ts [level] [scope] text` into the timestamp and the rest.
fn split(line: &str) -> Option<(&str, &str)> {
    let ts = line.get(..TIMESTAMP_LEN)?;
    Some((ts, line.get(TIMESTAMP_LEN + 1..)?.trim_end_matches('\n')))
}

/// `[level] [scope] ` of a formatted line.
fn prefix(rest: &str) -> &str {
    let mut end = 0;
    for _ in 0..2 {
        match rest[end..].find("] ") {
            Some(at) => end += at + 2,
            None => return "",
        }
    }
    &rest[..end]
}

impl<W: Write> Dedupe<W> {
    pub fn new(inner: W) -> Self {
        Self { inner, run: None }
    }

    fn close_run(&mut self) -> io::Result<()> {
        let Some(run) = self.run.take() else {
            return Ok(());
        };
        if run.repeats == 0 {
            return Ok(());
        }
        let Some((ts, rest)) = split(&run.last) else {
            return Ok(());
        };
        let line = format!(
            "{ts} {}Previous line repeated {} more times, the last at this time\n",
            prefix(rest),
            run.repeats
        );
        self.inner.write_all(line.as_bytes())
    }
}

impl<W: Write> Write for Dedupe<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let Ok(text) = std::str::from_utf8(buf) else {
            self.close_run()?;
            return self.inner.write(buf);
        };
        let Some((_, rest)) = split(text) else {
            self.close_run()?;
            return self.inner.write(buf);
        };
        if let Some(run) = self.run.as_mut().filter(|run| run.key == rest) {
            run.repeats += 1;
            run.last = text.to_owned();
            return Ok(buf.len());
        }
        self.close_run()?;
        self.run = Some(Run {
            key: rest.to_owned(),
            repeats: 0,
            last: text.to_owned(),
        });
        self.inner.write_all(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl<W: Write> Drop for Dedupe<W> {
    fn drop(&mut self) {
        let _ = self.close_run();
        let _ = self.inner.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(second: u32, level: &str, text: &str) -> String {
        format!("2026-01-02 03:04:{second:02}.000 [{level}] [Sync] {text}\n")
    }

    fn run(lines: &[String]) -> String {
        let mut out = Vec::new();
        {
            let mut dedupe = Dedupe::new(&mut out);
            for line in lines {
                dedupe.write_all(line.as_bytes()).expect("write");
            }
        }
        String::from_utf8(out).expect("utf8")
    }

    #[test]
    fn repeats_collapse_into_one_count_stamped_with_the_last_repeat() {
        let out = run(&[
            line(1, "warn", "a"),
            line(2, "warn", "a"),
            line(3, "warn", "a"),
            line(4, "info", "b"),
        ]);
        assert_eq!(
            out,
            format!(
                "{}{}{}",
                line(1, "warn", "a"),
                "2026-01-02 03:04:03.000 [warn] [Sync] Previous line repeated 2 more times, the last at this time\n",
                line(4, "info", "b")
            )
        );
    }

    #[test]
    fn a_pending_run_is_written_when_logging_stops() {
        let out = run(&[line(1, "info", "a"), line(2, "info", "a")]);
        assert!(out.ends_with(
            "[info] [Sync] Previous line repeated 1 more times, the last at this time\n"
        ));
    }

    #[test]
    fn a_different_level_or_text_is_not_a_repeat() {
        let out = run(&[
            line(1, "info", "a"),
            line(2, "warn", "a"),
            line(3, "warn", "b"),
        ]);
        assert_eq!(out.lines().count(), 3);
        assert!(!out.contains("Previous line"));
    }
}
