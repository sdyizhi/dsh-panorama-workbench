/**
 * 聚合器（规格 §6）：行源 × 工作区分组 × 过滤链 × 批量标题 × 派生库信号。
 * 红线：只读原生服务（sessionController / sessionQuery / workspaceRegistry /
 * workspaceController）；唯一写入 panorama.db（touchObservation /
 * workspace_snapshot），不存消息正文。
 */

const RANGE_MS = {
  '1d': 86_400_000,
  '3d': 3 * 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
}
const MAX_ROWS = 500
const UNGROUPED = '__ungrouped__'

/**
 * 数据源模式：支持字符串或【按请求时点现算的函数】——控制器服务可能晚于
 * 本行激活（P1 实测竞态），不得锁存（规格 §5.3）。
 */
function resolveMode(ctx, opts) {
  const configured = typeof opts.dataSource === 'function' ? opts.dataSource() : opts.dataSource
  if (configured === 'native') return 'native'
  if (configured === 'strict') return 'strict'
  return ctx.get('sessionController') && ctx.get('workspaceController') ? 'native' : 'strict'
}

/** 取工作区基线（follow 首帧；契约保证首帧即 baseline），失败返回 null → 归档集未知。 */
async function readBaseline(ctx) {
  const workspaceController = ctx.get('workspaceController')
  if (!workspaceController) return null
  const controller = new AbortController()
  try {
    for await (const frame of workspaceController.follow(controller.signal)) {
      if (frame.type === 'baseline') {
        controller.abort()
        return frame.value
      }
    }
  } catch {
    // abort 或流错误：按"归档集未知"降级（capabilities.archivedUnknown）
  }
  return null
}

