/**
 * R2b 门下省审核（panorama_audit）：一次独立复核。
 * 审核逻辑在 audit-core.js（与 panorama_deliver 共用）。
 */
import { runAudit } from './audit-core.js'

export function buildAuditTool(db, ctx) {
  return {
    name: 'panorama_audit',
    description: [
      'Independent review (门下省) of a task delivery: spawns a separate reviewer agent that judges',
      'the deliverable against the task acceptance criteria, then records the verdict on the task.',
      'pass marks the task accepted; fail marks it rejected and the reviewer reason becomes the rework brief.',
      'Prefer panorama_deliver for the delivery pipeline — it reviews automatically and cannot be skipped.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: 'Task to review (from panorama_task create/list).' },
        deliverable: {
          type: 'string',
          description: 'What to review: a file path, a session id, or an inline description of the work product.',
        },
        criteria: {
          type: 'string',
          description: 'Optional review criteria override; defaults to the task acceptance criteria.',
        },
        provider: {
          type: 'string',
          enum: ['spawn', 'fork'],
          description: "Reviewer backend. 'spawn' (default) is a fresh independent agent; 'fork' inherits your context and is NOT independent.",
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

      const criteria = typeof input.criteria === 'string' && input.criteria.trim() !== ''
        ? input.criteria.trim()
        : task.acceptance_criteria

      const result = await runAudit({
        ctx,
        taskId: input.taskId,
        title: task.title,
        criteria,
        deliverable: input.deliverable,
        provider: input.provider === 'fork' ? 'fork' : 'spawn',
        parent: exec?.agent,
        signal: exec.signal,
      })
      if (!result.ok) return result

      const updated = db.setTaskVerdict(input.taskId, {
        verdict: result.verdict,
        reason: result.reason,
        by: `agent:audit:${result.reviewer.childId}`,
      })
      return { ok: true, task: updated, reviewer: result.reviewer, evidence: result.evidence }
    },
  }
}
