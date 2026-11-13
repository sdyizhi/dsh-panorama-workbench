/**
 * R3 主动信号（panorama_signals）：按需评估"该被主动提起但没人问"的事。
 * 评估逻辑在 signals.js（纯函数，离线可测）。
 */
import { evaluateSignals } from './signals.js'
import { computeReconciliation } from './reconcile.js'

/** 工作区 id → 标题（只读 workspaceRegistry；不可用时返回空 Map，信号退化为只显示 id）。 */
function workspaceTitlesOf(ctx) {
  const map = new Map()
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    for (const w of registry?.list?.() ?? []) map.set(w.id, w.title)
  } catch { /* 无 registry 时省略标题 */ }
  return map
}

/** 观察层对账（R6）：失败时返回 null → stale-observation 条件静默（不影响其余信号）。 */
function reconciliationOf(ctx, db, opts) {
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    const workspaces = []
    for (const w of registry?.list?.() ?? []) {
      workspaces.push({ id: w.id, title: w.title, sessionIds: w.sessionIds })
    }
    return computeReconciliation({
      workspaces,
      observations: db.listObservations(),
      minCoverage: Number.isFinite(opts.minCoverage) ? opts.minCoverage : 0.9,
      maxAgeDays: Number.isFinite(opts.maxAgeDays) ? opts.maxAgeDays : 14,
    })
  } catch { return null }
}

export function buildSignalsTool(db, ctx, opts = {}) {
  const thresholdDays = Number.isFinite(opts.thresholdDays) ? opts.thresholdDays : 3

  // days 必须形参化：曾写成闭包捕获 thresholdDays，导致模型传的 thresholdDays 被吞掉
  // （返回里 requestedThresholdDays 显示新值，实际评估仍用配置默认值）。
  const compute = (days) => {
    if (!db) return null
    const tasks = db.listTasks()
    const rows = db.listObservations()
    const activity = new Map()
    for (const r of rows) {
      if (!r.workspace_id) continue
      const ts = Number.isFinite(r.updated_at) ? r.updated_at : r.last_seen_at
      if (!Number.isFinite(ts)) continue
      const prev = activity.get(r.workspace_id)
      if (prev === undefined || ts > prev) activity.set(r.workspace_id, ts)
    }
    return evaluateSignals(tasks, activity, {
      thresholdDays: days,
      thresholds: opts.thresholds,
      workspaceTitles: workspaceTitlesOf(ctx),
      reconciliation: reconciliationOf(ctx, db, opts),
    })
  }

  return {
    name: 'panorama_signals',
    description: [
      'Evaluate panorama proactive signals — the things nobody asked about:',
      'tasks rejected and never re-delivered, escalated tasks needing a human, tasks idle for days,',
      'and workspaces with no activity for days.',
      'Returns conditions with severity; use it to decide whether to raise anything, or to stay silent.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        thresholdDays: {
          type: 'number',
          description: `Days of inactivity before a task or workspace counts as stale (default ${thresholdDays}).`,
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      if (!db) return { ok: false, code: 'derived-db-unavailable', message: 'panorama derived database is unavailable' }
      const days = Number.isFinite(args?.thresholdDays) ? args.thresholdDays : thresholdDays
      const conditions = compute(days)
      return {
        ok: true,
        requestedThresholdDays: days,
        conditions,
        warnCount: conditions.filter((c) => c.severity === 'warn').reduce((s, c) => s + c.count, 0),
      }
    },
  }
}
