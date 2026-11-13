/**
 * R3 主动触发（panorama_watch）：让"该被主动提起但没人问"的事按时浮出来。
 *
 * 两部分：
 *  1) 条件评估（signals.js）——封驳久未回炉 / 已升级待人工 / 任务久无进展 / 工作区长期无活动；
 *  2) 定时自检——用 Host `ctx.schedule` 建一个每日任务，把评估结果投递到新会话，
 *     由 Agent 把 severity=warn 的项整理成提醒；没有 warn 项就不打扰用户。
 *
 * 契约（dsh-schedule README 实测）：
 *  ctx.schedule.create({ title, prompt, timing, target }, actorSessionId?, signal?)
 *      timing: { kind:'cron', cron:{ expression, time_zone } }   （README 示例形状）
 *      target: { kind:'new_once' }
 *  ctx.schedule.list(request?) / edit({ id, action:'delete' })
 */

export const WATCH_TITLE = 'panorama: 主动信号自检'
export const DEFAULT_WATCH_CRON = '0 9 * * *'   // 每天 09:00
export const DEFAULT_WATCH_TZ = 'Asia/Shanghai'

const WATCH_PROMPT = [
  '你是 panorama 工作台的值班助手。请：',
  '1. 调用 panorama_signals（或读取 GET /panorama/signals）获取当前主动信号；',
  '2. 只把 severity=warn 的条件整理成简短提醒发给用户（每条含任务标题与摘要）；',
  '3. 若没有任何 warn 项，不要打扰用户，直接结束。',
  '不要自行创建或修改任务，只汇报。',
].join('\n')

/** list()/catalog() 的返回形状未在文档中固定 —— 容错提取条目数组。 */
function entriesOf(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.items)) return result.items
  if (Array.isArray(result?.tasks)) return result.tasks
  if (Array.isArray(result?.records)) return result.records
  return []
}

/** 条目可能是 record 本身，也可能是 { record, target, status } 信封。 */
function idOf(entry) {
  return entry?.id ?? entry?.record?.id ?? null
}
function titleOf(entry) {
  return entry?.title ?? entry?.record?.title ?? null
}

export function buildWatchTool(db, ctx, cfg = {}) {
  const cron = cfg.watchCron ?? DEFAULT_WATCH_CRON
  const timeZone = cfg.watchTimezone ?? DEFAULT_WATCH_TZ
  const prompt = cfg.watchPrompt ?? WATCH_PROMPT

  const findWatch = async (schedule) => {
    const entries = entriesOf(await schedule.list({ limit: 500 }))
    return entries.find((e) => titleOf(e) === WATCH_TITLE) ?? null
  }

  return {
    name: 'panorama_watch',
    description: [
      'Manage the proactive panorama watch: creates a daily scheduled check that surfaces conditions',
      'nobody asked about — tasks rejected and never re-delivered, escalated tasks needing a human,',
      'tasks idle for days, workspaces with no activity for days.',
      'status: read current state; enable: create (idempotent) the daily self-check; disable: remove it.',
      'The watch only reports warn-severity items and stays silent when there are none.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'enable', 'disable'],
          description: 'status: read; enable: create the daily watch (idempotent); disable: delete it.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const action = args?.action
      if (!['status', 'enable', 'disable'].includes(action)) {
        return { ok: false, code: 'invalid-action', message: 'action must be status|enable|disable' }
      }
      const schedule = ctx.get('schedule')
      if (!schedule || typeof schedule.create !== 'function') {
        return { ok: false, code: 'schedule-unavailable', message: 'the Host schedule service is not available' }
      }
      try {
        if (action === 'status') {
          const found = await findWatch(schedule)
          return {
            ok: true,
            enabled: Boolean(found),
            schedule: found ? { id: idOf(found), title: titleOf(found), raw: found } : null,
          }
        }
        if (action === 'enable') {
          const existing = await findWatch(schedule)
          if (existing) {
            return { ok: true, enabled: true, note: 'already-enabled', schedule: { id: idOf(existing), title: titleOf(existing) } }
          }
          const base = {
            title: WATCH_TITLE,
            prompt,
            timing: { kind: 'cron', cron: { expression: cron, time_zone: timeZone } },
          }
          let entry
          let target
          try {
            // 首选：独立会话（自检不打扰用户当前对话）
            entry = await schedule.create({ ...base, target: { kind: 'new_once' } })
            target = 'new_once'
          } catch (error) {
            // 降级：new_once 需要 Session 创建提供者，插件上下文未必提供；
            // 退回投递到"启用者所在会话"（this_session 语义），保证自检仍可用。
            const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
            if (!sessionId) throw error
            entry = await schedule.create({ ...base, target: { kind: 'session', sessionId } })
            target = 'session'
          }
          return {
            ok: true, enabled: true, note: 'created', target,
            schedule: { id: idOf(entry) ?? entry?.id ?? null, title: titleOf(entry) ?? WATCH_TITLE },
          }
        }
        // disable
        const existing = await findWatch(schedule)
        if (!existing) return { ok: true, enabled: false, note: 'not-enabled' }
        await schedule.edit({ id: idOf(existing), action: 'delete' })
        return { ok: true, enabled: false, note: 'deleted', schedule: { id: idOf(existing) } }
      } catch (error) {
        return { ok: false, code: error?.code ?? 'watch-failed', message: String(error?.message ?? error) }
      }
    },
  }
}
