/**
 * 摘要服务（规格 §7，C4 核心）：
 *  - 展示优先级：manual_note（用户手写） > 缓存 snippet > 检索 snippet > null（"暂无摘要"）
 *  - 摘要只来自 searchSessions 的 bestMatch.snippet（后端按 snippetChars≤240 截断），绝不生成文本
 *  - 查询词 = 会话标题；trim 后为空 → 不发查询
 *  - STALE_CURSOR 重试一次；SEARCH_DISABLED 记入 health.search 并短路后续调用
 */

const QUERY_MAX_CHARS = 500

export function createSummaryService(ctx, db, logger, state) {
  const disabled = () => state && state.search === 'disabled'

  return async function summarize(sessionId, title, forUpdatedAt) {
    // 1) 用户手写摘要优先（快照行已带 manualNote，这里兜底直读）
    let obs = null
    try { obs = db ? db.getObservation(sessionId) : null } catch { /* 观察层读失败 */ }
    if (obs?.manual_note) {
      return { snippet: obs.manual_note, source: 'manual-note' }
    }

    // 2) 缓存命中（以 updatedAt 为失效键）
    if (obs?.summary_cache && obs.summary_for_updated_at === forUpdatedAt) {
      return { snippet: obs.summary_cache, source: obs.summary_source ?? 'session-query-snippet' }
    }

    // 3) 搜索已知不可用 → 直接短路（防重试风暴）
    if (disabled()) return { snippet: null, source: null }

    // 4) 无查询词 → 不检索、不编造
    const query = String(title ?? '').trim().slice(0, QUERY_MAX_CHARS)
    if (!query) return { snippet: null, source: null }

    const provider = ctx.get('sessionQuery')
    if (!provider || typeof provider.searchSessions !== 'function') {
      if (state) state.search = 'unavailable'
      return { snippet: null, source: null }
    }

    const run = () => provider.searchSessions({
      query,
      limit: 1,
      sessionFilters: [{ kind: 'id', values: [sessionId] }],
      // 与原生 search 同偏置：snippet 落在消息正文上（list.ts 源码定案）
      eventFilters: [
        { kind: 'type', values: ['user/message', 'assistant/message'] },
        { kind: 'surface', values: ['current'] },
      ],
    }, { signal: AbortSignal.timeout(10_000) })

    let retried = false
    for (;;) {
      try {
        const page = await run()
        const snippet = page.items[0]?.bestMatch?.snippet ?? null
        if (state && state.search === 'unknown') state.search = 'ok'
        try {
          db?.setSummary(sessionId, {
            snippet,
            source: snippet ? 'session-query-snippet' : null,
            forUpdatedAt,
          })
        } catch { /* 缓存写失败不影响返回 */ }
        return { snippet, source: snippet ? 'session-query-snippet' : null }
      } catch (error) {
        const code = error?.code
        if (code === 'SESSION_QUERY_STALE_CURSOR' && !retried) {
          retried = true
          continue
        }
        if (code === 'SESSION_QUERY_SEARCH_DISABLED') {
          if (state) state.search = 'disabled'
          return { snippet: null, source: null, error: code }
        }
        if (state && state.search === 'unknown') {
          state.search = 'error'
          state.searchError = code ?? String(error?.message ?? error)
        }
        logger?.warn?.(`panorama: summarize ${sessionId} failed: ${code ?? String(error?.message ?? error)}`)
        return { snippet: null, source: null, error: code ?? String(error?.message ?? error) }
      }
    }
  }
}
