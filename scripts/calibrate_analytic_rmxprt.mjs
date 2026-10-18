#!/usr/bin/env node
/**
 * calibrate_analytic_rmxprt.mjs —— 解析通道 RMxprt 离线标定 harness（B/S0）
 * ============================================================================
 * 目的：用 RMxprt 真值反算 analytic-engine 的绝对系数，消除「骨架期」的近似：
 *   - 硅钢 B-H 曲线（doSaturationLoop 用，当前为 DW540-50 典型值）
 *   - 卡特系数适用性 / 槽口修正（carterFactor）
 *   - 热阻网络常数（thermalCouplingLoop 用，当前 estimateTempRise 单趟经验式）
 *
 * 沙箱约束：本机无 ANSYS / RMxprt 授权，故真实标定「不可执行」。
 *   本脚本只搭建结构 + 产出标定 schema（--dry-run），真实 run 由 requires-Ansys 守卫拦截。
 *
 * 用法：
 *   node scripts/calibrate_analytic_rmxprt.mjs --dry-run [--out calibration_schema.json]
 *   node scripts/calibrate_analytic_rmxprt.mjs --run          # 需 ANSYS，否则拒绝
 *
 * 退出码：
 *   0  dry-run 成功 / 标定 schema 已写出
 *   2  请求 --run 但 ANSYS 不可用（守卫拦截）
 *   3  参数错误
 */

import { existsSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  doSaturationLoop, thermalCouplingLoop, muRFromB, carterFactor,
} from '../tools/l0/analytic-engine.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── 代表性标定样本（覆盖工频中低压异步 + PMSM 多机座）──
// 真值来源：designs.db / case_motors（Y 系列 + RUN 系列），由 RMxprt 精算。
const DESIGN_SWEEP = [
  { tag: 'Y160L-4', power_kw: 15, poles: 4, voltage: 380, speed: 1460, cooling: 'forced_air', stator_od: 260, stator_id: 170, core_length: 195, air_gap: 0.5, slots_stator: 36, turns_per_coil: 31 },
  { tag: 'Y160M-4', power_kw: 11, poles: 4, voltage: 380, speed: 1460, cooling: 'forced_air', stator_od: 260, stator_id: 170, core_length: 155, air_gap: 0.5, slots_stator: 36, turns_per_coil: 41 },
  { tag: 'Y180M-4', power_kw: 18.5, poles: 4, voltage: 380, speed: 1460, cooling: 'forced_air', stator_od: 290, stator_id: 187, core_length: 190, air_gap: 0.55, slots_stator: 48, turns_per_coil: 25 },
  { tag: 'Y200L-4', power_kw: 30, poles: 4, voltage: 380, speed: 1470, cooling: 'forced_air', stator_od: 327, stator_id: 210, core_length: 230, air_gap: 0.65, slots_stator: 48, turns_per_coil: 16 },
]

/**
 * ANSYS/RMxprt 可用性守卫：真实标定需要 ANSYS 可执行 + RMxprt 授权。
 * 沙箱无此环境，显式拒绝并说明，绝不静默跑空。
 */
function requiresAnsys() {
  const ansysDir = process.env.ANSYS_2023R1_DIR || process.env.ANSYS_DIR
  const rmxprt = process.env.RMXPRT_LICENSE_PATH
  const marker = process.env.RMXPRT_CALIB_ENABLED === '1'
  if (marker && ansysDir && rmxprt && existsSync(ansysDir)) return true
  return false
}

/** 写出标定 schema（dry-run）：声明扫描设计与待反算系数 */
function dryRun(outPath) {
  const schema = {
    generated_by: 'calibrate_analytic_rmxprt.mjs',
    mode: 'dry-run',
    note: '本 schema 描述 RMxprt 离线标定计划；真实标定需 ANSYS + RMxprt 授权（见 requiresAnsys 守卫）。',
    target_coefficients: {
      bh_curve: {
        consumed_by: 'doSaturationLoop (tools/l0/analytic-engine.mjs)',
        current_default: 'DW540-50 典型值（未标定）',
        extract_from: 'RMxprt 硅钢牌号 B-H 表（按设计硅钢等级逐设计反算）',
        output_file: 'lib/analytic-calib/bh_curve.json',
      },
      carter_factor: {
        consumed_by: 'carterFactor (tools/l0/analytic-engine.mjs)',
        current_default: 'Howe 简化闭式（未标定）',
        extract_from: 'RMxprt 开槽气隙磁导 vs 卡特解析解残差拟合',
        output_file: 'lib/analytic-calib/carter.json',
      },
      thermal_resistance: {
        consumed_by: 'thermalCouplingLoop (tools/l0/analytic-engine.mjs)',
        current_default: 'core estimateTempRise 单趟经验式',
        extract_from: 'RMxprt 稳态热网络（绝缘/铁/壳导热 + 散热系数）反算',
        output_file: 'lib/analytic-calib/thermal_rth.json',
      },
    },
    designs: DESIGN_SWEEP.map((d) => ({ ...d, expected_rmxprt_artifacts: ['FluxLinkage', 'LossSummary', 'ThermalMap'] })),
    validation: {
      metric: 'MAE(efficiency) analytic vs RMxprt',
      gate: '<= 1.5pt 且回退率 < 1%',
      post_calibration_action: '将 analytic_calibrated 置 true、confidence 由 0.5 上调至 0.8（提案 A-⑦）',
    },
  }
  if (outPath) {
    writeFileSync(resolve(__dirname, outPath), JSON.stringify(schema, null, 2), 'utf8')
    console.log(`[calibrate] dry-run schema 已写出 → ${outPath}`)
  }
  console.log(JSON.stringify(schema, null, 2))
  return 0
}

/** 真实标定（需 ANSYS） */
function realRun() {
  if (!requiresAnsys()) {
    console.error('[calibrate] 拒绝执行：ANSYS / RMxprt 不可用（沙箱无授权）。')
    console.error('[calibrate] 请在装有 ANSYS + RMxprt 的环境运行，并设置 ANSYS_DIR / RMXPXT_LICENSE_PATH / RMXPXT_CALIB_ENABLED=1。')
    console.error('[calibrate] 仅查看计划请加 --dry-run。')
    return 2
  }
  // 真实标定流程（占位，待 ANSYS 环境接入）：
  //   1. 对每个 DESIGN_SWEEP 设计生成 RMxprt 工程
  //   2. 求解后提取 B-H / 气隙磁导 / 热网络真值
  //   3. 反算并写 lib/analytic-calib/*.json
  //   4. 回灌 analytic-engine，跑验证门禁（MAE<=1.5pt）
  console.error('[calibrate] 真实标定流程尚未在沙箱实现（需 ANSYS 环境）。')
  return 2
}

// ── CLI 解析 ──
const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法: node scripts/calibrate_analytic_rmxprt.mjs [--dry-run|--run] [--out <path>]')
  process.exit(0)
}
const outIdx = args.indexOf('--out')
const outPath = outIdx >= 0 ? args[outIdx + 1] : 'calibration_schema.json'

if (args.includes('--run')) {
  process.exit(realRun())
}
// 默认 = dry-run
process.exit(dryRun(outPath))
