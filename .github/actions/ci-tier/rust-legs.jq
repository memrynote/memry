# Rust CI's OS matrix, from the plan job's tier outputs ($full, $macos, $intel, $post_merge, and $win
# and $mac, the rust_windows and rust_macos legs), $event, the run's event name, and the optional
# --arg base, the pull request's base branch.
# scripts/ci-tier.test.mjs runs it for each event. The optional --arg warm (the daily cache-warm run)
# adds the cache-saving `seams` leg of each OS the merge queue runs, and the Linux `budget` leg.
#
# Post-merge (the scheduled run of feat/tauri-v2): the legs the merge queue skips. Apple Silicon, every
# windows-11-arm leg and the Linux `perf` leg (the release perf budgets). `covered` (a push the queue
# passed, or a SHA a scheduled run already finished): none.
#
# Fast tier: Linux, plus Windows x64 and Apple Silicon when the diff can break them (`checks` adds
# that OS's lint and seams, `tests` its whole leg); the rest of Windows x64 runs in the merge
# queue, where a Windows-only failure ejects the PR. Full adds Windows x64, plus Apple Silicon unless
# the run is a merge-queue run (macos=false) and Intel only where intel is true (main, dispatch).
# windows-11-arm and `perf` run on every full tier but the merge queue's: a windows-11-arm leg builds
# cold for about 70 minutes, the longest job of a queue round. A PR reaches the full tier only into
# main (no schedule covers main), with `full-ci`, or with an unreadable file list, and keeps them.
#
# Linux and Windows legs split in jobs that run in parallel: `lint` (fmt, clippy, doctests, the
# iOS feature check, line ceilings), `seams` (the live OS seams, the read pool release test, the sync
# harness, the agent MCP client, memry-ml, the worker and memry-cli) and the nextest suite in six
# partitions. `checks` was lint and seams in one job, 59 to 62 minutes cold. Linux adds `budget`,
# the calendar range budget's release build and run: inside `seams` it took 18 to 22 of the leg's 32
# to 48 minutes and set the length of every Rust CI run after #5904 (runs 46058633973, 46066546747,
# 46070972308). The Apple Silicon leg of a PR into any base but main splits the same way, with the
# suite in four partitions: as one `all` job it took about 100 minutes (run 45986308547: clippy 17,
# the suite 57, the seams 20), and every round let other PRs land first. Four, because the suite runs 31 minutes on one runner, so a
# partition runs about 8, and the macOS pool ran up to 20 jobs with no queue wait over a minute (27
# Nov, 02:14 to 13:40 UTC). Every other macOS leg (main, pushes, the schedule, Intel) stays one
# `all` job.
# rust-ci.yml's plan job moves the partitions (the legs with a `partition`) to the test-partitions
# job, which runs them from the nextest archive that test-archive builds once per OS.
#
# Each leg carries the step groups it runs, which rust-ci.yml's steps test (`matrix.lint`, `matrix.seams`,
# `matrix.tests`, `matrix.perf`, `matrix.models`): a macOS `all` leg runs lint, seams and tests, a macOS
# `checks` leg lint and seams.
#
# The ML model steps (golden vectors, real embeds, the release smoke) run on the full tier only, in
# the one job per OS marked `models: true` (the `seams` job). windows-11-arm runs them in a job of its
# own, part `models`: they took 16 of the 41-43 minutes of its old checks job (#3517).
def lint($os): {os: $os, part: "lint", lint: true};
def seams($os): {os: $os, part: "seams", seams: true};
def budget($os): if $os == "ubuntu-22.04" then {os: $os, part: "budget", budget: true} else empty end;
def split_mac: $event == "pull_request" and (($ARGS.named.base // "") | . != "" and . != "main");
def partitions($os; $n): range(1; $n + 1) | {os: $os, part: "tests", partition: "\(.)/\($n)", tests: true};
def leg($os): if $os == "macos-15" and split_mac then (lint($os), seams($os), partitions($os; 4))
  elif ($os | startswith("macos")) then {os: $os, part: "all", lint: true, seams: true, tests: true}
  else (lint($os), seams($os), budget($os), partitions($os; 6)) end;
def full_leg($os): if $os == "windows-11-arm" then (leg($os), {os: $os, part: "models", models: true})
  else leg($os) | if .part == "seams" or .part == "all" then . + {models: true} else . end end;
def perf_leg: {os: "ubuntu-22.04", part: "perf", perf: true};
def off_queue: $event != "merge_group";
def warm_legs: [(["ubuntu-22.04", "windows-2022"])[] | full_leg(.)] | map(select(.part == "seams" or .part == "budget"));
(if $post_merge == "covered" then
  []
elif $post_merge == "true" then
  [((if $macos == "true" then ["macos-15"] else [] end) + ["windows-11-arm"])[] | full_leg(.)] + [perf_leg]
elif $full == "true" then
  [(["ubuntu-22.04"]
    + (if $macos == "true" then ["macos-15"] else [] end)
    + (if $intel == "true" then ["macos-15-intel"] else [] end)
    + ["windows-2022"]
    + (if off_queue then ["windows-11-arm"] else [] end))[] | full_leg(.)]
  + (if off_queue then [perf_leg] else [] end)
else
  [leg("ubuntu-22.04")]
  + (if $win == "checks" then [lint("windows-2022"), seams("windows-2022")] elif $win == "tests" then [leg("windows-2022")] else [] end)
  + (if $mac == "checks" then [{os: "macos-15", part: "checks", lint: true, seams: true}] elif $mac == "tests" then [leg("macos-15")] else [] end)
end
) + (if ($ARGS.named.warm // "false") == "true" then warm_legs else [] end)
