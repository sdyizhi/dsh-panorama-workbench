import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { openDatabase } from './panorama-db.js'
import { createAggregator } from './aggregator.js'
import { createSummaryService } from './summary.js'
import { createMemoryBridge } from './memory-bridge.js'
import { buildTaskTool } from './task-tool.js'
import { buildAuditTool } from './audit-tool.js'
import { buildDeliverTool } from './deliver-tool.js'
import { buildSignalsTool } from './signals-tool.js'
import { buildWatchTool } from './watch-tool.js'
import { evaluateSignals, workspaceActivityFromObservations } from './signals.js'
import { computeReconciliation, DEFAULT_MIN_COVERAGE, DEFAULT_MAX_AGE_DAYS } from './reconcile.js'

const VERSION = '1.0.0'
/** 与 package.json peerDependencies 中的 @deepseek-ai/dsh 精确一致（约束 C6）。 */
const PEER_DSH_VERSION = '0.2.2-rc.1'
const PHASE = 'P1'

/** 参与代码版本戳的运行时文件（不含 locale/icon 等静态资源）。 */
const CODE_FILES = [
  'index.js', 'aggregator.js', 'summary.js', 'memory-bridge.js', 'panorama-db.js',
  'task-tool.js', 'audit-tool.js', 'audit-core.js', 'deliver-tool.js', 'client.js',
]

/**
 * 代码版本戳 = 运行时文件的最大 mtime（ms）。
 * 用途：Host 只在启动时加载插件代码 —— 磁盘上改了文件但没重启时，
 *   codeStamp（apply 时记录） < diskStamp（请求时现读）
 * 面板据此提示"磁盘代码已更新，运行中的 Host 是旧版"，不再靠 chip 猜。
 * 读不到文件时返回 null（不阻断 health）。
 */
function codeStampOf(files = CODE_FILES) {
  try {
    const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    let max = 0
    for (const f of files) {
      const m = fs.statSync(path.join(dir, f)).mtimeMs
      if (Number.isFinite(m) && m > max) max = m
    }
    return max || null
  } catch {
    return null
  }
}

/**
 * Host half. 两段式注入（规格 §5.3 / R6）：
 *  - 段1a/1b：只等 connection/webServer —— 先让 Client 能探测到我们（health 双挂载）；
 *  - 段2：四件套齐备后才挂数据路由；缺失 → 永不挂载 → Client 靠 health 点名降级。
 * 红线：只读原生数据；唯一写入目标是 $DSH_HOME/panorama/panorama.db。
 */
