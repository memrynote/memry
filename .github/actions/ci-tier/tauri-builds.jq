# Desktop Tauri CI's build matrix, from the plan job's tier outputs ($full, $macos, $intel, $queue,
# $post_merge, and $win and $mac, the tauri_windows and tauri_macos legs). scripts/ci-tier.test.mjs
# runs it for each event. Post-merge (the scheduled run of feat/tauri-v2) keeps only the legs the merge
# queue skips: macos-arm64 and the windows-arm64 e2e specs. `covered` (a push the queue passed, or a
# SHA a scheduled run already finished) builds nothing.
#
# Fast tier: linux-x64, plus windows-x64 and macos-arm64 when the diff can break them (`checks` adds
# that platform's debug build and launch smoke, `tests` its e2e specs too). Full: every platform,
# minus Apple Silicon in the merge queue (macos=false) and minus Intel unless intel is true (main,
# dispatch). macos-x64 has no e2e leg: nothing downloads it. The merge queue also skips the
# windows-arm64 e2e leg: at ~29 min it held every queue group ~10 min past the next job, mostly in
# pnpm disk I/O on the runner's one drive. It still runs on the push after the merge and under
# `full-ci`. linux-x64 (the fast tier's longest job) and windows-x64 (the queue's) run their e2e
# specs in two legs (`shard` 1 and 2). Each leg builds its own app: a warm build is 3-4 min, and a
# specs job that downloaded it would wait on `needs: build`, the whole matrix.
[
  {platform: "macos-arm64", os: "macos-15", triple: "aarch64-apple-darwin", on: ($macos == "true"), pr: $mac},
  {platform: "macos-x64", os: "macos-15-intel", triple: "x86_64-apple-darwin", on: ($intel == "true"), pr: "none"},
  {platform: "windows-x64", os: "windows-2022", triple: "x86_64-pc-windows-msvc", on: true, pr: $win},
  {platform: "windows-arm64", os: "windows-11-arm", triple: "aarch64-pc-windows-msvc", on: true, pr: "none"},
  {platform: "linux-x64", os: "ubuntu-22.04", triple: "x86_64-unknown-linux-gnu", on: true, pr: "tests"},
  {platform: "linux-arm64", os: "ubuntu-22.04-arm", triple: "aarch64-unknown-linux-gnu", on: true, pr: "none"}
]
| map(select(.on and ($full == "true" or .pr != "none")) | del(.on))
| {include: [.[] | . as $p | ("debug", "e2e") as $variant
    | select($full == "true" or $p.pr == "tests" or $variant == "debug")
    | select($p.platform != "macos-x64" or $variant != "e2e")
    | select($queue != "true" or $p.platform != "windows-arm64" or $variant != "e2e")
    | select($post_merge != "covered")
    | select($post_merge != "true" or $p.platform == "macos-arm64" or ($p.platform == "windows-arm64" and $variant == "e2e"))
    | $p + {variant: $variant} | del(.pr)
    | if .variant == "e2e" and (.platform == "linux-x64" or .platform == "windows-x64") then (. + {shard: 1}), (. + {shard: 2}) else . end]}
