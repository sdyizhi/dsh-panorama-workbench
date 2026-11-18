window.__ModuleLoader__.load({
  id: 'dsh-panorama-workbench',            // 必须等于包名
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const PANEL_ID = 'panorama'             // ★ 与 sidebar.panellist 的 id、main 的 key 三者一致（C5）
    const NS = 'panorama'
    // 传输矩阵（P1 实测）：桌面壳的 /api exact 路由不可达，镜像两载体皆通 → 镜像优先，/api 兜底；
    // 成功过的基址粘滞复用，避免每次请求先吃一个404。
    const BASES = ['/panorama', '/api/panorama']
    let ACTIVE_BASE = null
    const REQUIRED_SERVICES = ['connection', 'webServer', 'workspaceRegistry', 'sessionPersistence', 'sessionQuery']   // 验收#5 drillAbsent 探针已撤（2026-11-07 演练通过）

    // 客户端文案（Client 半无法 import JSON，字典内联；locale/*.json 只承载 meta.title/description）
    const dicts = {
      zh: {
        title: '全景工作台',
        refresh: '刷新',
        probe: '探测搜索能力',
        probing: '探测中…',
        hostNotReady: '工作台宿主服务未就绪（传输不通或 Host 半未激活）',
        hostHint: '可运行 dsh --profile <name> --dump-config 检查 profile 组合',
        missingPrefix: '当前 profile 未启用：',
        retry: '重试',
        transport: '传输',
        version: '版本',
        peer: 'DSH peer',
        dataSource: '数据源',
        db: '派生库',
        search: '全文搜索',
        services: '服务',
        phaseNote: 'P2：跨工作区聚合统计与分组列表',
        range1d: '今天', range3d: '3 天', range7d: '7 天', range30d: '30 天', rangeAll: '不限',
        statusAll: '全部', statusRunning: '运行中', statusIdle: '空闲', statusArchived: '已归档',
        allWorkspaces: '全部工作区', ungrouped: '未分组',
        ovWorkspaces: '工作区', ovSessions: '总会话', ovVisible: '当前筛选', ovRunning: '运行中', ovActivity: '最近活动',
        tagPlaceholder: '标签筛选，逗号分隔，回车应用',
        loading: '加载中…', empty: '没有符合筛选的会话',
        untitled: '未命名会话',
        justNow: '刚刚', minAgo: '{n} 分钟前', hourAgo: '{n} 小时前', dayAgo: '{n} 天前',
        snippetEmpty: '暂无摘要', copyBtn: '复制', copied: '已复制',
        tagsBtn: '标签', noteBtn: '备注',
        tagsPlaceholder: '标签，逗号分隔', notePlaceholder: '手动摘要（优先于片段显示）',
        save: '保存', cancel: '取消',
        taskTitle: '任务', taskStatus: '状态', taskVerdict: '裁决', taskNew: '新建任务',
        taskNewPlaceholder: '任务标题，回车创建', taskEmpty: '暂无任务',
        taskAccepted: '通过', taskRejected: '封驳', taskNoVerdict: '未裁决',
        taskPass: 'pass', taskFail: 'fail',
        diagnostics: '诊断', attention: '需关注', collapseHint: '点击展开/收起',
        missingPrefix: '缺少必需服务：', stalePrefix: '磁盘代码已更新（', staleHint: '）——运行中的 Host 是旧版，请重启/重载',
        codeStamp: '代码戳', codeCurrent: '运行中=磁盘', codeStale: '磁盘更新（需重启/重载）',
        signalsTitle: '主动信号', signalsEmpty: '暂无信号', signalsWarnPrefix: '需关注：', signalsWarnSuffix: ' 条 warn',
        reconTitle: '观察层对账', reconHealthy: '健康', reconDegraded: '退化',
        reconWorkspace: '工作区覆盖', reconSession: '会话覆盖', reconBlind: '未观察',
        reconAge: '观察层年龄', reconDays: '天',
        expandAll: '展开全部', collapseAll: '收起全部', groupsLabel: '工作区分组',
        ledgerSkip: '跳过 subagent', ledgerBlank: '空白隐藏', ledgerArchived: '归档隐藏', ledgerRowLimit: '行上限', ledgerUnknown: '归档集未知',
        runtimePending: 'runtime 版本：探测中…',
        routeError: 'conn.fetch 路由未注册：',
        unknown: '未探测', ok: '可用', disabled: '已禁用', error: '出错', unavailable: '未挂载', pending: '初始化中',
      },
      en: {
        title: 'Panorama workbench',
        refresh: 'Refresh',
        probe: 'Probe search',
        probing: 'Probing…',
        hostNotReady: 'Workbench host services are not ready (transport down or Host half inactive)',
        hostHint: 'Run dsh --profile <name> --dump-config to inspect the profile composition',
        missingPrefix: 'Not enabled in this profile: ',
        retry: 'Retry',
        transport: 'Transport',
        version: 'Version',
        peer: 'DSH peer',
        dataSource: 'Data source',
        db: 'Derived db',
        search: 'Full-text search',
        services: 'Services',
        phaseNote: 'P2: cross-workspace stats and grouped sessions',
        range1d: 'Today', range3d: '3 days', range7d: '7 days', range30d: '30 days', rangeAll: 'All time',
        statusAll: 'All', statusRunning: 'Running', statusIdle: 'Idle', statusArchived: 'Archived',
        allWorkspaces: 'All workspaces', ungrouped: 'Ungrouped',
        ovWorkspaces: 'Workspaces', ovSessions: 'Sessions', ovVisible: 'In filter', ovRunning: 'Running', ovActivity: 'Last activity',
        tagPlaceholder: 'Filter by tags, comma-separated, Enter to apply',
        loading: 'Loading…', empty: 'No sessions match the filters',
        untitled: 'Untitled session',
        justNow: 'just now', minAgo: '{n}m ago', hourAgo: '{n}h ago', dayAgo: '{n}d ago',
        snippetEmpty: 'No summary', copyBtn: 'Copy', copied: 'Copied',
        tagsBtn: 'Tags', noteBtn: 'Note',
        tagsPlaceholder: 'Tags, comma-separated', notePlaceholder: 'Manual note (shown instead of snippet)',
        save: 'Save', cancel: 'Cancel',
        taskTitle: 'Task', taskStatus: 'Status', taskVerdict: 'Verdict', taskNew: 'New task',
        taskNewPlaceholder: 'Task title, Enter to create', taskEmpty: 'No tasks yet',
        taskAccepted: 'accepted', taskRejected: 'rejected', taskNoVerdict: 'no verdict',
        taskPass: 'pass', taskFail: 'fail',
        diagnostics: 'Diagnostics', attention: 'attention', collapseHint: 'click to expand/collapse',
        expandAll: 'Expand all', collapseAll: 'Collapse all', groupsLabel: 'Workspace groups',
        stalePrefix: 'disk code is newer (', staleHint: ') — the running Host is stale; restart/reload',
        codeStamp: 'code stamp', codeCurrent: 'running=disk', codeStale: 'disk newer (restart/reload)',
        signalsTitle: 'Proactive signals', signalsEmpty: 'no signals', signalsWarnPrefix: 'attention: ', signalsWarnSuffix: ' warn',
        reconTitle: 'Observation-layer reconciliation', reconHealthy: 'healthy', reconDegraded: 'degraded',
        reconWorkspace: 'workspace coverage', reconSession: 'session coverage', reconBlind: 'blind',
        reconAge: 'observation age', reconDays: 'd',
        ledgerSkip: 'skipped subagent', ledgerBlank: 'blank hidden', ledgerArchived: 'archived hidden', ledgerRowLimit: 'row cap', ledgerUnknown: 'archived set unknown',
        runtimePending: 'runtime version: probing…',
        routeError: 'conn.fetch route not registered: ',
        unknown: 'unknown', ok: 'ok', disabled: 'disabled', error: 'error', unavailable: 'not mounted', pending: 'initializing',
      },
    }

    /** 镜像优先 + 粘滞基址；404/网络失败回退下一站；传输通但服务出错 → 直接抛。 */
    async function apiGet(pathAndQuery) {
      const bases = ACTIVE_BASE ? [ACTIVE_BASE, ...BASES.filter((b) => b !== ACTIVE_BASE)] : BASES
      let lastError = null
      for (const base of bases) {
        let res
        try {
          res = await fetch(base + pathAndQuery, { headers: { accept: 'application/json' } })
        } catch (error) {
          lastError = error
          continue
        }
        if (res.status === 404) {
          lastError = new Error('404 at ' + base)
          continue
        }
        if (!res.ok) {
          // 把响应体带进错误：服务端 {error, message} 直接显示在红横幅上
          const body = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status}${body ? ' · ' + body.slice(0, 500) : ''}`)
        }
        ACTIVE_BASE = base
        return { data: await res.json(), transport: base }
      }
      throw lastError ?? new Error('no transport available')
    }

    /** POST 版本（open/标签/备注写操作）；基址策略与 apiGet 一致。 */
    async function apiPost(pathAndQuery, body) {
      const bases = ACTIVE_BASE ? [ACTIVE_BASE, ...BASES.filter((b) => b !== ACTIVE_BASE)] : BASES
      let lastError = null
      for (const base of bases) {
        let res
        try {
          res = await fetch(base + pathAndQuery, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
        } catch (error) {
          lastError = error
          continue
        }
        if (res.status === 404) {
          lastError = new Error('404 at ' + base)
          continue
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status}${text ? ' · ' + text.slice(0, 500) : ''}`)
        }
        ACTIVE_BASE = base
        return res.json()
      }
      throw lastError ?? new Error('no transport available')
    }

    /** 相对时间（单位词走 locale，{n} 占位由 translate 替换）。 */
    function relTime(ts, tr) {
      const diff = Date.now() - ts
      if (diff < 60000) return tr('justNow')
      if (diff < 3600000) return tr('minAgo', { n: Math.floor(diff / 60000) })
      if (diff < 86400000) return tr('hourAgo', { n: Math.floor(diff / 3600000) })
      return tr('dayAgo', { n: Math.floor(diff / 86400000) })
    }

    function truncate(text, max) {
      const s = String(text)
      return s.length > max ? s.slice(0, max) + '…' : s
    }

    // 主题令牌全部来自 --dsw-alias-*（无字面颜色；icon 用 currentColor 继承）
    const styles = {
      page: {
        // 中央区域（.centerCol overflow:hidden、.mainPanel 无 overflow）不会替内容滚动 ——
        // 根元素必须自己成为滚动容器：作为 .mainPanel 的 flex 子项填充并自滚动（P4 实测修复）。
        display: 'block', padding: '16px 20px 32px',
        flex: '1 1 auto', minHeight: 0, height: '100%',
        overflowY: 'auto', overflowX: 'hidden', boxSizing: 'border-box',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
        fontFamily: 'inherit',
      },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
      h1: { fontSize: 16, fontWeight: 600, lineHeight: '24px', margin: 0 },
      muted: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: '18px' },
      card: {
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8, padding: '12px 14px', marginTop: 12,
      },
      row: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '2px 8px',
        borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
      },
      dotOk: { width: 6, height: 6, borderRadius: 3, background: 'var(--dsw-alias-state-success-primary)', flex: 'none' },
      dotBad: { width: 6, height: 6, borderRadius: 3, background: 'var(--dsw-alias-state-error-primary)', flex: 'none' },
      bannerError: {
        marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
        border: '1px solid var(--dsw-alias-state-error-primary)', background: 'var(--dsw-alias-bg-layer-2)',
      },
      bannerWarn: {
        marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
        border: '1px solid var(--dsw-alias-state-warn-primary)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      btn: {
        fontSize: 12, padding: '4px 10px', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
      },
      btnSmall: {
        fontSize: 11, padding: '1px 8px', borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
      },
      panellistBtn: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, padding: 0, border: 'none', borderRadius: 6,
        background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
      },
      seg: { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
      segActive: { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontWeight: 600 },
      select: { fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
      input: { fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', width: 170 },
      ovRow: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' },
      ovCard: { flex: '1 1 110px', minWidth: 104, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '8px 10px', boxSizing: 'border-box' },
      ovValue: { fontSize: 18, fontWeight: 600, lineHeight: '24px' },
      groupCard: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, marginTop: 10, overflow: 'hidden' },
      groupHeader: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box', padding: '10px 14px', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', textAlign: 'left' },
      groupArrow: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, flex: 'none' },
      groupTitle: { flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      groupCount: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 999, padding: '1px 8px', border: '1px solid var(--dsw-alias-border-l1)', flex: 'none' },
      rowItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px 7px 30px', fontSize: 13, borderTop: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-primary)' },
      rowTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowTime: { marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', flex: 'none' },
      rowEmpty: { padding: '8px 14px 8px 30px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', borderTop: '1px solid var(--dsw-alias-border-l1)' },
      tagChip: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999, padding: '0 6px', flex: 'none' },
      dotRunning: { width: 6, height: 6, borderRadius: 3, background: 'var(--dsw-alias-state-success-primary)', flex: 'none' },
      dotIdle: { width: 6, height: 6, borderRadius: 3, background: 'var(--dsw-alias-state-idle-primary)', flex: 'none' },
      dotArchived: { width: 6, height: 6, borderRadius: 3, background: 'var(--dsw-alias-border-l2)', flex: 'none' },
      rowMain: { flex: 1, minWidth: 0 },
      rowTitleLine: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, overflow: 'hidden' },
      rowSnippet: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowActions: { display: 'flex', gap: 4, flex: 'none' },
      editorRow: { display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' },
      editorInput: { flex: 1, minWidth: 0, fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
    }

    function Chip({ ok, children }) {
      return h('span', { style: styles.chip },
        h('span', { style: ok ? styles.dotOk : styles.dotBad }),
        h('span', null, children))
    }

    return {
      inject: ['slots', 'locale', 'layout', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dicts), 'panorama: locale')
        const t = ctx.locale.bind(NS)

        // 侧边栏入口行：原创三联窗图标；点击显式选中面板（壳层若按 id 自动选中则无害）
        function PanellistRow() {
          const select = () => ctx.layout.selectPanel(PANEL_ID)
          return h('div', {
            role: 'button',
            tabIndex: 0,
            'aria-label': t('title'),
            title: t('title'),
            onClick: select,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select() }
            },
            style: styles.panellistBtn,
          },
          h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true', focusable: 'false' },
            h('rect', { x: 3.25, y: 5.25, width: 17.5, height: 13.5, rx: 2.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }),
            h('path', { d: 'M9 5.25v13.5M15 5.25v13.5', stroke: 'currentColor', 'stroke-width': 1.5 }),
            h('circle', { cx: 12, cy: 12, r: 1.75, fill: 'currentColor' })))
        }

        // 主面板（P2）：health 卡 + 过滤工具栏 + 概览卡 + 工作区分组列表
        function PanoramaPanel() {
          const [health, setHealth] = useState(null)
          const [error, setError] = useState(null)
          const [snap, setSnap] = useState(null)
          const [busy, setBusy] = useState(false)
          const [probing, setProbing] = useState(false)
          const [range, setRange] = useState('7d')
          const [status, setStatus] = useState('all')
          const [ws, setWs] = useState('')
          const [tagInput, setTagInput] = useState('')
          const [tags, setTags] = useState('')
          const [expanded, setExpanded] = useState({})
          const [snippets, setSnippets] = useState({})      // sessionId → { snippet, snippetSource }
          const [attempted, setAttempted] = useState({})    // 'id:updatedAt' → 已请求
          const [editing, setEditing] = useState(null)      // { sessionId, kind: 'tags'|'note' }
          const [draft, setDraft] = useState('')
          const [copiedId, setCopiedId] = useState(null)
          const [tasks, setTasks] = useState([])
          const [taskDraft, setTaskDraft] = useState('')
          const [signals, setSignals] = useState(null)
          const [recon, setRecon] = useState(null)
          const [healthOpen, setHealthOpen] = useState(false)

          const load = useCallback(async (probeSearchCapability) => {
            setError(null)
            setBusy(true)
            if (probeSearchCapability) setProbing(true)
            try {
              const hres = await apiGet(probeSearchCapability ? '/health?probe=search' : '/health')
              setHealth(hres.data)
              const params = new URLSearchParams({ range, status })
              if (ws) params.set('workspaces', ws)
              if (tags) params.set('tags', tags)
              const sres = await apiGet('/snapshot?' + params.toString())
              setSnap(sres.data)
              // R1.5 任务列表（失败不阻断主面板）
              try {
                const tres = await apiGet('/tasks')
                setTasks(tres.data.items ?? [])
              } catch { /* 任务视图降级为空 */ }
              // R3 主动信号（失败不阻断主面板）
              try {
                const sig = await apiGet('/signals')
                setSignals(sig.data)
              } catch { /* 信号视图降级为空 */ }
              // R6 观察层对账（失败不阻断主面板）
              try {
                const rc = await apiGet('/reconcile?record=1')
                setRecon(rc.data.result)
              } catch { /* 对账视图降级为空 */ }
            } catch (e) {
              console.error('panorama: load failed', e)   // 面板即使被框架打空，控制台也留完整错误
              setHealth(null)
              setSnap(null)
              setError(String(e?.message ?? e))
            } finally {
              setBusy(false)
              setProbing(false)
            }
          }, [range, status, ws, tags])

          useEffect(() => { load(false) }, [load])

          // 摘要补齐：快照缺 snippet 的行分批（≤20/次、串行）向 /panorama/summaries 要，
          // 以 id:updatedAt 为尝试键（活动变化后自动重试）。
          useEffect(() => {
            if (!snap) return
            const pending = []
            const collect = (rows) => {
              for (const r of rows) {
                const key = `${r.sessionId}:${r.updatedAt}`
                if (!r.snippet && !attempted[key]) pending.push({ row: r, key })
              }
            }
            for (const g of snap.groups) collect(g.sessions)
            collect(snap.ungrouped ? snap.ungrouped.sessions : [])
            if (!pending.length) return
            let cancelled = false
            const run = async () => {
              for (let i = 0; i < Math.min(pending.length, 60); i += 20) {
                const chunk = pending.slice(i, i + 20)
                const ids = chunk.map((x) => `${x.row.sessionId}:${x.row.updatedAt}`).join(',')
                try {
                  const res = await apiGet('/summaries?ids=' + encodeURIComponent(ids))
                  if (cancelled) return
                  setSnippets((prev) => {
                    const next = { ...prev }
                    for (const item of res.data.items) next[item.sessionId] = item
                    return next
                  })
                  setAttempted((prev) => {
                    const next = { ...prev }
                    for (const x of chunk) next[x.key] = true
                    return next
                  })
                } catch (e) {
                  console.error('panorama: summaries batch failed', e)
                  break
                }
              }
            }
            run()
            return () => { cancelled = true }
          }, [snap])

          const openRow = async (row) => {
            try {
              await apiPost('/session', { op: 'open', sessionId: row.sessionId })
            } catch (e) {
              console.error('panorama: open bump failed', e)   // 不再静默：失败必须可见
            }
            ctx.uiWorkspace.openSession(row.sessionId)
          }
          const copyRef = async (row) => {
            try {
              await navigator.clipboard.writeText('dsh://session/' + row.sessionId)
              setCopiedId(row.sessionId)
              setTimeout(() => setCopiedId(null), 1500)
            } catch { /* 剪贴板不可用 */ }
          }
          const startEdit = (row, kind) => {
            setEditing({ sessionId: row.sessionId, kind })
            setDraft(kind === 'tags' ? (row.tags || []).join(', ') : (row.manualNote ?? ''))
          }
          const submitEdit = async () => {
            if (!editing) return
            const op = editing.kind === 'tags' ? 'setTags' : 'setNote'
            const payload = op === 'setTags'
              ? { tags: draft.split(',').map((s) => s.trim()).filter(Boolean) }
              : { note: draft }
            try {
              await apiPost('/session', { op, sessionId: editing.sessionId, ...payload })
              setEditing(null)
              await load(false)
            } catch (e) {
              console.error('panorama: edit failed', e)
            }
          }
          const createTask = async () => {
            const title = taskDraft.trim()
            if (!title) return
            try {
              await apiPost('/task', { op: 'create', taskId: 'task-' + Date.now().toString(36), title })
              setTaskDraft('')
              const tres = await apiGet('/tasks')
              setTasks(tres.data.items ?? [])
            } catch (e) {
              console.error('panorama: create task failed', e)
            }
          }

          const missing = health
            ? REQUIRED_SERVICES.filter((name) => health.services?.[name] === false)
            : []
          // 诊断卡是否需要提请展开：任何 error / warn / 缺失服务 / 版本不一致
          const healthHasProblem = Boolean(
            error
            || missing.length
            || (health && (
              health.db !== 'ok'
              || health.search === 'disabled' || health.search === 'error'
              || health.fetchRouteError
              || (health.runtimeVersion !== null && health.runtimeVersion !== health.peerVersion)
            )),
          )
          useEffect(() => { if (healthHasProblem) setHealthOpen(true) }, [healthHasProblem])
          const ov = snap ? snap.overview : null
          const groups = snap ? snap.groups : []
          const rangeOptions = [['1d', t('range1d')], ['3d', t('range3d')], ['7d', t('range7d')], ['30d', t('range30d')], ['all', t('rangeAll')]]
          const statusOptions = [['all', t('statusAll')], ['running', t('statusRunning')], ['idle', t('statusIdle')], ['archived', t('statusArchived')]]

          const ovCard = (label, value) => h('div', { style: styles.ovCard },
            h('div', { style: styles.ovValue }, String(value)),
            h('div', { style: styles.muted }, label))

          const renderRow = (row) => {
            const sum = snippets[row.sessionId]
            const snippet = row.manualNote || (sum && sum.snippet) || row.snippet
            const isEditing = editing && editing.sessionId === row.sessionId
            return h('div', {
              key: row.sessionId, style: styles.rowItem, role: 'button', tabIndex: 0,
              onClick: () => openRow(row),
              onKeyDown: (e) => { if (e.key === 'Enter') openRow(row) },
            },
            h('span', {
              style: row.status === 'running' ? styles.dotRunning
                : row.status === 'archived' ? styles.dotArchived : styles.dotIdle,
            }),
            h('div', { style: styles.rowMain },
              h('div', { style: styles.rowTitleLine },
                h('span', { style: styles.rowTitle }, row.title ?? t('untitled')),
                row.tags && row.tags.length
                  ? h('span', { style: styles.tagChip }, row.tags.join(' · '))
                  : null),
              h('div', { style: styles.rowSnippet },
                snippet ? truncate(snippet, 200) : t('snippetEmpty')),
              isEditing
                ? h('div', {
                  style: styles.editorRow,
                  onClick: (e) => e.stopPropagation(),
                  onKeyDown: (e) => e.stopPropagation(),
                },
                h('input', {
                  style: styles.editorInput, value: draft, autoFocus: true,
                  placeholder: editing.kind === 'tags' ? t('tagsPlaceholder') : t('notePlaceholder'),
                  onChange: (e) => setDraft(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') submitEdit()
                    if (e.key === 'Escape') setEditing(null)
                  },
                }),
                h('button', { type: 'button', style: styles.btnSmall, onClick: submitEdit }, t('save')),
                h('button', { type: 'button', style: styles.btnSmall, onClick: () => setEditing(null) }, t('cancel')))
                : null),
            h('span', { style: styles.rowActions, onClick: (e) => e.stopPropagation() },
              h('button', { type: 'button', style: styles.btnSmall, onClick: () => startEdit(row, 'tags') }, t('tagsBtn')),
              h('button', { type: 'button', style: styles.btnSmall, onClick: () => startEdit(row, 'note') }, t('noteBtn')),
              h('button', { type: 'button', style: styles.btnSmall, onClick: () => copyRef(row) },
                copiedId === row.sessionId ? t('copied') : t('copyBtn'))),
            h('span', { style: styles.rowTime }, row.updatedAt ? relTime(row.updatedAt, t) : '—'))
          }

          const renderGroup = (group) => {
            const key = group.workspaceId ?? '__ungrouped__'
            const isOpen = !!expanded[key]   // 默认折叠（空间收纳）：仅展开集合内的组
            return h('div', { key, style: styles.groupCard },
              h('button', {
                type: 'button', style: styles.groupHeader, 'aria-expanded': isOpen,
                onClick: () => setExpanded((prev) => ({ ...prev, [key]: !prev[key] })),
              },
              h('span', { style: styles.groupArrow, 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'),
              h('span', { style: styles.groupTitle },
                group.workspaceId === null ? t('ungrouped') : group.title),
              h('span', { style: styles.groupCount }, String(group.count))),
              isOpen && group.sessions.length === 0
                ? h('div', { style: styles.rowEmpty }, t('empty'))
                : null,
              isOpen ? group.sessions.map(renderRow) : null)
          }

          const ungroupedGroup = snap && snap.ungrouped && snap.ungrouped.count > 0
            ? { workspaceId: null, title: t('ungrouped'), count: snap.ungrouped.count, sessions: snap.ungrouped.sessions }
            : null

          return h('div', { style: styles.page },
            h('div', { style: styles.header },
              h('div', null,
                h('div', { style: styles.h1 }, t('title')),
                h('div', { style: styles.muted }, t('phaseNote'))),
              h('button', { type: 'button', style: styles.btn, onClick: () => load(false) }, t('refresh'))),

            error
              ? h('div', { style: styles.bannerError },
                h('div', null, t('hostNotReady')),
                h('div', { style: styles.muted, marginTop: 4 }, error + ' · ' + t('hostHint')),
                h('button', { type: 'button', style: styles.btn, onClick: () => load(false) }, t('retry')))
              : null,

            health
              ? h('div', { style: styles.card },
                // 可折叠诊断头：默认折叠；有错误/告警时自动展开（healthOpen 由副作用驱动）
                h('div', { style: styles.groupHeader, onClick: () => setHealthOpen((v) => !v) },
                  h('span', { style: styles.groupArrow, 'aria-hidden': 'true' }, healthOpen ? '▾' : '▸'),
                  h('span', { style: styles.groupTitle }, t('diagnostics')),
                  healthHasProblem
                    ? h('span', { style: { ...styles.tagChip, color: 'var(--dsw-alias-state-warn-primary)', borderColor: 'var(--dsw-alias-state-warn-primary)' } }, t('attention'))
                    : null,
                  h('span', { style: styles.groupCount }, t('collapseHint'))),
                healthOpen
                  ? h('div', { style: { marginTop: 8 } },
                    h('div', { style: styles.row },
                      h(Chip, { ok: Boolean(ACTIVE_BASE || health.transport) },
                        `${t('transport')}: ${ACTIVE_BASE ?? health.transport}`),
                      h(Chip, { ok: health.db === 'ok' }, `${t('db')}: ${t(health.db)}`),
                      h(Chip, { ok: health.dataSource === 'native' }, `${t('dataSource')}: ${health.dataSource}`),
                      h(Chip, { ok: health.search === 'ok' }, `${t('search')}: ${t(health.search)}`),
                      h(Chip, { ok: health.memoryBridge === 'registered' }, `R1 记忆桥: ${health.memoryBridge}`),
                      h(Chip, { ok: health.taskTool === 'registered' }, `R2a 任务工具: ${health.taskTool}`),
                      h(Chip, { ok: health.auditTool === 'registered' }, `R2b 审核工具: ${health.auditTool}`),
                      h(Chip, { ok: health.deliverTool === 'registered' }, `R2c 交付工具: ${health.deliverTool}`),
                      h(Chip, { ok: health.signalsTool === 'registered' }, `R3 信号工具: ${health.signalsTool}`),
                      h(Chip, { ok: health.watchTool === 'registered' }, `R3 自检工具: ${health.watchTool}`),
                      h(Chip, { ok: !health.codeStale }, `${t('codeStamp')}: ${health.codeStale ? t('codeStale') : t('codeCurrent')}`),
                      h(Chip, { ok: (health.agentTools ?? 0) > 0 }, `逐Agent注册: ${health.agentTools ?? 0}`),
                      h(Chip, { ok: health.taskTool === 'registered' },
                        `全局视图: ${health.globalToolCount === null ? '读不到' : health.globalToolCount + ' 个工具'}`),
                      health.taskTool === 'hidden'
                        ? h('div', { style: { ...styles.muted, marginTop: 2, color: 'var(--dsw-alias-state-error-primary)' } },
                          '工具已注册但不在全局工具视图（scope 层问题），模型不可见')
                        : null,
                      health.search === 'unknown'
                        ? h('button', {
                          type: 'button', style: styles.btnSmall, disabled: probing,
                          onClick: () => load(true),
                        }, probing ? t('probing') : t('probe'))
                        : null),
                    h('div', { style: { ...styles.muted, marginTop: 8 } },
                      `${t('version')} ${health.version} · ${t('peer')} ${health.peerVersion} · ${t('services')}: ` +
                      Object.entries(health.services).map(([name, ok]) => `${name}=${ok ? '✓' : '✗'}`).join('  ')),
                    health.fetchRouteError
                      ? h('div', { style: { ...styles.muted, marginTop: 2, color: 'var(--dsw-alias-state-warn-primary)' } },
                        `${t('routeError')}${health.fetchRouteError}`)
                      : null,
                    health.runtimeVersion === null
                      ? h('div', { style: styles.muted, marginTop: 2 }, t('runtimePending'))
                      : h('div', {
                        style: {
                          ...styles.muted, marginTop: 2,
                          color: health.runtimeVersion !== health.peerVersion
                            ? 'var(--dsw-alias-state-warn-primary)' : undefined,
                        },
                      },
                      `runtime ${health.runtimeVersion}${health.runtimeCommit ? '-' + String(health.runtimeCommit).slice(0, 7) : ''}` +
                      (health.runtimeVersion !== health.peerVersion
                        ? ` ≠ peer ${health.peerVersion}（桌面版更新后请复核 peer）`
                        : ' ✓')))
                  : null)
              : null,

            missing.length
              ? h('div', { style: styles.bannerWarn }, t('missingPrefix') + missing.join(', '))
              : null,

            // 代码版本戳：磁盘代码比运行中的 Host 新 ⇒ 改了没重启/没重载
            health && health.codeStale
              ? h('div', { style: styles.bannerWarn },
                `${t('stalePrefix')}${new Date(health.diskStamp).toLocaleString('sv-SE')} · ${t('staleHint')}`)
              : null,

            // 工具栏 + 概览
            h('div', { style: styles.card },
              h('div', { style: styles.row },
                rangeOptions.map(([v, label]) => h('button', {
                  key: v, type: 'button', style: range === v ? styles.segActive : styles.seg,
                  onClick: () => setRange(v),
                }, label)),
                h('select', { style: styles.select, value: status, onChange: (e) => setStatus(e.target.value) },
                  statusOptions.map(([v, label]) => h('option', { key: v, value: v }, label))),
                h('select', { style: styles.select, value: ws, onChange: (e) => setWs(e.target.value) },
                  [h('option', { key: '__all', value: '' }, t('allWorkspaces'))]
                    .concat(groups.filter((g) => g.workspaceId !== null)
                      .map((g) => h('option', { key: g.workspaceId, value: g.workspaceId }, g.title)))
                    .concat([h('option', { key: '__ug', value: 'ungrouped' }, t('ungrouped'))])),
                h('input', {
                  style: styles.input, value: tagInput, placeholder: t('tagPlaceholder'),
                  onChange: (e) => setTagInput(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') setTags(tagInput.trim()) },
                })),
              ov
                ? h('div', { style: styles.ovRow },
                  ovCard(t('ovWorkspaces'), ov.workspaceCount),
                  ovCard(t('ovSessions'), ov.sessionCount),
                  ovCard(t('ovVisible'), ov.visibleCount),
                  ovCard(t('ovRunning'), ov.runningCount),
                  ovCard(t('ovActivity'), ov.lastActivityAt ? relTime(ov.lastActivityAt, t) : '—'))
                : null,
              // 对账台账（验收#6）：与原生侧栏比对时的差异解释数字
              snap && ov
                ? h('div', { style: { ...styles.muted, marginTop: 6 } },
                  `${t('ledgerSkip')}: ${ov.skippedSubagents} · ${t('ledgerBlank')}: ${ov.blankHidden ?? 0} · ${t('ledgerArchived')}: ${ov.archivedHidden}` +
                  ` · ${t('ledgerRowLimit')}: ${snap.capabilities ? snap.capabilities.rowLimit : '—'}` +
                  (snap.capabilities && snap.capabilities.archivedUnknown ? ` · ${t('ledgerUnknown')}` : ''))
                : null,
              busy
                ? h('div', { style: { ...styles.muted, marginTop: 6 } }, t('loading'))
                : null,
              snap && ov && ov.visibleCount === 0 && !busy
                ? h('div', { style: { ...styles.muted, marginTop: 6 } }, t('empty'))
                : null),

            // R6 观察层对账（覆盖 + 新鲜度；每次打开面板都会记录一次，形成趋势）
            recon
              ? h('div', { style: { ...styles.groupCard, marginTop: 8 } },
                h('div', { style: styles.groupHeader },
                  h('span', { style: styles.groupTitle }, t('reconTitle')),
                  h('span', {
                    style: {
                      ...styles.tagChip,
                      color: recon.healthy ? 'var(--dsw-alias-state-success-primary)'
                        : 'var(--dsw-alias-state-warn-primary)',
                    },
                  }, recon.healthy ? t('reconHealthy') : t('reconDegraded'))),
                h('div', { style: { ...styles.muted, padding: '6px 14px' } },
                  `${t('reconWorkspace')}: ${(recon.workspaceCoverage * 100).toFixed(1)}% (${recon.workspaces.blind} ${t('reconBlind')}) · `
                  + `${t('reconSession')}: ${(recon.sessionCoverage * 100).toFixed(1)}% (${recon.sessions.blind}) · `
                  + `${t('reconAge')}: ${recon.ageDays === null ? '—' : recon.ageDays + ' ' + t('reconDays')}`))
              : null,

            // R3 主动信号（该被主动提起但没人问的事）
            h('div', { style: styles.groupCard },
              h('div', { style: styles.groupHeader },
                h('span', { style: styles.groupTitle }, t('signalsTitle')),
                h('span', { style: styles.groupCount },
                  signals ? String((signals.conditions ?? []).reduce((s, c) => s + c.count, 0)) : '—')),
              !signals
                ? h('div', { style: styles.rowEmpty }, t('signalsEmpty'))
                : (signals.conditions ?? []).map((c) => h('div', {
                  key: c.id,
                  style: { ...styles.rowItem, paddingLeft: 14, cursor: 'default' },
                  onClick: undefined, onKeyDown: undefined, role: undefined,
                },
                  h('span', { style: styles.rowTitle }, c.title),
                  h('span', {
                    style: {
                      ...styles.tagChip,
                      color: c.severity === 'warn' ? 'var(--dsw-alias-state-warn-primary)'
                        : 'var(--dsw-alias-label-secondary)',
                    },
                  }, `${c.severity} · ${c.count}`),
                  h('span', { style: styles.rowTime },
                    c.items.length ? (c.items[0].title ?? c.items[0].taskId ?? c.items[0].workspaceId ?? '') : '')),
                  ),
              signals && signals.warnCount > 0
                ? h('div', { style: { ...styles.muted, padding: '6px 14px', color: 'var(--dsw-alias-state-warn-primary)' } },
                  `${t('signalsWarnPrefix')}${signals.warnCount}${t('signalsWarnSuffix')}`)
                : null),

            // R1.5 任务状态链（连续·记忆的结构化补强）—— 置于会话列表之前，首屏可达
            h('div', { style: styles.groupCard },
              h('div', { style: styles.groupHeader },
                h('span', { style: styles.groupTitle }, t('taskTitle')),
                h('span', { style: styles.groupCount }, String(tasks.length))),
              h('div', { style: { ...styles.editorRow, padding: '8px 14px', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
                h('input', {
                  style: styles.editorInput, value: taskDraft, placeholder: t('taskNewPlaceholder'),
                  onChange: (e) => setTaskDraft(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') createTask() },
                }),
                h('button', { type: 'button', style: styles.btnSmall, onClick: createTask }, t('taskNew'))),
              tasks.length === 0
                ? h('div', { style: styles.rowEmpty }, t('taskEmpty'))
                : tasks.slice(0, 30).map((task) => h('div', {
                  key: task.task_id, style: { ...styles.rowItem, paddingLeft: 14, cursor: 'default' },
                  onClick: undefined, onKeyDown: undefined, role: undefined,
                },
                  h('span', { style: styles.rowTitle }, task.title),
                  h('span', { style: styles.tagChip }, `${t('taskStatus')}: ${task.status}`),
                  h('span', {
                    style: {
                      ...styles.tagChip,
                      color: task.verdict === 'pass' ? 'var(--dsw-alias-state-success-primary)'
                        : task.verdict === 'fail' ? 'var(--dsw-alias-state-error-primary)'
                          : 'var(--dsw-alias-label-secondary)',
                    },
                  }, `${t('taskVerdict')}: ${task.verdict ?? t('taskNoVerdict')}`),
                  h('span', { style: styles.rowTime }, task.updated_at ? relTime(task.updated_at, t) : '—')))),

            // 分组列表（registry 顺序；默认折叠，未分组殿后）
            h('div', { style: { ...styles.row, alignItems: 'center', marginTop: 12 } },
              h('span', { style: { ...styles.muted, flex: 1 } },
                `${t('groupsLabel')} (${groups.length}${ungroupedGroup ? ' + 1' : ''})`),
              h('button', {
                type: 'button', style: styles.btnSmall,
                onClick: () => setExpanded(Object.fromEntries(
                  groups.map((g) => [g.workspaceId ?? '__ungrouped__', true])
                    .concat(ungroupedGroup ? [['__ungrouped__', true]] : []),
                )),
              }, t('expandAll')),
              h('button', { type: 'button', style: styles.btnSmall, onClick: () => setExpanded({}) }, t('collapseAll'))),
            groups.map(renderGroup),
            ungroupedGroup ? renderGroup(ungroupedGroup) : null)
        }

        // 渲染错误边界：真实 React 下的渲染异常不再让槽位整体空白（practices 警告过的坑），
        // 错误文本直接显示在面板上并打印到控制台。
        class MainBoundary extends React.Component {
          constructor(props) {
            super(props)
            this.state = { error: null }
          }
          static getDerivedStateFromError(error) { return { error } }
          componentDidCatch(error, info) {
            console.error('panorama: panel render crashed', error, info)
          }
          render() {
            const err = this.state.error
            if (err) {
              return h('div', { style: styles.bannerError },
                h('div', null, '面板渲染出错 / Panel render error'),
                h('div', {
                  style: { ...styles.muted, marginTop: 6, wordBreak: 'break-all', whiteSpace: 'pre-wrap' },
                }, String((err && err.stack) || err)))
            }
            return h(PanoramaPanel)
          }
        }

        // ★ 只注册这两个增量槽位；slots.inject 等待属主声明（dsh.client.inject 只是加载提示）
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: () => t('title') }, PanellistRow)),
        'panorama: panellist entry')

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID }, MainBoundary)),
        'panorama: main panel')
      },
    }
  },
})