export function apply(ctx, config) {
  const cfg = {
    dataSource: config?.dataSource ?? 'auto',
    includeSubagents: config?.includeSubagents ?? false,
    summaryRowLimit: config?.summaryRowLimit ?? 50,
    // R3 主动触发：stale 阈值（天）与自检 schedule 的 cron/时区
    //  per-condition 覆盖（高于全局 proactiveThresholdDays）：任务类按天、工作区类按周月
    proactiveThresholdDays: Number.isFinite(config?.proactiveThresholdDays) ? config.proactiveThresholdDays : undefined,
    proactiveThresholds: (config?.proactiveThresholds && typeof config.proactiveThresholds === 'object')
      ? config.proactiveThresholds : {},
    proactiveCron: typeof config?.proactiveCron === 'string' ? config.proactiveCron : '0 9 * * *',
    proactiveTimezone: typeof config?.proactiveTimezone === 'string' ? config.proactiveTimezone : 'Asia/Shanghai',
    proactivePrompt: typeof config?.proactivePrompt === 'string' ? config.proactivePrompt : undefined,
    // R6 观察层对账阈值
    reconcileMinCoverage: Number.isFinite(config?.reconcileMinCoverage) ? config.reconcileMinCoverage : DEFAULT_MIN_COVERAGE,
    reconcileMaxAgeDays: Number.isFinite(config?.reconcileMaxAgeDays) ? config.reconcileMaxAgeDays : DEFAULT_MAX_AGE_DAYS,
  }
  const state = {
    db: null,
    dbTried: false,
    codeStamp: codeStampOf(),   // 本次 apply 时的代码版本戳（与请求时的 diskStamp 比对）
    search: 'unknown',      // unknown | ok | disabled | error | unavailable
    searchError: null,
    fetchRouteError: null,  // conn.fetch 注册异常（assertFetchRoute 要求 /api/ 前缀等）
    memoryBridge: 'pending',// R1 记忆桥注册状态：registered | disabled | skipped | error
    taskTool: 'pending',    // R2a 任务工具注册状态：registered | skipped | error
    auditTool: 'pending',   // R2b 审核工具注册状态：registered | hidden | skipped | error
    deliverTool: 'pending', // R2c 交付工具注册状态：registered | hidden | skipped | error
    signalsTool: 'pending', // R3 主动信号工具注册状态：registered | hidden | skipped | error
    watchTool: 'pending',   // R3 主动自检（schedule）工具注册状态：registered | hidden | skipped | error
    agentTools: 0,          // 逐 Agent 注册成功/已存在次数（保底通道）
    globalToolCount: null,  // 全局工具视图大小（诊断：null = schemas() 不可读）
    transport: 'none',      // connection-fetch（段2 挂上后）
  }
  const health = () => buildHealth(ctx, state, cfg)

  // ── 段1a：主传输 —— connection exact 路由（契约见 rpc-host.ts：path 必须是含 /api 的全路径，
  //    assertFetchRoute 对非 /api/ 前缀当场 throw）。
  //    ★ cordis 属性守卫（P4 实测）：行 inject 未声明的服务不能用 ctx.connection 属性访问，
  //      会抛 "cannot get property 'connection' without inject" —— 必须 ctx.get()。
  //    注册异常记入 state.fetchRouteError 供 health 可见。 ──
  ctx.inject(['connection'], () => {
    try {
      const conn = ctx.get('connection')
      if (!conn) throw new Error('connection service not resolvable')
      const dispose = conn.fetch.register({
        path: '/api/panorama/health',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const url = new URL(request.url)
          if (url.searchParams.get('probe') === 'search') await probeSearch(ctx, state)
          return jsonResponse(200, health())
        },
      })
      ctx.effect(async () => { await dispose() }, 'panorama: health (connection)')
      state.fetchRouteError = null   // 成功即清除（错误态曾是粘滞的）
    } catch (error) {
      state.fetchRouteError = String(error?.message ?? error)
      ctx.logger?.warn?.(`panorama: connection health route not registered: ${state.fetchRouteError}`)
    }
  })

  // ── 段1b：webServer 镜像（C2 字面合规；浏览器可达、桌面壳不可达；requestRejection 鉴权） ──
  ctx.inject(['webServer'], () => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/panorama/health',
      handler: async (req, res) => {
        try {
          const rejection = ctx.get('connection')?.requestRejection({ headers: req.headers })
          if (rejection) { res.writeHead(rejection); res.end(); return }   // 401 | 403
          const url = new URL(req.url ?? '/panorama/health', 'http://dsh.local')
          if (url.searchParams.get('probe') === 'search') await probeSearch(ctx, state)
          sendNodeJson(res, 200, health())
        } catch (error) {
          sendNodeJson(res, 500, { error: 'internal', message: String(error?.message ?? error) })
        }
      },
    })
    ctx.effect(() => dispose, 'panorama: health (webserver mirror)')
  })

  // ── 段2：四件套齐备后挂数据路由（缺失 → 永不挂载 → Client 显示点名横幅） ──
  ctx.inject(['webServer', 'workspaceRegistry', 'sessionPersistence', 'sessionQuery'], async (inner) => {
    state.dbTried = true
    try {
      state.db = openDatabase(dshHome())
    } catch (error) {
      inner.logger.warn(`panorama: derived db unavailable: ${String(error?.message ?? error)}`)
    }
    // dataSource 不在此锁存：控制器服务可能晚于本行激活（实测竞态）。
    // 展示与聚合都在使用时点现算（resolveMode 支持函数形式）。
    const dataSourceNow = () => cfg.dataSource !== 'strict'
      && inner.get('sessionController') && inner.get('workspaceController') ? 'native' : 'strict'
    const agg = createAggregator(inner, { dataSource: dataSourceNow, includeSubagents: cfg.includeSubagents }, state.db)
    const summaries = createSummaryService(inner, state.db, inner.logger, state)

    // ── R2a/R2b 工具：主 Agent（Router）直接操作任务状态层 + 门下省审核 ──
    // 直接注册（对齐 picgo：服务在行 inject 里 → ctx.tools 属性可用），不再用 ctx.inject(['tools'])。
    // 注册后立刻用 tools.schemas()（全局视图）自检：若我们的名字不在全局视图里，说明注册落在了
    // 某个非 global 的 scope 层 —— 这正是"注册成功但模型看不见"的判别点。
    state.taskTool = 'skipped'
    state.auditTool = 'skipped'
    state.deliverTool = 'skipped'
    state.signalsTool = 'skipped'
    state.watchTool = 'skipped'
    state.globalToolCount = null
    try {
      // ★ 正确写法：ctx.effect(() => register(...)) —— 立即注册，返回值（disposer）交给 Cordis 卸载时清理。
      //   写成 ctx.effect(() => { dispose() }) 会【注册即注销】（Cordis effect 立即执行 fn，
      //   只有返回值才是 disposer）—— 这正是 R2 工具"注册成功却看不见"、R1 记忆桥空转的根因。
      ctx.effect(() => ctx.tools.register(buildTaskTool(state.db)), 'panorama: task tool')
      ctx.effect(() => ctx.tools.register(buildAuditTool(state.db, ctx)), 'panorama: audit tool')
      ctx.effect(() => ctx.tools.register(buildDeliverTool(state.db, ctx)), 'panorama: deliver tool')
      ctx.effect(() => ctx.tools.register(buildSignalsTool(state.db, ctx, {
        thresholdDays: cfg.proactiveThresholdDays,
        thresholds: cfg.proactiveThresholds,
        minCoverage: cfg.reconcileMinCoverage,
        maxAgeDays: cfg.reconcileMaxAgeDays,
      })), 'panorama: signals tool')
      ctx.effect(() => ctx.tools.register(buildWatchTool(state.db, ctx, {
        watchCron: cfg.proactiveCron, watchTimezone: cfg.proactiveTimezone, watchPrompt: cfg.proactivePrompt,
      })), 'panorama: watch tool')
      // 诊断（消除假阳性）：分别报告"全局视图可读性"与"我们的名字在不在其中"。
      //   registered = 全局视图里确有我们的工具；hidden = 视图可读但没有；unknown = 读不到视图。
      let globalNames = []
      try {
        globalNames = (ctx.tools.schemas?.() ?? []).map((s) => s?.name).filter(Boolean)
      } catch { /* schemas 不可读 → unknown */ }
      state.globalToolCount = globalNames.length
      state.taskTool = globalNames.includes('panorama_task') ? 'registered'
        : (globalNames.length ? 'hidden' : 'unknown')
      state.auditTool = globalNames.includes('panorama_audit') ? 'registered'
        : (globalNames.length ? 'hidden' : 'unknown')
      state.deliverTool = globalNames.includes('panorama_deliver') ? 'registered'
        : (globalNames.length ? 'hidden' : 'unknown')
      state.signalsTool = globalNames.includes('panorama_signals') ? 'registered'
        : (globalNames.length ? 'hidden' : 'unknown')
      state.watchTool = globalNames.includes('panorama_watch') ? 'registered'
        : (globalNames.length ? 'hidden' : 'unknown')
    } catch (error) {
      state.taskTool = 'error'
      state.auditTool = 'error'
      state.deliverTool = 'error'
      state.signalsTool = 'error'
      state.watchTool = 'error'
      inner.logger.warn(`panorama: R2 tools not registered: ${String(error?.message ?? error)}`)
    }

    // 保底：逐 Agent 注册。scope 视图中"自身层"的注册永远可见且遮蔽全局同名，
    // 因此即使全局注册落到了非 global 层，Agent 侧仍稳定可见（Router 可操作任务层）。
    // 注意：ToolsService.register 用的是服务实例自身的 ctx（this.ctx）而非调用方 ctx，
    // 且服务可能被多个 ctx 共享 —— 重复注册会抛 "already registered"，这里按幂等成功处理。
    //
    // ★ 仅在全局视图里【看不到】本插件工具时才逐 Agent 注册：自身层注册遮蔽全局同名，
    //   而它的 effect 挂在 agent.ctx 上、插件热重载时不会被回收 —— 一旦全局已可见，
    //   逐 Agent 注册就是冗余的，还会把旧工具永久遮蔽住重载后的新工具
    //   （实测：修好 audit-tool.js 后审核仍走旧代码，根因即此）。
    const globalToolsVisible = () => {
      try {
        const names = (ctx.tools.schemas?.() ?? []).map((s) => s?.name)
        return names.includes('panorama_task') && names.includes('panorama_audit')
      } catch {
        return false
      }
    }
    state.agentTools = 0
    const onAgentCreated = ({ agent }) => {
      if (globalToolsVisible()) return
      try {
        const aCtx = agent.ctx
        if (!aCtx || typeof aCtx.tools?.register !== 'function') return
        for (const [label, build] of [
          ['panorama: task tool (agent scope)', () => buildTaskTool(state.db)],
          ['panorama: audit tool (agent scope)', () => buildAuditTool(state.db, aCtx)],
          ['panorama: deliver tool (agent scope)', () => buildDeliverTool(state.db, aCtx)],
          ['panorama: signals tool (agent scope)', () => buildSignalsTool(state.db, aCtx, {
            thresholdDays: cfg.proactiveThresholdDays, thresholds: cfg.proactiveThresholds,
            minCoverage: cfg.reconcileMinCoverage, maxAgeDays: cfg.reconcileMaxAgeDays,
          })],
          ['panorama: watch tool (agent scope)', () => buildWatchTool(state.db, aCtx, {
            watchCron: cfg.proactiveCron, watchTimezone: cfg.proactiveTimezone, watchPrompt: cfg.proactivePrompt,
          })],
        ]) {
          try {
            aCtx.effect(() => aCtx.tools.register(build()), label)
            state.agentTools += 1
          } catch (error) {
            if (!/already registered/i.test(String(error?.message ?? error))) throw error
            state.agentTools += 1   // 已存在 = 目标达成
          }
        }
      } catch (error) {
        inner.logger.warn(`panorama: per-agent tool registration failed: ${String(error?.message ?? error)}`)
      }
    }
    ctx.on('agent/created', onAgentCreated)
    ctx.effect(() => () => ctx.off('agent/created', onAgentCreated), 'panorama: agent tool listener')

    // ── R1 记忆桥：观察层 → 系统提示（连续·记忆）──
    // variable 每次 assemble 重新解析；section 置于 order 9500（环境后缀 10000+ 之前），
    // 内容变化只失效尾部小后缀，保住前缀 KV 缓存。systemPrompt 缺失则整体跳过（降级不阻断）。
    const sysPrompt = inner.get('systemPrompt')
    if (sysPrompt && cfg.memoryBridgeEnabled !== false) {
      const registry = inner.get('workspaceRegistry')
      let titleMap = new Map()
      const refreshTitles = () => {
        try {
          titleMap = new Map((registry ? registry.list() : []).map((w) => [w.id, w.title]))
        } catch { /* 标题解析失败 → 该段省略工作区名 */ }
      }
      refreshTitles()
      const bridge = createMemoryBridge(state.db, {
        windowDays: cfg.memoryBridgeWindowDays,
        titleOf: (id) => titleMap.get(id) ?? null,
      })
      try {
        // 同 R2：ctx.effect(() => register(...)) —— 立即注册 + 返回 disposer。
        // 旧写法 ctx.effect(() => { dispose() }) 会注册即注销，导致记忆桥一直空转。
        ctx.effect(() => sysPrompt.variable('panorama_memory', bridge.variable), 'panorama: memory variable')
        ctx.effect(() => sysPrompt.section({
          name: 'panorama:memory',
          order: 9500,
          text: '[工作记忆] {{panorama_memory}}',
        }), 'panorama: memory section')
        state.memoryBridge = 'registered'
      } catch (error) {
        state.memoryBridge = 'error'
        // 提示装配注册失败：记录但不阻断聚合面板
        inner.logger.warn(`panorama: memory bridge not registered: ${String(error?.message ?? error)}`)
      }
    } else {
      state.memoryBridge = sysPrompt ? 'disabled' : 'skipped'
    }

    // 共享分发：Fetch Request → Fetch Response（exact 路由直用；webServer 镜像经 node:http 适配）
    const dispatch = async (request) => {
      const url = new URL(request.url)
      const method = (request.method ?? 'GET').toUpperCase()
      const p = url.pathname.replace(/^\/api(?=\/panorama)/, '')   // /api/panorama/x → /panorama/x
      if (p === '/panorama/health') {
        if (url.searchParams.get('probe') === 'search') await probeSearch(inner, state)
        return jsonResponse(200, health())
      }
      // P2：snapshot 已实现；P3：summaries / summary / session；P4：export
      if (p === '/panorama/snapshot') {
        if (method !== 'GET' && method !== 'HEAD') return jsonResponse(405, { error: 'method-not-allowed' })
        try {
          const result = await agg({
            range: url.searchParams.get('range') ?? 'all',
            workspaces: url.searchParams.get('workspaces') ?? '',
            status: url.searchParams.get('status') ?? 'all',
            tags: url.searchParams.get('tags') ?? '',
          })
          return jsonResponse(200, result)
        } catch (error) {
          return jsonResponse(500, { error: 'snapshot-failed', message: String(error?.message ?? error) })
        }
      }
      if (p === '/panorama/summaries' || p === '/panorama/summary') {
        if (method !== 'GET' && method !== 'HEAD') return jsonResponse(405, { error: 'method-not-allowed' })
        try {
          let pairs = []
          if (p === '/panorama/summary') {
            const id = url.searchParams.get('id')
            const at = Number(url.searchParams.get('at'))
            pairs = id && Number.isFinite(at) ? [{ id, at }] : []
          } else {
            pairs = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map((token) => {
              const i = token.lastIndexOf(':')
              return { id: token.slice(0, i), at: Number(token.slice(i + 1)) }
            }).filter((x) => x.id && Number.isFinite(x.at))
          }
          pairs = pairs.slice(0, 20)   // 规格：≤20/次
          const titleMap = new Map()
          if (pairs.length) {
            try {
              const provider = inner.get('sessionQuery')
              const results = provider
                ? await provider.readTitleSnapshots(pairs.map((x) => x.id), AbortSignal.timeout(10_000))
                : []
              for (const item of results) {
                if (item.status === 'fulfilled' && item.value?.title) titleMap.set(item.sessionId, item.value.title.title)
              }
            } catch { /* 标题失败 → 无查询词 → 无摘要 */ }
          }
          const items = []
          for (const pair of pairs) {
            const result = await summaries(pair.id, titleMap.get(pair.id) ?? null, pair.at)
            items.push({
              sessionId: pair.id,
              snippet: result.snippet,
              snippetSource: result.source,
              error: result.error ?? null,
            })
          }
          return jsonResponse(200, { items })
        } catch (error) {
          return jsonResponse(500, { error: 'summaries-failed', message: String(error?.message ?? error) })
        }
      }
      if (p === '/panorama/session') {
        if (method !== 'POST') return jsonResponse(405, { error: 'method-not-allowed' })
        if (!state.db) return jsonResponse(503, { error: 'derived-db-unavailable' })
        let body
        try { body = JSON.parse(await request.text()) } catch { return jsonResponse(400, { error: 'invalid-json' }) }
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (!sessionId) return jsonResponse(400, { error: 'missing-sessionId' })
        try {
          if (body.op === 'open') {
            return jsonResponse(200, { ok: true, openCount: state.db.bumpOpenCount(sessionId) })
          }
          if (body.op === 'setTags') {
            if (!Array.isArray(body.tags)) return jsonResponse(400, { error: 'invalid-tags' })
            const tags = body.tags.filter((x) => typeof x === 'string').map((x) => x.slice(0, 48)).slice(0, 32)
            return jsonResponse(200, { ok: true, tags: state.db.setTags(sessionId, tags) })
          }
          if (body.op === 'setNote') {
            if (typeof body.note !== 'string') return jsonResponse(400, { error: 'invalid-note' })
            return jsonResponse(200, { ok: true, manualNote: state.db.setManualNote(sessionId, body.note.slice(0, 2000)) })
          }
          return jsonResponse(400, { error: 'unknown-op' })
        } catch (error) {
          // op 执行失败必须带 message 返回（曾被空 catch 静默吞掉 → open_count 全0 无从定位）
          inner.logger.warn(`panorama: session op ${String(body.op)} failed: ${String(error?.message ?? error)}`)
          return jsonResponse(500, { error: 'session-op-failed', op: String(body.op), message: String(error?.message ?? error) })
        }
      }
      if (p === '/panorama/tasks') {
        if (method !== 'GET' && method !== 'HEAD') return jsonResponse(405, { error: 'method-not-allowed' })
        if (!state.db) return jsonResponse(503, { error: 'derived-db-unavailable' })
        const status = url.searchParams.get('status')
        return jsonResponse(200, { items: state.db.listTasks(status && status !== 'all' ? status : null) })
      }
      if (p === '/panorama/reconcile') {
        if (method !== 'GET' && method !== 'HEAD') return jsonResponse(405, { error: 'method-not-allowed' })
        if (!state.db) return jsonResponse(503, { error: 'derived-db-unavailable' })
        const workspaces = []
        try {
          for (const w of inner.get('workspaceRegistry')?.list?.() ?? []) {
            workspaces.push({ id: w.id, title: w.title, sessionIds: w.sessionIds })
          }
        } catch { /* registry 不可用时按空集对账（覆盖=1，会在 health 里体现） */ }
        const result = computeReconciliation({
          workspaces,
          observations: state.db.listObservations(),
          now: Date.now(),
          minCoverage: cfg.reconcileMinCoverage,
          maxAgeDays: cfg.reconcileMaxAgeDays,
        })
        if (url.searchParams.get('record') === '1') {
          try { state.db.recordReconciliation(result) } catch { /* 记录失败不阻断 */ }
        }
        return jsonResponse(200, { ok: true, result })
      }
      if (p === '/panorama/reconcile/history') {
        if (method !== 'GET' && method !== 'HEAD') return jsonResponse(405, { error: 'method-not-allowed' })
        if (!state.db) return jsonResponse(503, { error: 'derived-db-unavailable' })
        return jsonResponse(200, { ok: true, items: state.db.listReconciliations(Number(url.searchParams.get('limit')) || 60) })
      }
      if (p === '/panorama/signals') {
        if (method !== 'GET' && method !== 'HEAD') return jsonResponse(405, { error: 'method-not-allowed' })
        if (!state.db) return jsonResponse(503, { error: 'derived-db-unavailable' })
        const thresholdDays = Number.isFinite(cfg.proactiveThresholdDays) ? cfg.proactiveThresholdDays : 3
        const now = Date.now()
        const activity = workspaceActivityFromObservations(state.db.listObservations(), now)
        const titles = new Map()
        try {
          for (const w of inner.get('workspaceRegistry')?.list?.() ?? []) titles.set(w.id, w.title)
        } catch { /* 无 registry 时省略标题 */ }
        const conditions = evaluateSignals(state.db.listTasks(), activity, {
          now, thresholdDays: cfg.proactiveThresholdDays, thresholds: cfg.proactiveThresholds, workspaceTitles: titles,
        })
        return jsonResponse(200, {
          ok: true,
          generatedAt: now,
          conditions,
          warnCount: conditions.filter((c) => c.severity === 'warn').reduce((s, c) => s + c.count, 0),
        })
      }
      if (p === '/panorama/task-chain') {
        if (method !== 'GET' && method !== 'HEAD') return jsonResponse(405, { error: 'method-not-allowed' })
        if (!state.db) return jsonResponse(503, { error: 'derived-db-unavailable' })
        const taskId = url.searchParams.get('taskId')
        if (!taskId) return jsonResponse(400, { error: 'missing-taskId' })
        const task = state.db.getTask(taskId)
        if (!task) return jsonResponse(404, { error: 'task-not-found' })
        return jsonResponse(200, { task, events: state.db.listTaskEvents(taskId) })
      }
      if (p === '/panorama/task') {
        if (method !== 'POST') return jsonResponse(405, { error: 'method-not-allowed' })
        if (!state.db) return jsonResponse(503, { error: 'derived-db-unavailable' })
        let body
        try { body = JSON.parse(await request.text()) } catch { return jsonResponse(400, { error: 'invalid-json' }) }
        try {
          if (body.op === 'create') {
            const task = state.db.createTask({
              taskId: body.taskId, title: body.title,
              acceptanceCriteria: body.acceptanceCriteria,
              ownerSessionIds: Array.isArray(body.ownerSessionIds) ? body.ownerSessionIds : [],
            })
            return jsonResponse(200, { ok: true, task })
          }
          if (body.op === 'setStatus') {
            const task = state.db.setTaskStatus(body.taskId, body.status)
            if (!task) return jsonResponse(404, { error: 'task-not-found' })
            return jsonResponse(200, { ok: true, task })
          }
          if (body.op === 'setVerdict') {
            const task = state.db.setTaskVerdict(body.taskId, {
              verdict: body.verdict, reason: body.reason, by: body.by,
            })
            if (!task) return jsonResponse(404, { error: 'task-not-found' })
            return jsonResponse(200, { ok: true, task })
          }
          if (body.op === 'linkSession') {
            const task = state.db.linkTaskSessions(body.taskId, Array.isArray(body.sessionIds) ? body.sessionIds : [])
            if (!task) return jsonResponse(404, { error: 'task-not-found' })
            return jsonResponse(200, { ok: true, task })
          }
          if (body.op === 'delete') {
            const deleted = state.db.deleteTask(body.taskId)
            if (!deleted) return jsonResponse(404, { error: 'task-not-found' })
            return jsonResponse(200, { ok: true, deleted: body.taskId })
          }
          return jsonResponse(400, { error: 'unknown-op' })
        } catch (error) {
          return jsonResponse(400, { error: 'task-op-failed', message: String(error?.message ?? error) })
        }
      }
      if (p === '/panorama/export') {
        if (method !== 'GET' && method !== 'HEAD') return jsonResponse(405, { error: 'method-not-allowed' })
        if (!state.db) return jsonResponse(503, { error: 'derived-db-unavailable' })
        try {
          const sinceRaw = url.searchParams.get('since')
          const since = sinceRaw ? Date.parse(sinceRaw) : 0
          return jsonResponse(200, state.db.readExportSignals(Number.isFinite(since) ? since : 0))
        } catch (error) {
          return jsonResponse(500, { error: 'export-failed', message: String(error?.message ?? error) })
        }
      }
      return jsonResponse(404, { error: 'not-found', path: p })
    }

    const conn = inner.get('connection')
    if (conn) {
      const routes = [
        ['GET', '/api/panorama/snapshot'],
        ['GET', '/api/panorama/summaries'],
        ['GET', '/api/panorama/summary'],
        ['GET', '/api/panorama/tasks'],
        ['GET', '/api/panorama/signals'],
        ['GET', '/api/panorama/reconcile'],
        ['GET', '/api/panorama/reconcile/history'],
        ['GET', '/api/panorama/task-chain'],
        ['GET', '/api/panorama/export'],
        ['POST', '/api/panorama/session'],
        ['POST', '/api/panorama/task'],
      ]
      try {
        const disposers = await Promise.all(routes.map(([method, routePath]) =>
          conn.fetch.register({ path: routePath, methods: [method], requestBody: 'buffered', fetch: dispatch })))
        state.transport = 'connection-fetch'
        state.fetchRouteError = null   // 成功即清除
        ctx.effect(async () => { await Promise.all(disposers.map((d) => d())) }, 'panorama: connection data routes')
      } catch (error) {
        state.fetchRouteError = String(error?.message ?? error)
        inner.logger.warn(`panorama: connection data routes not registered: ${state.fetchRouteError}`)
      }
    }

    const mirror = inner.webServer.register({
      kind: 'prefix',
      path: '/panorama',
      handler: async (req, res) => {
        try {
          const rejection = inner.get('connection')?.requestRejection({ headers: req.headers })
          if (rejection) { res.writeHead(rejection); res.end(); return }
          const response = await dispatch(await nodeToFetchRequest(req))
          await writeNodeResponse(res, response)
        } catch (error) {
          sendNodeJson(res, 500, { error: 'internal', message: String(error?.message ?? error) })
        }
      },
    })
    ctx.effect(() => mirror, 'panorama: webserver data mirror')
    // P3 可选：监听 session/event 为可见会话保鲜 updated_at（strict 模式），随 effect 释放
  })
}

