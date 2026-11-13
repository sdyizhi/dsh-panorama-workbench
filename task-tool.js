/**
 * R2 门下省/任务工具（panorama_task）：让主 Agent（Router）直接操作任务状态层。
 *
 * 形状照抄本机已装插件（@linxin666/dsh-client-ui-git-graph 的 git_worktree）验证过的
 * ToolDefinition：parameters 用原始 JSON Schema（type/properties/required），
 * output.schema + render 返回 ContentBlock[]，execute(args, exec) 返回 canonical value。
 *
 * 只读写 panorama.db；不触碰原生会话存储（红线不变）。
 */

// ⚠️ 不提供 verdict op：裁决只能由 panorama_audit / panorama_deliver 产生。
//    若允许模型自己 panorama_task verdict pass，"门下省"就被绕过了（自我批准）。
const ACTIONS = ['create', 'list', 'status', 'link', 'delete']
const GATED_STATUSES = ['delivered', 'accepted', 'rejected']
const STATUSES = ['queued', 'running', 'delivered', 'accepted', 'rejected']

export function buildTaskTool(db) {
  return {
    name: 'panorama_task',
    description: [
      'Operate the panorama task state table (cross-session work items).',
      'create: add a task with a title and optional acceptance criteria;',
      'list: read tasks, optionally filtered by status;',
      'status: move a task through queued/running (delivered/accepted/rejected are gated — use panorama_deliver);',
      'verdicts are NOT settable here: they come only from panorama_audit / panorama_deliver (independent review).',
      'link: attach the session ids that worked on a task.',
      'delete: remove a task and its event chain (test cleanup / retraction).',
      'Use verdict fail with a reason to send work back; the reason is kept in the task event chain.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'The task operation to perform.',
        },
        taskId: {
          type: 'string',
          description: 'Task id (required for status/link; omitted for create to auto-generate).',
        },
        title: {
          type: 'string',
          description: 'create: task title.',
        },
        acceptanceCriteria: {
          type: 'string',
          description: 'create: what must be true for this task to pass review.',
        },
        status: {
          type: 'string',
          enum: STATUSES,
          description: 'status: the new status. delivered/accepted/rejected are gated — use panorama_deliver.',
        },
        sessionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'link: session ids that worked on the task.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const input = (typeof args === 'object' && args !== null ? args : {})
      const action = input.action
      if (!ACTIONS.includes(action)) {
        return { ok: false, code: 'invalid-action', message: `action must be one of ${ACTIONS.join(', ')}` }
      }
      if (!db) {
        return { ok: false, code: 'derived-db-unavailable', message: 'panorama derived database is unavailable' }
      }
      try {
        switch (action) {
          case 'create': {
            if (typeof input.title !== 'string' || input.title.trim() === '') {
              return { ok: false, code: 'invalid-title', message: 'create requires a non-empty title' }
            }
            const taskId = typeof input.taskId === 'string' && input.taskId.trim() !== ''
              ? input.taskId.trim()
              : `task-${Date.now().toString(36)}`
            const task = db.createTask({
              taskId,
              title: input.title,
              acceptanceCriteria: typeof input.acceptanceCriteria === 'string' ? input.acceptanceCriteria : null,
            })
            return { ok: true, task }
          }
          case 'list': {
            const status = typeof input.status === 'string' ? input.status : null
            return { ok: true, items: db.listTasks(status) }
          }
          case 'status': {
            if (typeof input.taskId !== 'string' || !STATUSES.includes(input.status)) {
              return { ok: false, code: 'invalid-args', message: 'status requires taskId and a valid status' }
            }
            // R2c 结构性强制：delivered/accepted/rejected 只能由 panorama_deliver 产生，
            // 否则"交付必过审"会被绕过（分两步走就等于可以只推状态不审核）。
            if (GATED_STATUSES.includes(input.status)) {
              return {
                ok: false, code: 'gated-status',
                message: `status '${input.status}' is gated: deliver through panorama_deliver (delivery always runs independent review)`,
              }
            }
            const task = db.setTaskStatus(input.taskId, input.status)
            if (!task) return { ok: false, code: 'task-not-found', message: `no task ${input.taskId}` }
            return { ok: true, task }
          }
          case 'delete': {
            if (typeof input.taskId !== 'string' || input.taskId.trim() === '') {
              return { ok: false, code: 'invalid-args', message: 'delete requires taskId' }
            }
            const deleted = db.deleteTask(input.taskId)
            if (!deleted) return { ok: false, code: 'task-not-found', message: `no task ${input.taskId}` }
            return { ok: true, deleted: input.taskId }
          }
          case 'link': {
            if (typeof input.taskId !== 'string' || !Array.isArray(input.sessionIds)) {
              return { ok: false, code: 'invalid-args', message: 'link requires taskId and sessionIds[]' }
            }
            const task = db.linkTaskSessions(input.taskId, input.sessionIds)
            if (!task) return { ok: false, code: 'task-not-found', message: `no task ${input.taskId}` }
            return { ok: true, task }
          }
          /* v8 ignore next -- closed action union */
          default:
            return { ok: false, code: 'invalid-action', message: `unsupported action ${String(action)}` }
        }
      } catch (error) {
        return { ok: false, code: 'task-op-failed', message: String(error?.message ?? error) }
      }
    },
  }
}
