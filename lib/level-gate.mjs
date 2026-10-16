/**
 * ⚠️ 陈旧镜像 / 死代码 —— 请勿在本文件上阅读或修改业务逻辑（2026-10-17 标注）
 * ============================================================================
 * 分类：死代码（core 同名镜像）
 * 真源：@wangxue98/dsh-motor-ai-core → D:/dsh-motor-ai-core/lib/level-gate.mjs
 *       （node_modules/@wangxue98/dsh-motor-ai-core 是指向该目录的符号链接）
 * 现状：本文件与 core 真源**逐字节相同**（75 行，纯镜像副本）。
 *
 * dsh-motor-ai-l0 运行时只从 l0/lib 消费 3 个文件：
 *   quota.mjs                —— 免费额度硬闸
 *   leverage-knowledge.mjs   —— P2-3 杠杆知识库
 *   temp-calib-log.mjs       —— P1-6 温升标定日志
 * 设计引擎（quickL0Estimate / validateDesign / deriveElectricalClosure /
 * estimateCopperLoss …）全部 import 自 core，改本目录下的同名文件不会生效。
 *
 * 全仓库无任何 import 引用；index.mjs 的层级门禁走 core 的 level-gate。
 *
 * 处置：已登记为改进方案 P1-12，待授权后删除或整体下线。
 */

/**
 * 层级门控 (Level Gate)
 * ============================================================
 * L0 = 经验公式 + 代理模型（毫秒级，全部方案，免费层）
 * L1 = RMxprt 磁路法（秒级，TopN，VIP）——W1 阶段未实现
 * L2 = Motor-CAD 精细验证（分钟级，Top3，旗舰）——W1 阶段未实现
 *
 * 设计要点：
 *   - 本模块零依赖，可被 Node 直接 import 做离线断言（scripts/verify.mjs）
 *   - 任何试图越级激活的配置必须「快速失败」，而不是静默降级
 */

/** 层级顺序：索引越大越重 */
export const LEVEL_ORDER = ['l0', 'l1', 'l2']

/** 当前已实现的层级允许列表（实现 L1 时扩展为 ['l0','l1']，见 styles verification） */
export const IMPLEMENTED_LEVELS = ['l0']

/**
 * 规范化层级名：容错 'L0' / ' L0 ' 等写法
 * @param {string} level
 * @returns {string}
 */
export function normalizeLevel(level) {
  return String(level || '').trim().toLowerCase()
}

/**
 * 判断目标层级是否启用
 * 规则：目标层级必须 <= 当前总闸层级，且对应的 Enabled 分闸为 true
 * @param {{level?: string, l1Enabled?: boolean, l2Enabled?: boolean}} config
 * @param {string} targetLevel
 * @returns {boolean}
 */
export function isLevelEnabled(config, targetLevel) {
  const currentIndex = LEVEL_ORDER.indexOf(normalizeLevel(config?.level))
  const targetIndex = LEVEL_ORDER.indexOf(normalizeLevel(targetLevel))

  if (currentIndex < 0 || targetIndex < 0) return false
  if (targetIndex > currentIndex) return false

  if (normalizeLevel(targetLevel) === 'l1') return config?.l1Enabled === true
  if (normalizeLevel(targetLevel) === 'l2') return config?.l2Enabled === true
  return true // l0 始终可用
}

/**
 * 断言目标层级已实现 —— 未实现则立即抛错（快速失败）
 * @param {string} targetLevel
 * @throws {Error} 当目标层级不在 IMPLEMENTED_LEVELS 中
 */
export function assertLevelImplemented(targetLevel) {
  const level = normalizeLevel(targetLevel)
  if (!IMPLEMENTED_LEVELS.includes(level)) {
    throw new Error(
      `[dsh-motor-ai-l0] ${level || '(空)'} 尚未实现。请将 level 设为 '${IMPLEMENTED_LEVELS[0]}'。`
    )
  }
  return level
}

/**
 * 返回某层级的授权/付费标签（商业化钩子占位）
 * @param {string} level
 * @returns {'free'|'vip'|'flagship'|null}
 */
export function tierOf(level) {
  switch (normalizeLevel(level)) {
    case 'l0': return 'free'
    case 'l1': return 'vip'
    case 'l2': return 'flagship'
    default: return null
  }
}