/** 能力探测：每次面板打开最多一次（state.search 粘滞，防重试风暴）。 */
async function probeSearch(ctx, state) {
  if (state.search !== 'unknown') return
  const query = ctx.get('sessionQuery')
  if (!query || typeof query.searchSessions !== 'function') {
    state.search = 'unavailable'
    return
  }
  try {
    await query.searchSessions(
      {
        query: 'panorama probe',
        limit: 1,
        sessionFilters: [{ kind: 'id', values: ['__panorama_probe__'] }],
      },
      { signal: AbortSignal.timeout(8000) },
    )
    state.search = 'ok'
  } catch (error) {
    const code = error?.code
    state.search = code === 'SESSION_QUERY_SEARCH_DISABLED' ? 'disabled' : 'error'
    state.searchError = code ?? String(error?.message ?? error)
  }
}

/** 运行时版本：读 clientModules boot graph 的 release（与页面同源的真值，无需读文件）。 */
function runtimeVersionOf(ctx) {
  try {
    return ctx.get('clientModules')?.graph?.()?.release?.version ?? null
  } catch {
    return null
  }
}

function runtimeCommitOf(ctx) {
  try {
    return ctx.get('clientModules')?.graph?.()?.release?.commit ?? null
  } catch {
    return null
  }
}

