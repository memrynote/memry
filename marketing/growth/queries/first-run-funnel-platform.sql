-- Growth · İlk çalıştırma hunisi (platform)
-- Each new desktop install, by the week of its first app_started, through three steps:
--   started    first app_started of the install
--   engaged    first engaged event (action 369611) within 7 days of that start
--   edited     at least 1 note_updated within 7 days of the first engaged event
--   activated  at least 3 note_updated within 7 days of the first engaged event
-- Platform and version come from the first app_started. Builds without a release version
-- (unpackaged dev and test runs) are left out. A cohort shows once all its members had 21 days.
WITH starts AS (
  SELECT person_id, min(timestamp) AS start_ts,
    argMin(properties.platform, timestamp) AS platform,
    argMin(properties.app_version, timestamp) AS version
  FROM events
  WHERE timestamp >= toDateTime('2026-06-01 00:00:00') AND properties.environment = 'production'
    AND properties.platform IN ('darwin', 'win32', 'linux') AND event = 'app_started'
  GROUP BY person_id
),
cohort AS (
  SELECT person_id, start_ts, platform, version, toStartOfWeek(start_ts, 0) AS cohort_week FROM starts
  WHERE start_ts >= toDateTime('2026-08-09 00:00:00')
    AND toStartOfWeek(start_ts, 0) <= toStartOfWeek(now(), 0) - INTERVAL 3 WEEK
    AND match(version, '^\\d{4}\\.\\d+\\.\\d+$')
),
engaged AS (
  SELECT e.person_id AS pid, min(e.timestamp) AS engaged_ts
  FROM events e INNER JOIN cohort c ON e.person_id = c.person_id
  WHERE e.timestamp >= toDateTime('2026-06-01 00:00:00') AND e.properties.environment = 'production'
    AND e.event IN ('app_active_heartbeat','note_opened','note_created','note_updated','journal_opened',
      'journal_updated','search_performed','command_palette_opened','task_created','task_updated',
      'task_completed','canvas_opened','graph_opened','project_opened','inbox_captured',
      'agent_chat_message_sent','setting_changed')
  GROUP BY pid
),
writes AS (
  SELECT e.person_id AS pid, countIf(e.timestamp >= g.engaged_ts AND e.timestamp < g.engaged_ts + INTERVAL 7 DAY) AS w
  FROM events e INNER JOIN engaged g ON e.person_id = g.pid
  WHERE e.timestamp >= toDateTime('2026-08-01 00:00:00') AND e.properties.environment = 'production'
    AND e.event = 'note_updated'
  GROUP BY pid
)
SELECT c.cohort_week AS cohort_week, c.platform AS platform,
  count() AS started,
  countIf(g.engaged_ts < c.start_ts + INTERVAL 7 DAY) AS engaged,
  countIf(g.engaged_ts < c.start_ts + INTERVAL 7 DAY AND w.w >= 1) AS edited,
  countIf(g.engaged_ts < c.start_ts + INTERVAL 7 DAY AND w.w >= 3) AS activated
FROM cohort c
LEFT JOIN engaged g ON g.pid = c.person_id
LEFT JOIN writes w ON w.pid = c.person_id
GROUP BY cohort_week, platform ORDER BY cohort_week, platform
