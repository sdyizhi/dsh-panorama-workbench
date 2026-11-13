import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * 派生观察层（规格 §4.3）——本插件的【唯一写入目标】。
 * 红线：不存任何消息正文；session_id 是关联原生数据的唯一外键；
 * 每个派生字段都带来源列（updated_at_source / summary_source），绝不伪造数据来源。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_observation (
  session_id            TEXT PRIMARY KEY,
  workspace_id          TEXT,
  first_seen_at         INTEGER,
  last_seen_at          INTEGER,
  created_at            INTEGER,
  open_count            INTEGER NOT NULL DEFAULT 0,
  user_tags             TEXT NOT NULL DEFAULT '[]',
  manual_note           TEXT,
  title_cache           TEXT,
  updated_at            INTEGER,
  updated_at_source     TEXT,
  summary_cache         TEXT,
  summary_source        TEXT,
  summary_for_updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS workspace_snapshot (
  workspace_id      TEXT PRIMARY KEY,
  session_count     INTEGER,
  active_count      INTEGER,
  last_activity_at  INTEGER,
  snapshot_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_obs_workspace ON session_observation(workspace_id);

-- R6 观察层对账历史：每次对账一行，供趋势追踪（覆盖/新鲜度随时间的变化）
CREATE TABLE IF NOT EXISTS reconciliation_run (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  at               INTEGER NOT NULL,
  healthy          INTEGER NOT NULL,
  workspace_coverage REAL,
  session_coverage   REAL,
  workspace_total    INTEGER,
  workspace_blind    INTEGER,
  session_total      INTEGER,
  session_blind      INTEGER,
  last_observed_at   INTEGER,
  age_days           INTEGER,
  min_coverage       REAL,
  max_age_days       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_recon_run_at ON reconciliation_run(at);

-- R1.5 任务状态表：任务粒度的验收反馈结构化（连续·记忆的结构化补强）
-- status: queued | running | delivered | accepted | rejected
-- verdict: pass | fail | NULL（未裁决）
CREATE TABLE IF NOT EXISTS task (
  task_id             TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued',
  acceptance_criteria TEXT,
  verdict             TEXT,
  verdict_reason      TEXT,
  verdict_by          TEXT,
  owner_session_ids   TEXT NOT NULL DEFAULT '[]',
  created_at          INTEGER,
  updated_at          INTEGER
);
-- R2c 回炉循环：rework_count 记录封驳次数；escalated=1 表示已达上限、需人工介入
-- （ALTER 迁移对既有库幂等生效；CREATE IF NOT EXISTS 不会给已存在的表加列）
CREATE TABLE IF NOT EXISTS task_r2c_migration (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);

-- R1.5 任务事件：完整状态链（每次状态/裁决/关联流转留痕，封驳理由不丢）
CREATE TABLE IF NOT EXISTS task_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- status | verdict | link
  from_value TEXT,
  to_value   TEXT,
  reason     TEXT,
  by         TEXT,
  at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_event_task ON task_event(task_id);
`

const TASK_STATUSES = ['queued', 'running', 'delivered', 'accepted', 'rejected']
const VERDICTS = ['pass', 'fail']
export const MAX_REWORK = 3

/** 幂等加列：CREATE TABLE IF NOT EXISTS 不会给已存在的表补列。 */
function ensureColumn(db, table, column, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  } catch { /* 迁移失败不阻断启动；写入时若列缺失会报错并被上层捕获 */ }
}

/** @param {string} home $DSH_HOME */
export function openDatabase(home) {
  const dir = path.join(home, 'panorama')
  fs.mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'panorama.db'))
  db.exec(SCHEMA)
  // R2c 迁移：给既有 task 表补列（幂等）
  ensureColumn(db, 'task', 'rework_count', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'task', 'escalated', 'INTEGER NOT NULL DEFAULT 0')

  const stmt = {
    get: db.prepare('SELECT * FROM session_observation WHERE session_id = ?'),
    ensure: db.prepare(`
      INSERT INTO session_observation (session_id, first_seen_at, last_seen_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO NOTHING`),
    list: db.prepare('SELECT * FROM session_observation'),
    listByWorkspace: db.prepare('SELECT * FROM session_observation WHERE workspace_id = ?'),
    touch: db.prepare(`
      INSERT INTO session_observation
        (session_id, workspace_id, first_seen_at, last_seen_at, created_at, updated_at, updated_at_source, title_cache)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        workspace_id      = excluded.workspace_id,
        last_seen_at      = excluded.last_seen_at,
        created_at        = COALESCE(excluded.created_at, session_observation.created_at),
        updated_at        = excluded.updated_at,
        updated_at_source = excluded.updated_at_source,
        title_cache       = COALESCE(excluded.title_cache, session_observation.title_cache)`),
    setSummary: db.prepare(`
      UPDATE session_observation
      SET summary_cache = ?, summary_source = ?, summary_for_updated_at = ?
      WHERE session_id = ?`),
    bumpOpen: db.prepare(`
      INSERT INTO session_observation (session_id, open_count, first_seen_at, last_seen_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        open_count   = session_observation.open_count + 1,
        last_seen_at = excluded.last_seen_at`),
    setTags: db.prepare('UPDATE session_observation SET user_tags = ? WHERE session_id = ?'),
    setNote: db.prepare('UPDATE session_observation SET manual_note = ? WHERE session_id = ?'),
    upsertWorkspace: db.prepare(`
      INSERT INTO workspace_snapshot (workspace_id, session_count, active_count, last_activity_at, snapshot_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        session_count    = excluded.session_count,
        active_count     = excluded.active_count,
        last_activity_at = excluded.last_activity_at,
        snapshot_at      = excluded.snapshot_at`),
    exportByDay: db.prepare(`
      SELECT date(updated_at / 1000, 'unixepoch', 'localtime') AS day, workspace_id, COUNT(*) AS count
      FROM session_observation
      WHERE updated_at IS NOT NULL AND updated_at >= ?
      GROUP BY day, workspace_id
      ORDER BY day`),
    exportTagFrequency: db.prepare(`
      SELECT value AS tag, COUNT(*) AS count
      FROM session_observation, json_each(session_observation.user_tags)
      GROUP BY value
      ORDER BY count DESC`),
    exportReused: db.prepare(`
      SELECT session_id FROM session_observation WHERE open_count >= 2 ORDER BY open_count DESC`),
    // native 行源无 createdAt（SessionSummary 不含）→ 兜底 first_seen_at（首次观察时间），
    // 并在返回值里标注 activeHoursSource，绝不冒充"会话启动时间"。
    exportActiveHours: db.prepare(`
      SELECT CAST(strftime('%H', COALESCE(created_at, first_seen_at) / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour, COUNT(*) AS count
      FROM session_observation
      WHERE COALESCE(created_at, first_seen_at) IS NOT NULL
      GROUP BY hour
      ORDER BY hour`),
    hasCreatedAt: db.prepare(`SELECT COUNT(*) AS c FROM session_observation WHERE created_at IS NOT NULL`).get,
    // ── R1.5 任务状态语句 ──
    listTasks: db.prepare(`SELECT * FROM task ORDER BY updated_at DESC LIMIT 200`),
    listTasksByStatus: db.prepare(`SELECT * FROM task WHERE status = ? ORDER BY updated_at DESC LIMIT 200`),
    getTask: db.prepare(`SELECT * FROM task WHERE task_id = ?`),
    insertTask: db.prepare(`
      INSERT INTO task (task_id, title, status, acceptance_criteria, owner_session_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        title = excluded.title,
        acceptance_criteria = COALESCE(excluded.acceptance_criteria, task.acceptance_criteria),
        updated_at = excluded.updated_at`),
    setStatus: db.prepare(`UPDATE task SET status = ?, updated_at = ? WHERE task_id = ?`),
    setVerdict: db.prepare(`UPDATE task SET status = ?, verdict = ?, verdict_reason = COALESCE(?, task.verdict_reason), verdict_by = COALESCE(?, task.verdict_by), rework_count = ?, escalated = ?, updated_at = ? WHERE task_id = ?`),
    setOwners: db.prepare(`UPDATE task SET owner_session_ids = ?, updated_at = ? WHERE task_id = ?`),
    deleteTask: db.prepare(`DELETE FROM task WHERE task_id = ?`),
    deleteEvents: db.prepare(`DELETE FROM task_event WHERE task_id = ?`),
    insertRecon: db.prepare(`
      INSERT INTO reconciliation_run
        (at, healthy, workspace_coverage, session_coverage, workspace_total, workspace_blind,
         session_total, session_blind, last_observed_at, age_days, min_coverage, max_age_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    lastRecon: db.prepare(`SELECT * FROM reconciliation_run ORDER BY id DESC LIMIT 1`),
    listRecon: db.prepare(`SELECT * FROM reconciliation_run ORDER BY at DESC LIMIT ?`),
    insertEvent: db.prepare(`INSERT INTO task_event (task_id, kind, from_value, to_value, reason, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    listEvents: db.prepare(`SELECT * FROM task_event WHERE task_id = ? ORDER BY id ASC`),
  }

  const now = () => Date.now()

  return {
    /** 会话元数据观察：刷新工作区归属/活动时间/标题缓存（不动 open_count/标签/摘要）。 */
    touchObservation({ sessionId, workspaceId = null, createdAt = null, updatedAt = null, updatedAtSource = null, title = null }) {
      const ts = now()
      stmt.touch.run(
        sessionId, workspaceId, ts, ts,
        createdAt, updatedAt, updatedAtSource, title,
      )
    },

    getObservation(sessionId) {
      return stmt.get.get(sessionId)
    },

    listObservations() {
      return stmt.list.all()
    },

    listByWorkspace(workspaceId) {
      return stmt.listByWorkspace.all(workspaceId)
    },

    /** 摘要写入（含"无命中"负缓存：cache=NULL 但带 for_updated_at）。 */
    setSummary(sessionId, { snippet = null, source = null, forUpdatedAt = null }) {
      stmt.setSummary.run(snippet, source, forUpdatedAt, sessionId)
    },

    /** 点击行时递增（验收 #5）。 */
    bumpOpenCount(sessionId) {
      const ts = now()
      stmt.bumpOpen.run(sessionId, ts, ts)
      return this.getObservation(sessionId)?.open_count ?? 1
    },

    /** 打标签（会话尚无观察行时先建行；不动 open_count —— 复用信号只由点击产生）。 */
    setTags(sessionId, tags) {
      const ts = now()
      stmt.ensure.run(sessionId, ts, ts)
      stmt.setTags.run(JSON.stringify(tags), sessionId)
      return tags
    },

    setManualNote(sessionId, note) {
      const ts = now()
      stmt.ensure.run(sessionId, ts, ts)
      stmt.setNote.run(note, sessionId)
      return note
    },

    upsertWorkspaceSnapshot({ workspaceId, sessionCount, activeCount, lastActivityAt }) {
      stmt.upsertWorkspace.run(workspaceId, sessionCount, activeCount, lastActivityAt, now())
    },

    /** P2 导出信号（零消息正文）。 */
    readExportSignals(since = 0) {
      let hasCreated = false
      try { hasCreated = (stmt.hasCreatedAt.get()?.c ?? 0) > 0 } catch { /* 忽略 */ }
      return {
        byDay: stmt.exportByDay.all(since),
        tagFrequency: stmt.exportTagFrequency.all(),
        reused: stmt.exportReused.all().map((row) => row.session_id),
        activeHours: stmt.exportActiveHours.all(),
        activeHoursSource: hasCreated ? 'created-at' : 'first-seen-at(近似)',
        provenance: 'dsh-panorama-workbench/panorama.db',
      }
    },

    // ── R1.5 任务状态 ──
    listTasks(status = null) {
      const rows = status && TASK_STATUSES.includes(status)
        ? stmt.listTasksByStatus.all(status)
        : stmt.listTasks.all()
      return rows.map((r) => ({ ...r, owner_session_ids: safeParseIds(r.owner_session_ids) }))
    },

    getTask(taskId) {
      const row = stmt.getTask.get(taskId)
      return row ? { ...row, owner_session_ids: safeParseIds(row.owner_session_ids) } : null
    },

    /** 完整状态链（R1.5 验收门）：事件按发生顺序。 */
    listTaskEvents(taskId) {
      return stmt.listEvents.all(taskId)
    },

    recordEvent(taskId, kind, { fromValue = null, toValue = null, reason = null, by = null } = {}) {
      stmt.insertEvent.run(
        taskId, kind,
        fromValue === null ? null : String(fromValue).slice(0, 500),
        toValue === null ? null : String(toValue).slice(0, 500),
        reason === null ? null : String(reason).slice(0, 4000),
        by === null ? null : String(by).slice(0, 128),
        now(),
      )
    },

    createTask({ taskId, title, acceptanceCriteria = null, ownerSessionIds = [] }) {
      if (!taskId || typeof taskId !== 'string') throw new Error('taskId required')
      if (!title || typeof title !== 'string') throw new Error('title required')
      const ts = now()
      stmt.insertTask.run(
        taskId.slice(0, 128), title.slice(0, 500), 'queued',
        acceptanceCriteria ? String(acceptanceCriteria).slice(0, 2000) : null,
        JSON.stringify(ownerSessionIds.slice(0, 64)), ts, ts,
      )
      this.recordEvent(taskId, 'status', { toValue: 'queued' })
      return this.getTask(taskId)
    },

    setTaskStatus(taskId, status) {
      if (!TASK_STATUSES.includes(status)) throw new Error(`invalid status: ${status}`)
      const row = stmt.getTask.get(taskId)
      if (!row) return null
      stmt.setStatus.run(status, now(), taskId)
      this.recordEvent(taskId, 'status', { fromValue: row.status, toValue: status })
      return this.getTask(taskId)
    },

    /** 裁决（门下省封驳的落点）：verdict=pass → accepted；fail → rejected（可带 reason 回炉）。
     *  R2c：fail 累加 rework_count；达到 MAX_REWORK 置 escalated=1（需人工介入，防止无限回炉）。 */
    setTaskVerdict(taskId, { verdict, reason = null, by = null, note = null }) {
      if (!VERDICTS.includes(verdict)) throw new Error(`invalid verdict: ${verdict}`)
      const row = stmt.getTask.get(taskId)
      if (!row) return null
      const status = verdict === 'pass' ? 'accepted' : 'rejected'
      const reworkCount = verdict === 'fail' ? (row.rework_count ?? 0) + 1 : (row.rework_count ?? 0)
      const escalated = verdict === 'fail' && reworkCount >= MAX_REWORK ? 1 : (row.escalated ?? 0)
      stmt.setVerdict.run(status, verdict,
        reason ? String(reason).slice(0, 4000) : null,
        by ? String(by).slice(0, 128) : null,
        reworkCount, escalated, now(), taskId)
      this.recordEvent(taskId, 'verdict', {
        fromValue: row.verdict ? `${row.verdict}(${row.status})` : row.status,
        toValue: `${verdict}(${status})${escalated ? ' [escalated]' : ''}${note ? ` [${note}]` : ''}`,
        reason, by,
      })
      return this.getTask(taskId)
    },

    linkTaskSessions(taskId, sessionIds) {
      const row = stmt.getTask.get(taskId)
      if (!row) return null
      const before = safeParseIds(row.owner_session_ids)
      const merged = [...new Set([...before, ...sessionIds])].slice(0, 64)
      stmt.setOwners.run(JSON.stringify(merged), now(), taskId)
      this.recordEvent(taskId, 'link', { fromValue: before.join(','), toValue: merged.join(',') })
      return this.getTask(taskId)
    },

    /** 删除任务及其事件链（测试清理/撤回用）。返回是否确实删掉了。 */
    deleteTask(taskId) {
      const row = stmt.getTask.get(taskId)
      if (!row) return false
      stmt.deleteEvents.run(taskId)
      stmt.deleteTask.run(taskId)
      return true
    },

    // ── R6 观察层对账历史 ──
    recordReconciliation(result) {
      stmt.insertRecon.run(
        result.now, result.healthy ? 1 : 0,
        result.workspaceCoverage, result.sessionCoverage,
        result.workspaces.total, result.workspaces.blind,
        result.sessions.total, result.sessions.blind,
        result.lastObservedAt, result.ageDays,
        result.minCoverage, result.maxAgeDays,
      )
      return stmt.lastRecon.get()
    },

    listReconciliations(limit = 60) {
      return stmt.listRecon.all(Math.min(Math.max(1, limit), 500))
    },

    close() {
      db.close()
    },
  }
}

function safeParseIds(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
