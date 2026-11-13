/**
 * R3 主动触发：条件评估（纯逻辑，离线可测）。
 *
 * 设计目标：把"该被主动提起但没人问"的事算出来 ——
 *  - 封驳后久未回炉（rejected 且超过阈值没有再交付）
 *  - 已升级待人工（escalated）
 *  - 任务多日无进展（running 且超过阈值没动）
 *  - 工作区长期无活动（观察层里最后一个活动超过阈值）
 *
 * 只读 panorama.db 与 session_observation，不触碰原生存储。
 */

/**
 * 四类条件。**每项自带默认阈值**：任务回炉以天计（3 天），项目节奏以周月计（30 天）——
 * 实测（2026-11-10）：工作区用 3 天阈值时 63 个里命中 53 个，绝大多数是历史归档，信息量低。
 * thresholdDays=null 表示该条件不看阈值（如"已升级待人工"立即生效）。
 */
export const CONDITION_DEFS = [
  { id: 'escalated-tasks', title: '已升级待人工', severity: 'warn', thresholdDays: null },
  { id: 'stale-rejected', title: '封驳后久未回炉', severity: 'warn', thresholdDays: 3 },
  { id: 'stale-running', title: '任务多日无进展', severity: 'info', thresholdDays: 3 },
  { id: 'idle-workspace', title: '工作区长期无活动', severity: 'info', thresholdDays: 30 },
  // R6：观察层健康度（覆盖/新鲜度）——由 opts.reconciliation 提供，缺省不产出
  { id: 'stale-observation', title: '观察层久未刷新', severity: 'warn', thresholdDays: null },
]

const DAY_MS = 86_400_000

/** 解析某条件实际生效的天数：逐条件覆盖 > 全局覆盖 > 该条件默认；null = 该条件不看阈值。 */
function thresholdOf(def, opts) {
  if (opts?.thresholds && Number.isFinite(opts.thresholds[def.id])) return opts.thresholds[def.id]
  if (Number.isFinite(opts?.thresholdDays)) return opts.thresholdDays
  if (def.thresholdDays === null) return null
  return Number.isFinite(def.thresholdDays) ? def.thresholdDays : 3
}

/** 单个条件 → 命中项列表 */
function evalCondition(def, { tasks, workspaceActivity, now, thresholdDays, reconciliation }) {
  const cutoff = thresholdDays === null ? null : now - thresholdDays * DAY_MS
  switch (def.id) {    case 'escalated-tasks':
      return tasks
        .filter((t) => t.escalated)
        .map((t) => ({
          taskId: t.task_id, title: t.title, status: t.status,
          since: t.updated_at, days: t.updated_at ? Math.floor((now - t.updated_at) / DAY_MS) : null,
        }))
    case 'stale-rejected':
      return tasks
        .filter((t) => t.status === 'rejected' && !t.escalated && t.updated_at && t.updated_at < cutoff)
        .map((t) => ({
          taskId: t.task_id, title: t.title, status: t.status,
          since: t.updated_at, days: Math.floor((now - t.updated_at) / DAY_MS),
          reason: t.verdict_reason ?? null,
        }))
    case 'stale-running':
      return tasks
        .filter((t) => t.status === 'running' && t.updated_at && t.updated_at < cutoff)
        .map((t) => ({
          taskId: t.task_id, title: t.title, status: t.status,
          since: t.updated_at, days: Math.floor((now - t.updated_at) / DAY_MS),
        }))
    case 'idle-workspace': {
      const rows = []
      for (const [workspaceId, last] of workspaceActivity) {
        if (!last || last >= cutoff) continue
        rows.push({ workspaceId, since: last, days: Math.floor((now - last) / DAY_MS) })
      }
      return rows.sort((a, b) => a.since - b.since)
    }
    case 'stale-observation': {
      const r = reconciliation
      if (!r) return []
      const problems = []
      if (r.ageDays !== null && r.ageDays > r.maxAgeDays) {
        problems.push({ kind: 'stale', lastObservedAt: r.lastObservedAt, ageDays: r.ageDays, thresholdDays: r.maxAgeDays })
      }
      if (r.workspaceCoverage < r.minCoverage) {
        problems.push({ kind: 'workspace-coverage', coverage: r.workspaceCoverage, threshold: r.minCoverage, blind: r.workspaces.blind })
      }
      if (r.sessionCoverage < r.minCoverage) {
        problems.push({ kind: 'session-coverage', coverage: r.sessionCoverage, threshold: r.minCoverage, blind: r.sessions.blind })
      }
      return problems
    }
    /* v8 ignore next -- closed id union */
    default:
      return []
  }
}

/**
 * 评估全部条件。
 * @param tasks 任务行（含 rework_count/escalated/updated_at）
 * @param workspaceActivity Map<workspaceId, lastActivityMs>
 * @param opts { now, thresholdDays, workspaceTitles?: Map<string,string> }
 */
export function evaluateSignals(tasks, workspaceActivity, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const titles = opts.workspaceTitles ?? null
  return CONDITION_DEFS.map((def) => {
    const thresholdDays = thresholdOf(def, opts)
    const raw = evalCondition(def, { tasks, workspaceActivity, now, thresholdDays, reconciliation: opts.reconciliation })
    // 工作区信号必须带标题：只给 id 用户无法判断是哪个项目
    const items = def.id === 'idle-workspace'
      ? raw.map((it) => ({ ...it, title: titles?.get(it.workspaceId) ?? null }))
      : raw
    return {
      id: def.id,
      title: def.title,
      severity: def.severity,
      thresholdDays,
      count: items.length,
      items: items.slice(0, 20),
    }
  })
}

/** 从观察行聚合出 Map<workspaceId, 最后活动时间>（跳过 null 工作区）。 */
export function workspaceActivityFromObservations(rows, now = Date.now()) {
  const map = new Map()
  for (const r of rows) {
    if (!r.workspace_id) continue
    const ts = Number.isFinite(r.updated_at) ? r.updated_at : r.last_seen_at
    if (!Number.isFinite(ts) || ts > now) continue
    const prev = map.get(r.workspace_id)
    if (prev === undefined || ts > prev) map.set(r.workspace_id, ts)
  }
  return map
}
