/**
 * R6 观察层对账（持续化）：覆盖维度 + 新鲜度。
 *
 * 为什么只做覆盖、不做形状：
 *  - 覆盖（哪些工作区/会话被观察过）可由 workspace 注册 + 派生库算出 → 插件内可做；
 *  - 形状（工时分布）必须读会话日志 → 触红线，只能走离线工具（panorama-spec）。
 *
 * 输入全部只读；输出既用于即时判断，也写入 reconciliation_run 供趋势追踪。
 */

const DAY_MS = 86_400_000

export const DEFAULT_MIN_COVERAGE = 0.9
export const DEFAULT_MAX_AGE_DAYS = 14

const round3 = (n) => Math.round(n * 1000) / 1000

/**
 * @param workspaces workspaceRegistry.list() 的简形 {id, title, sessionIds}
 * @param observations panorama.db 的 session_observation 行
 * @param opts { now, minCoverage, maxAgeDays }
 */
export function computeReconciliation({ workspaces = [], observations = [], now = Date.now(), minCoverage = DEFAULT_MIN_COVERAGE, maxAgeDays = DEFAULT_MAX_AGE_DAYS }) {
  const observedWs = new Set(observations.map((o) => o.workspace_id).filter(Boolean))
  // ⚠️ 两侧 id 必须归一化后再比：workspace.sessionIds 与 session_observation.session_id
  // 都可能是 `session-<uuid>` 或裸 uuid（实测两种都出现过），不归一化会得出 0% 假覆盖。
  const observedSessions = new Set(
    observations.map((o) => String(o.session_id).replace(/^session-/, '')).filter(Boolean),
  )

  const blindWorkspaces = workspaces
    .filter((w) => !observedWs.has(w.id))
    .map((w) => ({ id: w.id, title: w.title }))
  const workspaceCoverage = workspaces.length
    ? (workspaces.length - blindWorkspaces.length) / workspaces.length
    : 1

  // 注册会话（workspace.sessionIds 的并集）与观察层的差集
  const registeredSessions = new Set()
  for (const w of workspaces) {
    for (const s of w.sessionIds ?? []) registeredSessions.add(String(s).replace(/^session-/, ''))
  }
  const coveredSessions = [...registeredSessions].filter((id) => observedSessions.has(id)).length
  const sessionCoverage = registeredSessions.size ? coveredSessions / registeredSessions.size : 1
  const blindSessionCount = registeredSessions.size - coveredSessions
  // 被观察但不在任何注册工作区的会话（孤儿观察行，供排查）
  const orphanObservations = [...observedSessions].filter((id) => !registeredSessions.has(id)).length

  // 新鲜度：观察层最后一次被"打开面板"刷新的时间
  const lastObservedAt = observations.reduce((m, o) => Math.max(m, o.last_seen_at ?? 0), 0)
  const ageDays = lastObservedAt ? Math.floor((now - lastObservedAt) / DAY_MS) : null

  const healthy = workspaceCoverage >= minCoverage
    && sessionCoverage >= minCoverage
    && (ageDays === null || ageDays <= maxAgeDays)

  return {
    now,
    minCoverage,
    maxAgeDays,
    healthy,
    workspaceCoverage: round3(workspaceCoverage),
    sessionCoverage: round3(sessionCoverage),
    workspaces: { total: workspaces.length, covered: workspaces.length - blindWorkspaces.length, blind: blindWorkspaces.length },
    sessions: { total: registeredSessions.size, covered: coveredSessions, blind: blindSessionCount, orphan: orphanObservations },
    blindWorkspaces: blindWorkspaces.slice(0, 20),
    lastObservedAt,
    ageDays,
  }
}
