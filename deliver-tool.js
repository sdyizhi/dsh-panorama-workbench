/**
 * R2c 交付流水线（panorama_deliver）：交付 = 状态推进到 delivered + 自动过门下省审核。
 *
 * 为什么必须是一条链，而不是让模型自己先 status=delivered 再调用 audit：
 *   - 分两步就可以被跳过（模型只推状态、不审核）→ 门下省形同虚设；
 *   - 本工具把「交付」定义为【必须过审】，panorama_task 的 status 直接跳转
 *     delivered/accepted/rejected 会被拒绝（结构性强制，而非靠提示词自觉）。
 *
 * 回炉循环：fail → rejected（理由即回炉单）→ worker 返工后再次 panorama_deliver。
 * 累计 MAX_REWORK 次封驳后置 escalated=1，需人工介入（防止无限回炉）。
 */
import { runAudit } from './audit-core.js'
import { MAX_REWORK } from './panorama-db.js'

export function buildDeliverTool(db, ctx) {
  return {
    name: 'panorama_deliver',
    description: [
      'Deliver a task THROUGH independent review (门下省). This is the only path to delivered/accepted/rejected:',
      'it marks the task delivered, spawns a separate reviewer agent that judges the deliverable against the',
      'acceptance criteria, and records the verdict — pass marks accepted; fail marks rejected and the reviewer',
      'reason becomes the rework brief. After a rejection, rework and call this again.',
      'Delivery cannot skip review. If the task has no acceptance criteria, pass them explicitly.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: 'Task to deliver (from panorama_task create/list).' },
        deliverable: {
          type: 'string',
          description: 'What was produced: a file path, a session id, or an inline description of the work product.',
        },
        criteria: {
          type: 'string',
          description: 'Optional acceptance criteria override; defaults to the task acceptance criteria.',
        },
        provider: {
          type: 'string',
          enum: ['spawn', 'fork'],
          description: "Reviewer backend. 'spawn' (default) is a fresh independent agent; 'fork' is NOT independent.",
        },
      },
      required: ['taskId', 'deliverable'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const input = (typeof args === 'object' && args !== null ? args : {})
      if (typeof input.taskId !== 'string' || input.taskId.trim() === '') {
        return { ok: false, code: 'invalid-taskId', message: 'taskId is required' }
      }
      if (typeof input.deliverable !== 'string' || input.deliverable.trim() === '') {
        return { ok: false, code: 'invalid-deliverable', message: 'deliverable is required' }
      }
      if (!db) return { ok: false, code: 'derived-db-unavailable', message: 'panorama derived database is unavailable' }

      const task = db.getTask(input.taskId)
      if (!task) return { ok: false, code: 'task-not-found', message: `no task ${input.taskId}` }
      if (task.escalated) {
        return {
          ok: false, code: 'escalated',
          message: `this task has been rejected ${MAX_REWORK} times and needs a human decision; not re-delivering automatically`,
          task,
        }
      }
      if (task.status === 'accepted') {
        return { ok: false, code: 'already-accepted', message: 'task is already accepted; delivery is closed', task }
      }

      const criteria = typeof input.criteria === 'string' && input.criteria.trim() !== ''
        ? input.criteria.trim()
        : task.acceptance_criteria
      if (!criteria) {
        return {
          ok: false, code: 'criteria-required',
          message: 'the task has no acceptance criteria; pass criteria explicitly to deliver',
          task,
        }
      }

      // 1) 交付：状态推进到 delivered（留痕），随后必须过审
      db.setTaskStatus(input.taskId, 'delivered')

      // 2) 门下省独立审核（spawn 全新子会话，不继承执行者上下文）
      const audit = await runAudit({
        ctx,
        taskId: input.taskId,
        title: task.title,
        criteria,
        deliverable: input.deliverable,
        provider: input.provider === 'fork' ? 'fork' : 'spawn',
        parent: exec?.agent,
        signal: exec.signal,
      })
      if (!audit.ok) {
        // 审核本身失败（不是裁决失败）：任务留在 delivered，不伪造裁决
        return { ok: false, code: audit.code, message: audit.message, task: db.getTask(input.taskId), reviewer: audit.reviewer ?? null }
      }

      // 3) 落裁决：pass → accepted；fail → rejected（rework_count 由 db 累加）
      //    审核者带伤（stopReason !== 'completed'）时把降级标记写入事件链，便于事后复核。
      const updated = db.setTaskVerdict(input.taskId, {
        verdict: audit.verdict,
        reason: audit.reason,
        by: `agent:audit:${audit.reviewer.childId}`,
        note: audit.reviewer.degraded ? `reviewer-degraded(${audit.reviewer.stopReason})` : null,
      })
      const escalated = Boolean(updated.escalated)
      return {
        ok: true,
        task: updated,
        audit: {
          verdict: audit.verdict,
          reason: audit.reason,
          evidence: audit.evidence,
          reviewer: audit.reviewer,
        },
        reviewerDegraded: Boolean(audit.reviewer.degraded),
        reworkCount: updated.rework_count ?? 0,
        escalated,
        next: escalated
          ? `已封驳 ${MAX_REWORK} 次，转人工介入（reason 即回炉单）`
          : audit.verdict === 'pass'
            ? '验收通过，任务关闭'
            : `封驳回炉：按 reason 修改后再次 panorama_deliver（第 ${updated.rework_count} 次）`,
      }
    },
  }
}
