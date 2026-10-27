//! The one-per-launch startup timeline: a port of `apps/desktop/src/main/launch-timeline.ts`.
//! Each phase stamps its offset from process start; the reveal logs them as one block that
//! `scripts/launch-bench.mjs` (`parseLaunchTimeline`) reads, so a slow launch is attributable
//! from one record.

use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Instant;

/// `shownMs` at or above this logs the block at warn, so a pathological launch ships.
pub const SLOW_LAUNCH_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchPhase {
    AppReady,
    WindowCreated,
    VaultOpenStart,
    VaultOpenReady,
    WindowDidFinishLoad,
    WindowReadyToShow,
    WindowShown,
}

impl LaunchPhase {
    const ALL: [Self; 7] = [
        Self::AppReady,
        Self::WindowCreated,
        Self::VaultOpenStart,
        Self::VaultOpenReady,
        Self::WindowDidFinishLoad,
        Self::WindowReadyToShow,
        Self::WindowShown,
    ];

    /// The telemetry dimension and the `main.log` mark name.
    pub fn name(self) -> &'static str {
        match self {
            Self::AppReady => "app_ready",
            Self::WindowCreated => "window_created",
            Self::VaultOpenStart => "vault_open_start",
            Self::VaultOpenReady => "vault_open_ready",
            Self::WindowDidFinishLoad => "window_did_finish_load",
            Self::WindowReadyToShow => "window_ready_to_show",
            Self::WindowShown => "window_shown",
        }
    }

    /// The field of the report block. The numeric ones are allowlisted in `redact`.
    fn field(self) -> &'static str {
        match self {
            Self::AppReady => "appReadyMs",
            Self::WindowCreated => "windowCreatedMs",
            Self::VaultOpenStart => "vaultOpenStartMs",
            Self::VaultOpenReady => "vaultOpenReadyMs",
            Self::WindowDidFinishLoad => "rendererLoadedMs",
            Self::WindowReadyToShow => "readyToShowMs",
            Self::WindowShown => "shownMs",
        }
    }
}

/// The rendered block and whether it should log at warn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub block: String,
    pub slow: bool,
}

struct State {
    marks: Vec<(LaunchPhase, u64)>,
    reported: bool,
}

pub struct LaunchTimeline {
    started: Instant,
    state: Mutex<State>,
}

