/**
 * 已解决问题回流（知识积累闭环，P1-B）
 * ===========================================================
 * 需求②：用户在插件里解决了某个问题后，把「问题分类 / 症状 / 根因 /
 * 改进措施 / 解决过程」通过 submit_resolved_case 工具主动发回接收端
 *（/api/dsh/issue-resolved），接收端落盘后由知识库自动导入做知识积累。
 *
 * 合规底线（与 telemetry / experience 同级）：
 *   1. 只发 ISSUE_RESOLVED_FIELDS 白名单字段（硬编码），其余键一律丢弃。
 *   2. 白名单不含任何身份类字段（账号 / 路径 / 提示词 / 密钥 / 联系方式）。
 *   3. fire-and-forget：HTTP 失败 / 超时绝不影响工具主流程。
 *   4. 默认关闭：issueResolvedEnabled=false 或端点空 = 完全不启用（显式 opt-in）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let _fallbackVersion = null
function fallbackVersion() {
  if (_fallbackVersion !== null) return _fallbackVersion
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
    _fallbackVersion = String(pkg.version || '')
  } catch {
    _fallbackVersion = ''
  }
  return _fallbackVersion
}

// 仅允许回流知识库所需的纯技术内容字段（与接收端白名单逐字一致）
export const ISSUE_RESOLVED_FIELDS = [
  'category', 'symptom', 'root_cause', 'remediation', 'resolution_process',
  'related_tool', 'severity', 'tags',
]

/**
 * 解析回传目标 URL。
 * 优先级：config.issueResolvedEndpoint 显式配置 > 由 commerceBackendUrl 自动拼
 * /api/dsh/issue-resolved。两者皆空则回传不启用。
 */
export function resolveIssueResolvedEndpoint(config = {}) {
  const explicit = String(config.issueResolvedEndpoint || '').trim()
  if (explicit) return explicit
  const backend = String(config.commerceBackendUrl || '').trim()
  if (backend) return backend.replace(/\/+$/, '') + '/api/dsh/issue-resolved'
  return ''
}

/**
 * 提交一条「已解决问题」到接收端（fire-and-forget）。
 * @param {object} config 插件配置（issueResolvedEnabled / issueResolvedEndpoint / commerceBackendUrl）
 * @param {object} payload 工具传入的 { category, symptom, root_cause, remediation, resolution_process, ... }
 * @returns {Promise<{ submitted: boolean, reason?: string }>}
 */
export async function submitResolvedCase(config = {}, payload = {}) {
  const enabled = config.issueResolvedEnabled === true
  if (!enabled) return { submitted: false, reason: 'disabled' }
  const endpoint = resolveIssueResolvedEndpoint(config)
  if (!endpoint) return { submitted: false, reason: 'no-endpoint' }

  // 白名单裁剪：仅保留 ISSUE_RESOLVED_FIELDS，其余键（含任何意外混入的身份字段）丢弃
  const cleaned = {}
  for (const k of ISSUE_RESOLVED_FIELDS) {
    if (payload[k] !== undefined && payload[k] !== null) cleaned[k] = payload[k]
  }
  // 必填校验：至少要有 symptom 或 resolution_process，避免空回流污染知识库
  if (!cleaned.symptom && !cleaned.resolution_process) {
    return { submitted: false, reason: 'empty-content' }
  }

  const body = {
    plugin: 'dsh-motor-ai-l0',
    plugin_version: fallbackVersion(),
    kind: 'l0-issue-resolved',
    ...cleaned,
    reported_at: new Date().toISOString(),
  }

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 5000) : null
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'dsh-motor-ai-l0/issue-resolved' },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (timer) clearTimeout(timer)
    if (res && res.ok) return { submitted: true }
    return { submitted: false, reason: `http_${res?.status ?? 'n/a'}` }
  } catch (err) {
    return { submitted: false, reason: String(err?.message ?? err).slice(0, 60) }
  }
}

export default { ISSUE_RESOLVED_FIELDS, resolveIssueResolvedEndpoint, submitResolvedCase }
