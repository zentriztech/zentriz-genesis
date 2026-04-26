-- Migration 002: columns needed by the Watchdog service (auto-recovery)
-- All statements are idempotent (ADD COLUMN IF NOT EXISTS).

-- extra: arbitrary JSONB metadata written by Watchdog (timed_out, last_watchdog_restart, etc.)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}';

-- restart_count: incremented each time Watchdog relaunches an orphan pipeline
ALTER TABLE projects ADD COLUMN IF NOT EXISTS restart_count INTEGER NOT NULL DEFAULT 0;

-- stopped_by: 'user' when stopped via /stop endpoint; NULL when stopped by crash/restart
-- Watchdog skips relaunching projects where stopped_by = 'user'
ALTER TABLE projects ADD COLUMN IF NOT EXISTS stopped_by TEXT;
