-- Activation by segment, for the analysis in ../activation-drop.md (issue #3457). Read-only.
-- Same cohorts and activation rule as activation-weekly.sql. Each install lands in one period:
--   A  cohort weeks 2026-08-09 to 2026-09-20, before the drop
--   B  cohort weeks 2026-09-27 to 2026-10-11, the cohorts the issue flagged
--   C  cohort weeks 2026-10-18 to the latest complete week
-- One row per period, segment and value. `machine` rows are installs that no person made: builds
-- without a release version, and the batch of 2026.928.1 test installs first seen on 2026-10-23
-- and 2026-10-24. Every other segment row counts only the remaining installs.
WITH firsts AS (
  SELECT person_id, min(timestamp) AS first_ts,
    argMin(properties.platform, timestamp) AS platform,
    argMin(properties.app_version, timestamp) AS version
  FROM events
  WHERE timestamp >= toDateTime('2026-06-01 00:00:00') AND properties.environment = 'production'
    AND properties.platform IN ('darwin', 'win32', 'linux')
    AND event IN ('app_active_heartbeat','note_opened','note_created','note_updated','journal_opened',
      'journal_updated','search_performed','command_palette_opened','task_created','task_updated',
      'task_completed','canvas_opened','graph_opened','project_opened','inbox_captured',
      'agent_chat_message_sent','setting_changed')
  GROUP BY person_id
),
cohort AS (
  SELECT person_id, first_ts, platform, version,
    multiIf(first_ts < toDateTime('2026-09-27 00:00:00'), 'A',
      first_ts < toDateTime('2026-10-18 00:00:00'), 'B', 'C') AS period,
    NOT match(version, '^\\d{4}\\.\\d+\\.\\d+$')
      OR (version = '2026.928.1' AND toDate(first_ts) IN (toDate('2026-10-23'), toDate('2026-10-24'))) AS machine
  FROM firsts
  WHERE first_ts >= toDateTime('2026-08-09 00:00:00')
    AND toStartOfWeek(first_ts, 0) <= toStartOfWeek(now(), 0) - INTERVAL 2 WEEK
),
week1 AS (
  SELECT e.person_id AS pid,
    countIf(e.event = 'note_updated') AS writes,
    countIf(e.event = 'onboarding_completed') AS onboarded,
    countIf(e.event = 'app_error_seen') AS errors,
    countIf(e.event = 'app_crashed') AS unclean_exits,
    countIf(e.event IN ('import_completed', 'note_imported')) AS imports,
    uniqIf(toDate(e.timestamp), e.event = 'app_started') AS launch_days
  FROM events e INNER JOIN cohort c ON e.person_id = c.person_id
  WHERE e.timestamp >= toDateTime('2026-08-01 00:00:00') AND e.properties.environment = 'production'
    AND e.timestamp < c.first_ts + INTERVAL 7 DAY
  GROUP BY pid
),
installs AS (
  SELECT c.period AS period, c.machine AS machine, w.writes >= 3 AS is_activated, w.writes >= 1 AS is_edited,
    if(c.platform = 'darwin', 'macos', 'windows_linux') AS os_group, c.platform AS platform,
    multiIf(toInt64OrZero(splitByChar('.', c.version)[2]) < 928, 'up_to_2026.919',
      toInt64OrZero(splitByChar('.', c.version)[2]) = 928, '2026.928',
      toInt64OrZero(splitByChar('.', c.version)[2]) IN (1014, 1015), '2026.1014_1015',
      '2026.1024_and_later') AS release_family,
    if(startsWith(coalesce(p.properties.locale, ''), 'en'), 'english', 'other') AS locale,
    w.onboarded > 0 AS onboarded, w.errors > 0 AS had_error, w.unclean_exits > 0 AS had_unclean_exit,
    w.imports > 0 AS imported, w.launch_days >= 2 AS launched_on_2_days
  FROM cohort c
  LEFT JOIN week1 w ON w.pid = c.person_id
  LEFT JOIN persons p ON p.id = c.person_id
)
SELECT period, seg.1 AS segment, seg.2 AS value,
  count() AS n_installs, countIf(is_edited) AS n_edited, countIf(is_activated) AS n_activated
FROM installs
ARRAY JOIN [
  ('machine', toString(machine)),
  ('platform', if(machine, '-', platform)),
  ('release_family', if(machine, '-', release_family)),
  ('os_by_release', if(machine, '-', concat(os_group, ' ', release_family))),
  ('locale', if(machine, '-', locale)),
  ('onboarding_completed', if(machine, '-', toString(onboarded))),
  ('error_in_week_1', if(machine, '-', concat(toString(had_error), ' activated=', toString(is_activated)))),
  ('unclean_exit_in_week_1', if(machine, '-', concat(toString(had_unclean_exit), ' activated=', toString(is_activated)))),
  ('imported', if(machine, '-', toString(imported))),
  ('launched_on_2_days', if(machine, '-', toString(launched_on_2_days)))
] AS seg
WHERE seg.2 != '-'
GROUP BY period, segment, value
ORDER BY segment, value, period
