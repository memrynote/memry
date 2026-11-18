-- Growth · Aktivasyon (haftalık kohort)
-- One row per complete cohort week: new engaged desktop installs and how many activated.
-- Activation: at least 3 note_updated within 7 days of the install's first engaged event.
-- This is the `activation` query in .agents/skills/growth-review/collect.js, desktop platform
-- filter included. Change both together, so the page and the insight agree.
-- The event list is PostHog action 369611 "Desktop · Engaged use". Keep the three identical.
-- Like the action, a setting_changed for general.onboardingCompleted is not engaged use.
WITH firsts AS (
  SELECT person_id, min(timestamp) AS first_ts FROM events
  WHERE timestamp >= toDateTime('2026-06-01 00:00:00') AND properties.environment = 'production'
    AND properties.platform IN ('darwin', 'win32', 'linux')
    AND event IN ('app_active_heartbeat','note_opened','note_created','note_updated','journal_opened',
      'journal_updated','search_performed','command_palette_opened','task_created','task_updated',
      'task_completed','canvas_opened','graph_opened','project_opened','inbox_captured',
      'agent_chat_message_sent','setting_changed')
    AND NOT (event = 'setting_changed'
      AND ifNull(properties.setting = 'general.onboardingCompleted', 0))
  GROUP BY person_id
),
cohort AS (
  SELECT person_id, first_ts, toStartOfWeek(first_ts, 0) AS cohort_week FROM firsts
  WHERE first_ts >= toDateTime('2026-08-09 00:00:00')
    AND toStartOfWeek(first_ts, 0) <= toStartOfWeek(now(), 0) - INTERVAL 2 WEEK
),
writes AS (
  SELECT e.person_id AS pid, countIf(e.timestamp < c.first_ts + INTERVAL 7 DAY) AS w
  FROM events e INNER JOIN cohort c ON e.person_id = c.person_id
  WHERE e.timestamp >= toDateTime('2026-08-01 00:00:00') AND e.properties.environment = 'production'
    AND e.event = 'note_updated'
  GROUP BY pid
)
SELECT c.cohort_week AS cohort_week, count() AS new_installs, countIf(w.w >= 3) AS activated
FROM cohort c LEFT JOIN writes w ON w.pid = c.person_id
GROUP BY cohort_week ORDER BY cohort_week
