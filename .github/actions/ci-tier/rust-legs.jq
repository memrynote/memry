# Rust CI's OS matrix, from the plan job's tier outputs ($full, $macos, $intel, and $win and $mac,
# the rust_windows and rust_macos legs). scripts/ci-tier.test.mjs runs it for each event.
#
# Fast tier: Linux, plus Windows x64 and Apple Silicon when the diff can break them (`checks` adds
# that OS's checks job, `tests` its whole leg); the rest of Windows runs in the merge queue, where a
# Windows-only failure ejects the PR. Full adds Windows x64 and ARM, plus Apple Silicon unless the
# run is a merge-queue run (macos=false) and Intel only where intel is true (main, dispatch).
#
# Linux and Windows legs split in three jobs: `checks` (fmt, clippy, doctests, the live OS seams, the
# release test) and the nextest suite in two hash partitions. The suite alone ran 7 minutes of
# CPU-bound tests after a 2-minute build in one job. A whole macOS leg stays one `all` job: that pool
# is the scarcest, and three jobs would hold three of its runners.
def leg($os): if ($os | startswith("macos")) then {os: $os, part: "all"}
  else ({os: $os, part: "checks"}, {os: $os, part: "tests", partition: "1/2"}, {os: $os, part: "tests", partition: "2/2"}) end;
if $full == "true" then
  [(["ubuntu-22.04"]
    + (if $macos == "true" then ["macos-15"] else [] end)
    + (if $intel == "true" then ["macos-15-intel"] else [] end)
    + ["windows-2022", "windows-11-arm"])[] | leg(.)]
else
  [leg("ubuntu-22.04")]
  + (if $win == "checks" then [{os: "windows-2022", part: "checks"}] elif $win == "tests" then [leg("windows-2022")] else [] end)
  + (if $mac == "checks" then [{os: "macos-15", part: "checks"}] elif $mac == "tests" then [leg("macos-15")] else [] end)
end
