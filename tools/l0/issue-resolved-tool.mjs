/**
 * 工具 4b：submit_resolved_case —— 已解决问题回流（知识积累闭环，P1-B）
 * ===========================================================
 * 定位：用户在插件里解决了某个问题后，主动把「问题 → 根因 → 改进措施 →
 * 解决过程」提交回接收端，喂在线知识库做知识积累（需求②闭环的最后一段）。
 *
 * 设计要点：
 *   - 这是「贡献型」工具，不调用任何 core 估算 / 校验函数，**不消耗免费额度**。
 *   - fire-and-forget：提交失败只返回友好提示，绝不阻断用户主流程。
 *   - 默认需 issueResolvedEnabled=true 才真正外发；否则仅提示用户先开启开关。
 */

import { submitResolvedCase } from '../../lib/issue-resolved.mjs'
import { getUsageSink, logUsage } from '@wangxue98/dsh-motor-ai-core'

/** 工具入参声明 */
export const TOOL_PARAMS = {
  category: {
    type: 'string',
    enum: ['geometry', 'thermal', 'magnetic', 'winding', 'material', 'workflow', 'other'],
    description: '问题分类：geometry 几何 / thermal 温升 / magnetic 磁密 / winding 绕组 / material 材料 / workflow 工作流 / other 其他',
  },
  symptom: {
    type: 'string',
    description: '问题现象描述（用户遇到什么）：如「校验报 V08 轭厚 failed」「估算效率异常低」',
  },
  root_cause: {
    type: 'string',
    description: '根因分析：如「轭厚取值偏小导致轭部磁密超 1.9T 饱和」',
  },
  remediation: {
    type: 'string',
    description: '改进措施：如「轭厚由 12mm 提到 16mm，并复核轭部磁密」',
  },
  resolution_process: {
    type: 'string',
    description: '完整解决过程（步骤化）：从现象到验证通过的链路',
  },
  related_tool: {
    type: 'string',
    description: '关联工具名（可选）：如 motor_design_validate / motor_l0_estimate',
  },
  severity: {
    type: 'string',
    enum: ['low', 'medium', 'high'],
    description: '严重度（可选，默认 low）',
  },
  tags: {
    type: 'array',
    description: '标签（可选）：便于知识库检索，如 ["轭厚", "磁饱和", "V08"]',
  },
}

/**
 * 纯函数：组装 payload 并提交（不触额度）。
 * @returns {Promise<{ status: 'submitted'|'skipped'|'error', message: string }>}
 */
export async function runSubmitResolvedCase(args, config = {}) {
  const t0 = Date.now()
  const payload = {
    category: args?.category,
    symptom: args?.symptom,
    root_cause: args?.root_cause,
    remediation: args?.remediation,
    resolution_process: args?.resolution_process,
    related_tool: args?.related_tool,
    severity: args?.severity ?? 'low',
    tags: Array.isArray(args?.tags) ? args.tags : undefined,
  }
  // 去掉 undefined 字段，保持 payload 干净
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k]

  const res = await submitResolvedCase(config, payload)
  if (res.submitted) {
    logUsage(getUsageSink(config), {
      tool: 'submit_resolved_case', ok: true, elapsed_ms: Date.now() - t0, n: 1,
    })
    return { status: 'submitted', message: '已提交到知识库回流通道，感谢你的知识贡献！' }
  }
  // disabled / no-endpoint：提示用户开启开关，不视为错误；配了知识库则引导先去查因（P1-C）
  if (res.reason === 'disabled' || res.reason === 'no-endpoint') {
    const kb = String(config.knowledgeBaseUrl || '').trim()
    const kbHint = kb
      ? `可先到在线知识库查找同类问题的原因与改进措施：${kb}\n`
      : ''
    return {
      status: 'skipped',
      message:
        '已解决问题回流当前未启用：请在插件配置中设置 issueResolvedEnabled: true'
        + '（并保留 commerceBackendUrl 或显式填 issueResolvedEndpoint）。开启后可自动发回知识库。\n'
        + kbHint
        + '你的内容未丢失，可在开启后重新提交。',
    }
  }
  return {
    status: 'error',
    message: `提交未成功（${res.reason ?? 'unknown'}）。你的内容未丢失，可在开启 / 修复后重试。`,
  }
}

/**
 * 工具注册（薄封装，动态 import 保证离线可加载）
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export async function registerSubmitResolvedCase(ctx, config = {}) {
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  ctx.tools.register(defineTool({
    name: 'submit_resolved_case',
    description:
      '提交一条「已解决问题」到 dsh-motor-ai 在线知识库，做知识积累（需求②闭环）。\n'
      + '当你在电机设计 / 插件使用中遇到问题、并在知识库查到原因 / 改进措施、最终自己解决后，\n'
      + '用本工具把「问题分类 / 症状 / 根因 / 改进措施 / 解决过程」回传，帮助后续用户少走弯路。\n'
      + '这是贡献型工具，不消耗免费额度。提交内容仅含技术描述，不含任何身份 / 路径 / 密钥信息。\n'
      + '⚠️ 需先在插件配置开启 issueResolvedEnabled: true（默认关闭）才真正外发；未开启时仅给出提示。',
    parameters: TOOL_PARAMS,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      try {
        return JSON.stringify(await runSubmitResolvedCase(args, config), null, 2)
      } catch (err) {
        return JSON.stringify({ status: 'error', message: String(err?.message ?? err) }, null, 2)
      }
    },
  }))
}

export default { runSubmitResolvedCase, registerSubmitResolvedCase, TOOL_PARAMS }
