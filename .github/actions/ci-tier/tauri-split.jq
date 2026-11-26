# Splits tauri-builds.jq's matrix for Desktop Tauri CI's three build jobs. A leg without `shard` runs
# in build (debug builds, the unsharded e2e platforms). A sharded platform builds once in e2e_build
# (its `shard: 1` leg without the shard) and runs each `shard` of `shards` in e2e. e2e_any says
# whether e2e_build has a leg: a job with an empty matrix fails. scripts/ci-tier.test.mjs runs it.
{
  build: {include: [.include[] | select(.shard == null)]},
  e2e_build: {include: [.include[] | select(.shard == 1) | del(.shard)]},
  e2e: {include: [.include[] | select(.shard != null)]},
  e2e_any: any(.include[]; .shard != null)
}