function buildHealth(ctx, state, cfg) {
  const has = (name) => ctx.get(name) !== undefined
  // 按请求时点现算（服务激活顺序竞态下不能锁存）
  const dataSource = cfg.dataSource !== 'strict'
    && has('sessionController') && has('workspaceController') ? 'native' : 'strict'
  return {
    ok: true,
    phase: PHASE,
    services: {
      connection: has('connection'),
      webServer: has('webServer'),
      workspaceRegistry: has('workspaceRegistry'),
      sessionPersistence: has('sessionPersistence'),
      sessionQuery: has('sessionQuery'),
      sessionController: has('sessionController'),
      workspaceController: has('workspaceController'),
    },
    search: state.search,
    searchError: state.searchError,
    fetchRouteError: state.fetchRouteError,
    memoryBridge: state.memoryBridge ?? 'pending',
    taskTool: state.taskTool ?? 'pending',
    auditTool: state.auditTool ?? 'pending',
    deliverTool: state.deliverTool ?? 'pending',
    signalsTool: state.signalsTool ?? 'pending',
    watchTool: state.watchTool ?? 'pending',
    agentTools: state.agentTools ?? 0,      // 逐 Agent 注册成功/已存在次数（保底通道）
    globalToolCount: state.globalToolCount ?? null, // 全局工具视图大小（诊断：null=读不到）
    dataSource,
    db: state.dbTried ? (state.db ? 'ok' : 'error') : 'pending',
    transport: state.transport,
    peerVersion: PEER_DSH_VERSION,
    runtimeVersion: runtimeVersionOf(ctx),   // boot graph 的 release.version（clientModules.graph，实时真值）
    runtimeCommit: runtimeCommitOf(ctx),
    version: VERSION,
    // 代码版本戳：codeStamp = 本次 apply 时的文件 mtime；diskStamp = 请求时现读。
    // 两者不等 ⇒ 磁盘代码比运行中的 Host 新（改了没重启/没重载）。
    codeStamp: state.codeStamp ?? null,
    diskStamp: codeStampOf(),
    codeStale: state.codeStamp != null && codeStampOf() > state.codeStamp,
    config: {
      dataSource: cfg.dataSource,
      includeSubagents: cfg.includeSubagents,
      summaryRowLimit: cfg.summaryRowLimit,
    },
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function sendNodeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** node:http IncomingMessage → Fetch Request（镜像路由用；POST 缓冲 body ≤1MiB）。 */
async function nodeToFetchRequest(req) {
  const url = new URL(req.url ?? '/', 'http://dsh.local')
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value))
  }
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers })
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('payload too large')
    chunks.push(chunk)
  }
  return new Request(url, { method, headers, body: Buffer.concat(chunks) })
}

async function writeNodeResponse(res, response) {
  const headers = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  const buffer = Buffer.from(await response.arrayBuffer())
  res.writeHead(response.status, { ...headers, 'content-length': buffer.length })
  res.end(buffer)
}

function dshHome() {
  // ⚠️ 待复核（规格 §11-2）：若 @deepseek-ai/dsh-home-paths 导出官方解析，改用之
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}