impl LaunchTimeline {
    pub fn new(started: Instant) -> Self {
        Self {
            started,
            state: Mutex::new(State {
                marks: Vec::new(),
                reported: false,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Stamps `phase` and returns its offset in ms. A phase can repeat (a dock reopen
    /// re-creates the window); the first mark wins and later ones only return the offset.
    pub fn mark(&self, phase: LaunchPhase) -> u64 {
        let elapsed = self.started.elapsed().as_millis() as u64;
        let mut state = self.lock();
        if !state.marks.iter().any(|(seen, _)| *seen == phase) {
            state.marks.push((phase, elapsed));
            tracing::info!(
                scope = "Startup",
                "launch mark {} at {elapsed}ms",
                phase.name()
            );
        }
        elapsed
    }

    /// Seconds since the process started (`process.uptime()`).
    pub fn uptime_seconds(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    /// Every phase stamped so far with its offset, in the order they were reached.
    pub fn marks(&self) -> Vec<(LaunchPhase, u64)> {
        self.lock().marks.clone()
    }

    /// The phase reached last, so a stall can name the startup step it interrupted.
    pub fn latest(&self) -> Option<LaunchPhase> {
        self.lock().marks.last().map(|(phase, _)| *phase)
    }

    /// The block for the first call, `None` after that. `reason` names what revealed the window.
    pub fn render(&self, reason: &str) -> Option<Report> {
        let mut state = self.lock();
        if state.reported {
            return None;
        }
        state.reported = true;
        let at = |phase| {
            state
                .marks
                .iter()
                .find(|(seen, _)| *seen == phase)
                .map(|(_, ms)| *ms)
        };

        let mut block = String::from("launch timeline {\n");
        block.push_str(&format!("  reason: '{}',\n", reason.replace('\'', "\\'")));
        for phase in LaunchPhase::ALL {
            if let Some(ms) = at(phase) {
                block.push_str(&format!("  {}: {ms},\n", phase.field()));
            }
        }
        let fallback = reason == "fallback-timeout";
        // Vault open runs beside renderer load; still running at reveal makes it the suspect.
        let pending =
            at(LaunchPhase::VaultOpenStart).is_some() && at(LaunchPhase::VaultOpenReady).is_none();
        block.push_str(&format!("  fallback: {fallback},\n"));
        block.push_str(&format!("  vaultOpenPending: {pending},\n}}"));
        let slow = fallback || at(LaunchPhase::WindowShown).unwrap_or(0) >= SLOW_LAUNCH_MS;
        Some(Report { block, slow })
    }

    /// Logs the block once.
    pub fn report(&self, reason: &str) {
        let Some(Report { block, slow }) = self.render(reason) else {
            return;
        };
        if slow {
            tracing::warn!(scope = "Startup", "{block}");
        } else {
            tracing::info!(scope = "Startup", "{block}");
        }
    }
}

static GLOBAL: LazyLock<LaunchTimeline> = LazyLock::new(|| LaunchTimeline::new(Instant::now()));

/// The process-wide timeline. Touched first at the start of `run`, so offsets count from launch.
pub fn global() -> &'static LaunchTimeline {
    &GLOBAL
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn timeline_at(ms_ago: u64) -> LaunchTimeline {
        LaunchTimeline::new(Instant::now() - Duration::from_millis(ms_ago))
    }

    #[test]
    fn the_first_mark_of_a_phase_wins() {
        let timeline = timeline_at(100);
        timeline.mark(LaunchPhase::AppReady);
        timeline.mark(LaunchPhase::WindowCreated);
        let first = timeline.mark(LaunchPhase::AppReady);
        assert!(first >= 100);
        let block = timeline.render("ready-to-show").expect("block").block;
        assert_eq!(block.matches("appReadyMs").count(), 1);
        assert_eq!(timeline.latest(), Some(LaunchPhase::WindowCreated));
    }

    /// `TIMELINE_FIELD_PATTERN` and the block scan of `scripts/launch-bench.mjs`.
    fn parse_like_launch_bench(slice: &str) -> Option<Vec<(String, String)>> {
        let field = regex::Regex::new(r"^([A-Za-z][A-Za-z0-9]*): (.+?),?$").expect("pattern");
        let lines: Vec<&str> = slice.lines().collect();
        let start = lines
            .iter()
            .rposition(|line| line.contains("launch timeline {"))?;
        let mut fields = Vec::new();
        for line in &lines[start + 1..] {
            let line = line.trim();
            if line == "}" {
                return Some(fields);
            }
            if let Some(caps) = field.captures(line) {
                fields.push((caps[1].to_owned(), caps[2].to_owned()));
            }
        }
        None
    }

    #[test]
    fn the_block_parses_into_the_seven_phase_fields() {
        let timeline = timeline_at(0);
        for phase in LaunchPhase::ALL {
            timeline.mark(phase);
        }
        let report = timeline.render("ready-to-show").expect("block");
        assert!(!report.slow);
        let fields = parse_like_launch_bench(&format!("12:00 [info] x\n{}\nmore", report.block))
            .expect("parsed");
        let names: Vec<&str> = fields.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            [
                "reason",
                "appReadyMs",
                "windowCreatedMs",
                "vaultOpenStartMs",
                "vaultOpenReadyMs",
                "rendererLoadedMs",
                "readyToShowMs",
                "shownMs",
                "fallback",
                "vaultOpenPending"
            ]
        );
        assert_eq!(fields[0].1, "'ready-to-show'");
        assert_eq!(fields[8].1, "false");
    }

    #[test]
    fn it_reports_once_and_warns_at_five_seconds() {
        let slow = timeline_at(5_000);
        slow.mark(LaunchPhase::WindowShown);
        assert!(slow.render("ready-to-show").expect("block").slow);
        assert!(slow.render("again").is_none());

        let quick = timeline_at(4_000);
        quick.mark(LaunchPhase::WindowShown);
        assert!(!quick.render("ready-to-show").expect("block").slow);

        let fallback = timeline_at(0);
        let report = fallback.render("fallback-timeout").expect("block");
        assert!(report.slow && report.block.contains("fallback: true"));
    }

    #[test]
    fn a_vault_open_still_running_at_reveal_is_named() {
        let timeline = timeline_at(0);
        timeline.mark(LaunchPhase::VaultOpenStart);
        assert!(
            timeline
                .render("ready-to-show")
                .expect("block")
                .block
                .contains("vaultOpenPending: true")
        );
    }
}
