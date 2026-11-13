/**
 * 门下省审核核心（R2b/R2c 共用）：派生一个【独立】审核 Agent，按验收标准审查交付物，
 * 返回裁决。**不写库**——由调用方决定如何处理裁决（panorama_audit 直接落库；
 * panorama_deliver 先落 delivered 再走裁决）。
 *
 * 契约（dsh-subagent 0.2.2-rc.1 安装包实测）：
 *  - startActivation({ provider, label, request, signal, delivery, childId? })
 *      request = { prompt: ContentBlock[], parent, outputSchema?, maxDepth?, agentOptions?, agentPreset?, cwd? }
 *      parent 必须是精确存活的父 Agent → 用工具上下文里的 exec.agent；
 *      delivery:'caller' 只把结果返回调用方（不发父会话完成通知），可 await；
 *      result = { output: ContentBlock[], structured?, diagnostic?, stopReason }。
 *  - ⚠️ prompt/parent/outputSchema 必须在 request 内（平铺会抛 maxDepth undefined）。
 *  - 独立性：provider 'spawn' 全新子会话（不继承父历史）→ 审核者≠执行者。
 */

export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    reason: { type: 'string', description: 'fail: what is wrong; pass: brief basis' },
    evidence: { type: 'string', description: 'which part of the deliverable supports the verdict' },
  },
  required: ['verdict'],
}

/** 从文本里尽力解析裁决 JSON（无 outputSchema 时的兜底）。 */
export function parseVerdictText(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const candidates = [text]
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.unshift(fenced[1])
  const inline = text.match(/\{[\s\S]*\}/)
  if (inline) candidates.unshift(inline[0])
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw.trim())
      if (parsed && (parsed.verdict === 'pass' || parsed.verdict === 'fail')) return parsed
    } catch { /* 尝试下一个候选 */ }
  }
  return null
}

export function reviewerPrompt({ title, criteria, deliverable }) {
  return [
    '你是独立审核者（门下省）。审查下面的交付物是否满足验收标准。',
    '要求：',
    '1. 只依据给定信息判断，不假设未提供的细节；',
    '2. 标准未满足时必须指出具体缺口；',
    '3. 严格输出一个 JSON 对象，不要附加其他文字：',
    '   {"verdict":"pass" 或 "fail","reason":"fail 时说明问题与修改方向","evidence":"支撑裁决的交付物位置"}',
    '',
    `任务：${title}`,
    `验收标准：${criteria}`,
    `交付物：${deliverable}`,
  ].join('\n')
}

/**
 * 执行一次独立审核。
 * @returns { ok: true, verdict, reason, evidence, reviewer } | { ok: false, code, message }
 */
export async function runAudit({
  ctx, taskId, title, criteria, deliverable, provider = 'spawn', parent, signal,
}) {
  if (!criteria) {
    return { ok: false, code: 'criteria-required', message: 'no acceptance criteria' }
  }
  if (!parent) {
    return { ok: false, code: 'no-parent-agent', message: 'review requires a calling agent to parent the reviewer' }
  }
  const subagents = ctx.get('subagents')
  if (!subagents || typeof subagents.startActivation !== 'function') {
    return { ok: false, code: 'subagents-unavailable', message: 'the subagent service is not available' }
  }

  const prompt = reviewerPrompt({ title, criteria, deliverable })
  const request = { prompt: [{ type: 'text', text: prompt }], parent }
  let activation
  try {
    activation = await subagents.startActivation({
      provider,
      label: `audit:${taskId}`.slice(0, 64),
      request: { ...request, outputSchema: VERDICT_SCHEMA },
      signal,
      delivery: 'caller',
    })
  } catch (error) {
    // 结构化输出不受支持时退化为文本裁决（保持审核可用）
    if (error?.code === 'UNSUPPORTED_CAPABILITY') {
      try {
        activation = await subagents.startActivation({
          provider, label: `audit:${taskId}`.slice(0, 64),
          request, signal, delivery: 'caller',
        })
      } catch (fallbackError) {
        return { ok: false, code: 'audit-start-failed', message: String(fallbackError?.message ?? fallbackError) }
      }
    } else {
      return { ok: false, code: error?.code ?? 'audit-start-failed', message: String(error?.message ?? error) }
    }
  }

  let result
  try {
    result = await activation.result
  } catch (error) {
    return { ok: false, code: 'audit-result-failed', message: String(error?.message ?? error) }
  }

  const structured = result?.structured && typeof result.structured === 'object' ? result.structured : null
  const textOut = Array.isArray(result?.output)
    ? result.output.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    : ''
  const parsed = structured && (structured.verdict === 'pass' || structured.verdict === 'fail')
    ? structured
    : parseVerdictText(textOut)

  const childId = String(activation.childId)
  if (!parsed) {
    return {
      ok: false, code: 'verdict-unparsed',
      message: `the reviewer produced no parseable verdict (stopReason=${String(result?.stopReason)})`,
      reviewer: { childId, output: textOut.slice(0, 2000), diagnostic: result?.diagnostic ?? null },
    }
  }

  const reason = typeof parsed.reason === 'string' ? parsed.reason : null
  if (parsed.verdict === 'fail' && !reason) {
    return {
      ok: false, code: 'reason-required',
      message: 'the reviewer returned fail without a reason; the task was not changed',
      reviewer: { childId, output: textOut.slice(0, 2000) },
    }
  }

  return {
    ok: true,
    verdict: parsed.verdict,
    reason,
    evidence: typeof parsed.evidence === 'string' ? parsed.evidence.slice(0, 2000) : null,
    reviewer: {
      childId,
      provider,
      stopReason: String(result?.stopReason ?? 'unknown'),
      // ⚠️ stopReason !== 'completed' 表示审核者的运行【带伤】：
      // dsh-subagent activation.ts 的 captureLocalResult 里，'error' 来自
      //   ① child 的 agent/error 事件未被后续 turn/end 清除（failureAt 仍在），或
      //   ② 结构化值未捕获且 stopReason 本是 completed（被强制降级为 error）。
      // 本实现采信已捕获的结构化裁决（DSH 也这么认为），但把降级标记出来持久化，
      // 让调用方可以要求重审，而不是静默当成干净通过。
      degraded: String(result?.stopReason ?? 'unknown') !== 'completed',
    },
  }
}