function parseTags(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * @param ctx Host context
 * @param opts { dataSource: string | (() => string), includeSubagents: boolean }
 * @param db 派生库句柄（可为 null —— 降级为无观察数据）
 * @returns snapshot(query) → 规格 §4.4 的聚合 JSON
 */
export function createAggregator(ctx, opts, db) {
  return async function snapshot(query = {}) {
    const signal = AbortSignal.timeout(20_000)
    const mode = resolveMode(ctx, opts)
    const includeSubagents = Boolean(opts.includeSubagents)

    // ── 1) 行源（一律 ctx.get()：TypertRemoteService 类服务属性访问取不到 —— P2 实测500根因） ──
    let rows
    if (mode === 'native') {
      const sessionController = ctx.get('sessionController')
      if (!sessionController) throw new Error('sessionController unavailable (mode=native)')
      const value = await sessionController.list({}, signal)
      rows = value.items.map((s) => ({
        sessionId: s.sessionId,
        createdAt: null,               // SessionSummary 不含 createdAt（源码定案）
        updatedAt: s.updatedAt,         // = max(createdAt, 最近用户持久消息)
        origin: s.origin,
        running: s.running,
        cwd: s.cwd,
        blank: s.blank,                 // 原生 tree.ts 会隐藏 blank（P4 对账定案）
      }))
    } else {
      const query = ctx.get('sessionQuery')
      if (!query) throw new Error('sessionQuery unavailable (mode=strict)')
      const records = await query.listSessions(signal)
      rows = records.map((r) => ({
        sessionId: r.header.id,
        createdAt: r.header.createdAt,
        updatedAt: r.header.createdAt,  // strict：无 updatedAt → 用 createdAt（provenance 标注）
        origin: r.header.origin,
        running: r.live,                // strict 语义为"活动(live)"，capabilities 标注
        cwd: r.header.cwd,
      }))
    }
    let skippedSubagents = 0
    if (!includeSubagents) {
      const before = rows.length
      rows = rows.filter((r) => r.origin !== 'subagent')
      skippedSubagents = before - rows.length
    }

    // ── 2) 工作区映射 + 归档/置顶集（native 走 follow 首帧） ──
    const workspaceRegistry = ctx.get('workspaceRegistry')
    if (!workspaceRegistry) throw new Error('workspaceRegistry unavailable')
    const registry = workspaceRegistry.list()
    const sessionToWs = new Map()
    for (const w of registry) {
      for (const sid of w.sessionIds) if (!sessionToWs.has(sid)) sessionToWs.set(sid, w.id)
    }
    let archived = new Set()
    let archivedUnknown = mode !== 'native'
    if (mode === 'native') {
      const baseline = await readBaseline(ctx)
      if (baseline) archived = new Set(baseline.archivedSessionIds)
      else archivedUnknown = true
    }

    // ── 3) 过滤链：status → range → workspaces → tags ──
    const now = Date.now()
    const rangeMs = Object.prototype.hasOwnProperty.call(RANGE_MS, query.range) ? RANGE_MS[query.range] : null
    const status = ['all', 'running', 'idle', 'archived'].includes(query.status) ? query.status : 'all'
    const wsFilter = query.workspaces
      ? new Set(String(query.workspaces).split(',').map((s) => s.trim()).filter(Boolean))
      : null
    const wantTags = query.tags
      ? String(query.tags).split(',').map((s) => s.trim()).filter(Boolean)
      : null

    const observations = new Map()
    if (db) {
      try {
        for (const obs of db.listObservations()) observations.set(obs.session_id, obs)
      } catch { /* 观察层读取失败 → 视为无观察 */ }
    }

    let archivedHidden = 0
    let blankHidden = 0
    const visible = []
    for (const row of rows) {
      // 与原生 tree.ts sessionVisible 同序：subagent（上文已剔）→ blank → archived。
      // 原生只显示"当前选中的 blank"，Host 侧无法获知客户端选中态 → 全部隐藏并计数。
      if (row.blank) { blankHidden += 1; continue }
      const isArchived = archived.has(row.sessionId)
      if (status === 'archived') {
        if (!isArchived) continue
      } else {
        if (isArchived) { archivedHidden += 1; continue }
        if (status === 'running' && !row.running) continue
        if (status === 'idle' && row.running) continue
      }
      if (rangeMs !== null && row.updatedAt < now - rangeMs) continue
      const wsId = sessionToWs.get(row.sessionId) ?? null
      if (wsFilter && !wsFilter.has(wsId ?? UNGROUPED)) continue
      const obs = observations.get(row.sessionId)
      if (wantTags) {
        const own = obs ? parseTags(obs.user_tags) : []
        if (!wantTags.every((tag) => own.includes(tag))) continue
      }
      visible.push({ ...row, workspaceId: wsId, observation: obs })
    }
    visible.sort((a, b) => b.updatedAt - a.updatedAt)
    const truncated = visible.length > MAX_ROWS
    const shown = truncated ? visible.slice(0, MAX_ROWS) : visible

    // ── 4) 批量标题 + 创建时间（同一次 readTitleSnapshots 调用：title 与
    //       value.session.createdAt 一并取回——native 行源缺 createdAt 的补齐路径） ──
    const titles = new Map()
    const createdAts = new Map()
    if (shown.length) {
      try {
        const query = ctx.get('sessionQuery')
        const results = query
          ? await query.readTitleSnapshots(shown.map((r) => r.sessionId), signal)
          : []
        for (const item of results) {
          if (item.status !== 'fulfilled' || !item.value) continue
          if (item.value.title) titles.set(item.sessionId, item.value.title.title)
          // SessionHeader.createdAt 存在且早于当前记录的更新时间 → 采用（头更权威）
          const headerCreatedAt = item.value.session?.createdAt
          if (Number.isFinite(headerCreatedAt)) createdAts.set(item.sessionId, headerCreatedAt)
        }
      } catch { /* 标题失败不致命：回退 title_cache / null */ }
    }

    // ── 5) 组装 Row + 写观察层（touchObservation，带 provenance） ──
    // createdAt 优先级：行源自带（strict 模式）> readTitleSnapshots 的 SessionHeader.createdAt（native 补齐）
    const createdAtOf = (sessionId, rowCreatedAt) => {
      const fromHeader = createdAts.get(sessionId)
      return Number.isFinite(rowCreatedAt) ? rowCreatedAt : (fromHeader ?? null)
    }
    const toRow = (r) => {
      const obs = r.observation
      const title = titles.get(r.sessionId) ?? obs?.title_cache ?? null
      const cachedSnippet = obs
        && obs.summary_cache
        && obs.summary_for_updated_at === r.updatedAt ? obs.summary_cache : null
      const createdAt = createdAtOf(r.sessionId, r.createdAt)
      return {
        sessionId: r.sessionId,
        title,
        createdAt,
        updatedAt: r.updatedAt,
        updatedAtSource: mode === 'native' ? 'session-summary' : 'created-at',
        status: archived.has(r.sessionId) ? 'archived' : (r.running ? 'running' : 'idle'),
        origin: r.origin ?? null,
        cwd: r.cwd ?? null,
        workspaceId: r.workspaceId,
        tags: obs ? parseTags(obs.user_tags) : [],
        openCount: obs?.open_count ?? 0,
        manualNote: obs?.manual_note ?? null,
        snippet: cachedSnippet,                 // P3：miss 由 /panorama/summaries 补
        snippetSource: cachedSnippet ? (obs.summary_source ?? 'session-query-snippet') : null,
      }
    }
    const rowList = shown.map(toRow)

    if (db) {
      try {
        for (const r of shown) {
          db.touchObservation({
            sessionId: r.sessionId,
            workspaceId: r.workspaceId,
            createdAt: createdAtOf(r.sessionId, r.createdAt),
            updatedAt: r.updatedAt,
            updatedAtSource: mode === 'native' ? 'session-summary' : 'created-at',
            title: titles.get(r.sessionId) ?? null,
          })
        }
      } catch { /* 观察层写失败不影响展示 */ }
    }

    // ── 6) 分组：registry 顺序；未分组殿后 ──
    const byWs = new Map()
    for (const row of rowList) {
      const key = row.workspaceId ?? UNGROUPED
      if (!byWs.has(key)) byWs.set(key, [])
      byWs.get(key).push(row)
    }
    const wanted = wsFilter ? registry.filter((w) => wsFilter.has(w.id)) : registry
    const groups = wanted.map((w) => {
      const list = byWs.get(w.id) ?? []
      return { workspaceId: w.id, title: w.title, path: w.path, count: list.length, sessions: list }
    }).filter((g) => g.count > 0 || !wsFilter)
    const ungroupedRows = byWs.get(UNGROUPED) ?? []

    // ── 7) 概览 + 派生快照缓存 ──
    const overview = {
      workspaceCount: registry.length,
      sessionCount: rows.length,
      visibleCount: rowList.length,
      runningCount: rowList.filter((r) => r.status === 'running').length,
      lastActivityAt: rowList.length ? Math.max(...rowList.map((r) => r.updatedAt)) : null,
      skippedSubagents,
      blankHidden,
      archivedHidden,
    }
    if (db) {
      try {
        for (const g of groups) {
          db.upsertWorkspaceSnapshot({
            workspaceId: g.workspaceId,
            sessionCount: g.count,
            activeCount: g.sessions.filter((r) => r.status === 'running').length,
            lastActivityAt: g.count ? Math.max(...g.sessions.map((r) => r.updatedAt)) : null,
          })
        }
      } catch { /* 快照缓存失败可忽略 */ }
    }

    return {
      generatedAt: now,
      capabilities: {
        dataSource: mode,
        archivedAvailable: mode === 'native' && !archivedUnknown,
        archivedUnknown,
        tagsAvailable: Boolean(db),
        rowLimit: MAX_ROWS,
      },
      overview,
      groups,
      ungrouped: { count: ungroupedRows.length, sessions: ungroupedRows },
      truncated,
    }
  }
}
