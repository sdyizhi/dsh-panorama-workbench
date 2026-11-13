/**
 * 记忆桥（Super-agent R1：连续·记忆）：把 panorama 观察层聚合成一段有界的
 * 系统提示文本，经 ctx.systemPrompt.variable 在每次 assemble 时重新解析。
 *
 * 约束（system-prompt 契约实测）：
 *  - variable 必须恒返回字符串，返回 null/undefined 会让 assemble 抛错；
 *  - 文本内不得出现 {{ 或 }}（无内联转义语法）；
 *  - 数据只读 panorama.db（唯一写入目标仍是该库，原生存储零触碰）。
 */

const WINDOW_DAYS_DEFAULT = 7
const MAX_WORKSPACES = 6
const MAX_TAGS = 5
const MAX_NOTES = 3
const MAX_HOURS = 3
const NOTE_MAX_CHARS = 40
const CACHE_TTL_MS = 60_000

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 一天的分桶键（本地时区）。 */
function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 一小时的分桶键（本地时区）。 */
function hourKey(ts) {
  const d = new Date(ts)
  return `${pad2(d.getHours())}时`
}

/**
 * 纯函数：观察行 → 有界摘要文本（离线可测）。
 * @param rows 观察行：{ updatedAt, createdAt, workspaceTitle, openCount, tags, manualNote }
 * @param opts { windowDays }
 * @returns 摘要文本（恒为非空字符串）
 */
export function buildDigest(rows, opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : WINDOW_DAYS_DEFAULT
  const cutoff = Date.now() - windowDays * 86_400_000
  const inWindow = (rows || []).filter((r) => Number.isFinite(r.updatedAt) && r.updatedAt >= cutoff)

  if (!inWindow.length) {
    return `[工作记忆 · 最近${windowDays}天] 暂无可用观察数据（打开全景工作台即可开始积累；此段由 dsh-panorama-workbench 只读生成）`
  }

  // 工作区热度：窗口内按会话活动次数（去重会话计 1 次/天）
  const wsCount = new Map()
  const wsSessions = new Map()
  for (const r of inWindow) {
    if (!r.workspaceTitle) continue
    const key = `${r.workspaceTitle}|${dayKey(r.updatedAt)}`
    if (!wsSessions.has(key)) {
      wsSessions.set(key, true)
      wsCount.set(r.workspaceTitle, (wsCount.get(r.workspaceTitle) ?? 0) + 1)
    }
  }
  const topWorkspaces = [...wsCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_WORKSPACES)
    .map(([title, n]) => `${title}(${n})`)
    .join(' ')

  const activeWorkspaces = new Set(inWindow.map((r) => r.workspaceTitle).filter(Boolean)).size
  const reused = [...new Set(inWindow.filter((r) => r.openCount >= 2).map((r) => r.sessionId))].length

  const tags = [...new Set(inWindow.flatMap((r) => r.tags || []))].slice(0, MAX_TAGS)
  const notes = inWindow
    .map((r) => r.manualNote)
    .filter(Boolean)
    .slice(0, MAX_NOTES)
    .map((n) => (String(n).length > NOTE_MAX_CHARS ? String(n).slice(0, NOTE_MAX_CHARS) + '…' : String(n)))

  const hours = new Map()
  for (const r of inWindow) {
    const ts = r.createdAt
    if (!Number.isFinite(ts)) continue
    const k = hourKey(ts)
    hours.set(k, (hours.get(k) ?? 0) + 1)
  }
  const topHours = [...hours.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_HOURS).map(([k]) => k)

  const lines = [
    `[工作记忆 · 最近${windowDays}天]（只读观察层生成，数字与 /panorama/export 同源）`,
    `- 活跃工作区 ${activeWorkspaces} 个；窗口内会话活动 ${inWindow.length} 条`,
  ]
  if (topWorkspaces) lines.push(`- 工作区热度：${topWorkspaces}`)
  if (reused) lines.push(`- 反复打开的会话：${reused} 个（open_count≥2，复用/卡点信号）`)
  if (tags.length) lines.push(`- 你的标签：${tags.join('、')}`)
  if (topHours.length) lines.push(`- 高频时段：${topHours.join('、')}`)
  if (notes.length) lines.push(`- 人工备注：${notes.join('；')}`)
  return lines.join('\n')
}

/**
 * 创建记忆桥：返回 variable 函数与 disposer。
 * @param db panorama 派生库句柄（可为 null → 恒返回占位文本）
 * @param cfg { windowDays, titleOf?: (workspaceId: string) => string | null }
 */
export function createMemoryBridge(db, cfg = {}) {
  let cache = { text: null, at: 0 }
  const windowDays = Number.isFinite(cfg.windowDays) ? cfg.windowDays : WINDOW_DAYS_DEFAULT
  const titleOf = typeof cfg.titleOf === 'function' ? cfg.titleOf : () => null

  const variable = () => {
    const now = Date.now()
    if (cache.text !== null && now - cache.at < CACHE_TTL_MS) return cache.text
    let text
    try {
      const rows = db ? db.listObservations() : []
      const enriched = rows.map((r) => ({
        sessionId: r.session_id,
        // 窗口口径 = 会话真实活动时间；观察库未回填时退回最后观察时间（provenance 在库内标注）
        updatedAt: Number.isFinite(r.updated_at) ? r.updated_at : r.last_seen_at,
        createdAt: r.created_at,
        workspaceTitle: r.workspace_id ? titleOf(r.workspace_id) : null,
        openCount: r.open_count ?? 0,
        tags: safeTags(r.user_tags),
        manualNote: r.manual_note ?? null,
      }))
      text = buildDigest(enriched, { windowDays })
    } catch (error) {
      // 观察层不可读：稳定占位（不抛错——variable 抛错会击穿 prompt 装配）
      text = `[工作记忆 · 最近${windowDays}天] 观察层暂不可读，跳过本次注入`
    }
    cache = { text, at: now }
    return text
  }

  return { variable, dispose() { cache = { text: null, at: 0 } } }
}

function safeTags(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : []
  } catch {
    return []
  }
}
