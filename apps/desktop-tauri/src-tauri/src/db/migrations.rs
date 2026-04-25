use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use std::collections::HashSet;

pub static EMBEDDED: &[(&str, &str)] = &MIGRATIONS;

static MIGRATIONS: [(&str, &str); 29] = [
    (
        "0000_thankful_luke_cage.sql",
        include_str!("../../migrations/0000_thankful_luke_cage.sql"),
    ),
    (
        "0001_married_shadow_king.sql",
        include_str!("../../migrations/0001_married_shadow_king.sql"),
    ),
    (
        "0002_broken_sleeper.sql",
        include_str!("../../migrations/0002_broken_sleeper.sql"),
    ),
    (
        "0003_shallow_gladiator.sql",
        include_str!("../../migrations/0003_shallow_gladiator.sql"),
    ),
    (
        "0004_odd_silver_sable.sql",
        include_str!("../../migrations/0004_odd_silver_sable.sql"),
    ),
    (
        "0005_old_mac_gargan.sql",
        include_str!("../../migrations/0005_old_mac_gargan.sql"),
    ),
    (
        "0006_late_infant_terrible.sql",
        include_str!("../../migrations/0006_late_infant_terrible.sql"),
    ),
    (
        "0007_safe_sunspot.sql",
        include_str!("../../migrations/0007_safe_sunspot.sql"),
    ),
    (
        "0008_blushing_magma.sql",
        include_str!("../../migrations/0008_blushing_magma.sql"),
    ),
    (
        "0009_lumpy_gladiator.sql",
        include_str!("../../migrations/0009_lumpy_gladiator.sql"),
    ),
    (
        "0010_dizzy_natasha_romanoff.sql",
        include_str!("../../migrations/0010_dizzy_natasha_romanoff.sql"),
    ),
    (
        "0011_silent_shooting_star.sql",
        include_str!("../../migrations/0011_silent_shooting_star.sql"),
    ),
    (
        "0012_lush_veda.sql",
        include_str!("../../migrations/0012_lush_veda.sql"),
    ),
    (
        "0013_last_guardian.sql",
        include_str!("../../migrations/0013_last_guardian.sql"),
    ),
    (
        "0014_dazzling_leopardon.sql",
        include_str!("../../migrations/0014_dazzling_leopardon.sql"),
    ),
    (
        "0015_brief_hex.sql",
        include_str!("../../migrations/0015_brief_hex.sql"),
    ),
    (
        "0016_lovely_mastermind.sql",
        include_str!("../../migrations/0016_lovely_mastermind.sql"),
    ),
    (
        "0017_spotty_mongu.sql",
        include_str!("../../migrations/0017_spotty_mongu.sql"),
    ),
    (
        "0018_greedy_stepford_cuckoos.sql",
        include_str!("../../migrations/0018_greedy_stepford_cuckoos.sql"),
    ),
    (
        "0019_material_lethal_legion.sql",
        include_str!("../../migrations/0019_material_lethal_legion.sql"),
    ),
    (
        "0020_search_reasons.sql",
        include_str!("../../migrations/0020_search_reasons.sql"),
    ),
    (
        "0021_inbox_jobs.sql",
        include_str!("../../migrations/0021_inbox_jobs.sql"),
    ),
    (
        "0022_notes_journal_vault.sql",
        include_str!("../../migrations/0022_notes_journal_vault.sql"),
    ),
    (
        "0023_folder_configs.sql",
        include_str!("../../migrations/0023_folder_configs.sql"),
    ),
    (
        "0024_google_calendar_foundation.sql",
        include_str!("../../migrations/0024_google_calendar_foundation.sql"),
    ),
    (
        "0025_event_target_calendar.sql",
        include_str!("../../migrations/0025_event_target_calendar.sql"),
    ),
    (
        "0026_calendar_field_clocks.sql",
        include_str!("../../migrations/0026_calendar_field_clocks.sql"),
    ),
    (
        "0027_calendar_rich_fields.sql",
        include_str!("../../migrations/0027_calendar_rich_fields.sql"),
    ),
    (
        "0028_calendar_source_last_error.sql",
        include_str!("../../migrations/0028_calendar_source_last_error.sql"),
    ),
];

pub fn bootstrap(conn: &mut Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );",
    )?;

    Ok(())
}

pub fn apply_pending(conn: &mut Connection) -> AppResult<()> {
    bootstrap(conn)?;

    let applied = applied_migrations(conn)?;
    let pending: Vec<(&'static str, &'static str)> = EMBEDDED
        .iter()
        .copied()
        .filter(|(name, _)| !applied.contains(*name))
        .collect();

    if pending.is_empty() {
        return Ok(());
    }

    // Several Drizzle ports (e.g. 0002, 0009, 0013, 0018) rebuild tables via
    // the `CREATE __new_X / INSERT / DROP X / RENAME` pattern. SQLite silently
    // no-ops `PRAGMA foreign_keys = OFF` inside a transaction, so the in-SQL
    // pragma is not enough. If the caller opened the connection with FK
    // enforcement on (Db::open / Db::open_memory both do), `DROP TABLE X`
    // would cascade-delete rows in tables that reference X *before* the
    // migration copies them, silently corrupting populated databases on
    // upgrade. Toggle FK off at connection scope around the replay, then
    // re-enable and verify integrity afterwards.
    let prev_fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
    if prev_fk != 0 {
        conn.execute_batch("PRAGMA foreign_keys = OFF")?;
    }

    for (name, sql) in &pending {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)
            .map_err(|err| AppError::Database(format!("migration {name} failed: {err}")))?;
        tx.execute(
            "INSERT INTO schema_migrations (name) VALUES (?1)",
            params![name],
        )?;
        tx.commit()?;
    }

    if prev_fk != 0 {
        conn.execute_batch("PRAGMA foreign_keys = ON")?;
        let violations = collect_fk_violations(conn)?;
        if !violations.is_empty() {
            return Err(AppError::Database(format!(
                "foreign_key_check failed after migration replay: {violations:?}"
            )));
        }
    }

    Ok(())
}

fn applied_migrations(conn: &Connection) -> AppResult<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT name FROM schema_migrations")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let applied = rows.collect::<Result<HashSet<_>, _>>()?;

    Ok(applied)
}

fn collect_fk_violations(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
    let rows = stmt.query_map([], |row| {
        let table: String = row.get(0)?;
        let rowid: Option<i64> = row.get(1)?;
        let parent: String = row.get(2)?;
        Ok(format!(
            "{table}#{} -> {parent}",
            rowid.map(|r| r.to_string()).unwrap_or_else(|| "?".into())
        ))
    })?;

    Ok(rows.filter_map(Result::ok).collect())
}
