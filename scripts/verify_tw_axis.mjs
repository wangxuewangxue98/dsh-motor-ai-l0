#!/usr/bin/env node
/**
 * L2 门禁：tooth_width 候选维度（v0.6.7, 2026-10-25）
 * ---------------------------------------------------------------------------
 * 背景（output/p2_top_ranking_1000_analysis.md 第一方复跑）：默认池每行 tooth_width
 * 恒为派生值 0.5×槽距 ⇒ Bt = 4·Bg/(π·k_stack)（Qs/Di 精确约掉）⇒ 450kW 实测池内
 * Bt∈[0.72,0.81]T，而 EM0103 带宽 [1.4,1.7]T —— 达标设计在池内**不存在**。
 * 本维度把 tooth_width 显式通道矩阵化（每行追加齿宽档），门禁验证：
 *
 *   §1 静态锚点（源码级守卫，防"判据被删文案还在"）
 *   §2 解析器纯函数（开关三态 / factors 优先 / 钳位 / 过滤）
 *   §3 矩阵结构（OFF 零回归 / ON 行数精确=count / 控制档 / 因子表 / maxMatrixSize）
 *   §4 env 与 opts 双通道分别断言（含 opts 双向胜出——记忆铁律：返回串声称的
 *      每个通道必须在体内有实体断言，防虚假声明）
 *   §5 下游响应（控制档估计 == OFF 同行 ⇒ 零回归锚点；变体档 Bt ≈ 控制档/f
 *      逐位响应；引擎 Bt 反绑 ⇒ 矩阵侧 Bg 查找与引擎同源）
 *   §6 pipeline 集成（整链透传 + count 预算保持 + 告警可见）
 *
 * 配额：freeQuotaEnabled:false（本地门禁不扣免费额度；配额闸本身由 verify.mjs 覆盖）。
 * 用法： node scripts/verify_tw_axis.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildParamMatrix, resolveTwAxis, twAxisFactorFor,
  TW_AXIS_FACTOR_MIN, TW_AXIS_FACTOR_MAX,
} from '../tools/l0/param-matrix.mjs'
import { runDesignValidate } from '../tools/l0/design-validate.mjs'
import { runL0Pipeline } from '../tools/l0/pipeline.mjs'
import { quickL0Estimate, AIR_GAP_FLUX_BY_POLES, AIR_GAP_FLUX_DEFAULT, STACKING_FACTOR } from '@wangxue98/dsh-motor-ai-core'

let pass = 0, fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`) }
}

const SPEC = {
  power_kw: 450, speed_rpm: 985, voltage_v: 690, poles: 6,
  cooling: 'forced_air', insulation_class: 'H', motor_type: 'induction',
}
const CFG = { freeQuotaEnabled: false }
const ENV_TW_AXIS = 'DSH_L0_TW_AXIS'
const f2 = (v) => (Number.isFinite(v) ? Number(v).toFixed(2) : '-')
const f4 = (v) => (Number.isFinite(v) ? Number(v).toFixed(4) : '-')
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol
// ⚠ geoKey 必须含电气参数：od 夹紧可把多个 d 值映射到同一 (od, dEff)、fitLambda
//   可把多个 l 值映射到同一铁心长 ⇒ 同几何行对因 comboIndex 轮询而并联支路不同
//   （矩阵既有行为）。只用几何键会把不同 turns/parallels 的行错配成孪生行。
const geoKey = (r) => `${r.stator_od}|${r.stator_id}|${r.core_length}|${r.slots_stator}|${r.slots_rotor}|${r.poles}|${r.parallel_circuits}|${r.turns_per_coil}`
const derivedTw = (r) => Math.round((Math.PI * r.stator_id) / (2 * r.slots_stator) * 100) / 100

// ═════════════════════════════════════════════════════════════
console.log('\n=== §1 静态锚点（源码级守卫） ===\n')
const srcPath = fileURLToPath(new URL('../tools/l0/param-matrix.mjs', import.meta.url))
const src = readFileSync(srcPath, 'utf8')
ok(src.includes(': envOnLocal(process.env[ENV_TW_AXIS], false)'),
  '① 默认 OFF 锚点在位（spec 缺省时走 env 且 env 缺省 false）')
ok(src.includes('clamp(f, TW_AXIS_FACTOR_MIN, TW_AXIS_FACTOR_MAX)'),
  '② 物理下限钳位锚点在位（f 钳 [MIN,MAX]）')
ok(src.includes('TW_AXIS_FACTOR_MIN = 0.5'),
  '③ 下限值锚点在位（0.5×派生 ⇒ 齿宽≥0.25×槽距）')
ok(src.includes('if (twAxis.on && matrix.length > count) matrix = matrix.slice(0, count)'),
  '④ 预算截断锚点在位（展开后截回 count）')
ok(src.includes('tooth_width: round2(v.factor * twBase)'),
  '⑤ 展开赋值锚点在位（齿宽=乘子×派生齿宽）')

// ═════════════════════════════════════════════════════════════
console.log('\n=== §2 解析器（resolveTwAxis 纯函数） ===\n')
ok(resolveTwAxis({}).on === false, '⑥ spec 缺省 ⇒ OFF')
ok(resolveTwAxis({ tw_axis: true }).on === true
  && JSON.stringify(resolveTwAxis({ tw_axis: true }).targets) === '[1.55,1.2]'
  && resolveTwAxis({ tw_axis: true }).k === 3,
  '⑦ tw_axis:true ⇒ ON，默认目标 [1.55,1.2]，k=3（1 控制档+2 目标档）')
ok(resolveTwAxis({ tw_axis: 'true' }).on === true, '⑧ 字符串 "true" 亦认（与 filter_undersized 先例一致）')
const fac = resolveTwAxis({ tw_axis: true, tw_axis_factors: [0.5, 0.9] })
ok(fac.mode === 'factors' && JSON.stringify(fac.factors) === '[0.5,0.9]' && fac.k === 2,
  '⑨ factors 显式模式：乘子原样落地，k=2')
ok(JSON.stringify(resolveTwAxis({ tw_axis: true, tw_axis_factors: [0.3, 1.4] }).factors) === '[0.5,1]',
  '⑩ factors 钳位：0.3→0.5（物理下限）、1.4→1.0（无工程价值上限）')
const both = resolveTwAxis({ tw_axis: true, tw_axis_targets: [1.6], tw_axis_factors: [0.7] })
ok(both.mode === 'factors' && JSON.stringify(both.factors) === '[0.7]',
  '⑪ factors 优先于 targets（显式低阶旋钮胜出）')
ok(resolveTwAxis({ tw_axis: true, tw_axis_factors: ['x', -1] }).mode === 'targets',
  '⑫ factors 全非法 ⇒ 回退 targets 模式（不静默失效）')
ok(resolveTwAxis({ tw_axis: true, tw_axis_targets: [1.6] }).k === 2
  && resolveTwAxis({ tw_axis: true, tw_axis_targets: [] }).k === 3,
  '⑬ 自定义目标生效；空目标列表回退默认')
ok(resolveTwAxis({ tw_axis: false }).on === false, '⑭ tw_axis:false 显式关闭')

// ═════════════════════════════════════════════════════════════
console.log('\n=== §3 矩阵结构（450kW，count=1000） ===\n')
const off = buildParamMatrix({ ...SPEC, count: 1000 }, CFG)
const on = buildParamMatrix({ ...SPEC, count: 1000, tw_axis: true }, CFG)
ok(off.matrix.length === 1000 && on.matrix.length === 1000,
  '⑮ OFF/ON 行数均精确 = count=1000', `off=${off.matrix.length} on=${on.matrix.length}`)
ok(on.truncated === false && on.total === 1000 && on.returned === 1000,
  '⑯ ON 无截断（展开 ≈count±K-1 后截回，truncated=false）',
  `total=${on.total} truncated=${on.truncated}`)
ok(off.matrix.every((r) => !r._physics?.tw_axis) && off.tw_axis.on === false,
  '⑰ OFF 零回归：无行携带 tw_axis meta，返回 meta.on=false')
ok(off.matrix.every((r) => Math.abs(r.tooth_width - derivedTw(r)) < 1e-9),
  '⑱ OFF 零回归：每行 tooth_width 恒等于派生值 0.5×槽距')
ok(off.warnings.every((w) => w.code !== 'TW_AXIS_ACTIVE'),
  '⑲ OFF 无 TW_AXIS_ACTIVE 告警（默认路径告警集合不变）')
ok(on.matrix.every((r) => r._physics?.tw_axis && Number.isFinite(r._physics.tw_axis.factor)
  && r._physics.tw_axis.factor >= TW_AXIS_FACTOR_MIN && r._physics.tw_axis.factor <= TW_AXIS_FACTOR_MAX),
  '⑳ ON 每行都有合法 tw_axis meta（factor∈[MIN,MAX]）')
const ctlRows = on.matrix.filter((r) => r._physics.tw_axis.factor === 1)
ok(ctlRows.length === 334 && ctlRows.every((r) => r._physics.tw_axis.target_t === null
  && Math.abs(r.tooth_width - derivedTw(r)) < 1e-9),
  '㉑ 控制档=派生齿宽且数量=ceil(1000/3)=334（同口径自证）', `n=${ctlRows.length}`)
// 因子表：与 twAxisFactorFor 逐位一致（同口径重算）
let factorTableOk = true
const byPoleSeen = {}
for (const r of on.matrix) {
  const p = r.poles
  byPoleSeen[p] ??= new Set()
  byPoleSeen[p].add(r._physics.tw_axis.factor)
  const expected = r._physics.tw_axis.target_t == null
    ? 1
    : twAxisFactorFor({ poles: p, motorType: r.motor_type, targetBt: r._physics.tw_axis.target_t })
  if (!near(r._physics.tw_axis.factor, expected, 1e-9)) factorTableOk = false
}
ok(factorTableOk, '㉒ 每行 factor 与 twAxisFactorFor 同口径重算逐位一致')
ok(byPoleSeen[4].size === 3 && byPoleSeen[6].size === 3 && byPoleSeen[8].size === 3,
  '㉓ 各极数档位数=3（1 控制+2 目标）', JSON.stringify(Object.fromEntries(Object.entries(byPoleSeen).map(([k, v]) => [k, [...v].sort()]))))
ok(near(on.tw_axis.factors_by_pole[6][1], twAxisFactorFor({ poles: 6, motorType: 'induction', targetBt: 1.55 }), 1e-9)
  && on.tw_axis.factors_by_pole[6][1] < on.tw_axis.factors_by_pole[6][2],
  '㉔ 返回 meta 的 factors_by_pole 正确（目标越高乘子越小：1.55→0.50 < 1.2→0.62）',
  JSON.stringify(on.tw_axis.factors_by_pole))
ok(on.warnings.some((w) => w.code === 'TW_AXIS_ACTIVE' && w.factors_by_pole),
  '㉕ TW_AXIS_ACTIVE 告警可见且带各极乘子表')
// maxMatrixSize / strictMaxMatrixSize 不因轴抛错
let strictThrew = false
try {
  buildParamMatrix({ ...SPEC, count: 1000, tw_axis: true }, { ...CFG, maxMatrixSize: 2000, strictMaxMatrixSize: true })
} catch { strictThrew = true }
ok(!strictThrew, '㉖ strictMaxMatrixSize=true + count=1000 ≤ 2000 ⇒ 不抛错（预算保持的直接后果）')

// ═════════════════════════════════════════════════════════════
console.log('\n=== §4 env 与 opts 双通道（分别断言 + opts 双向胜出） ===\n')
const withEnv = (v, fn) => {
  const prev = process.env[ENV_TW_AXIS]
  if (v === undefined) delete process.env[ENV_TW_AXIS]
  else process.env[ENV_TW_AXIS] = v
  try { return fn() } finally {
    if (prev === undefined) delete process.env[ENV_TW_AXIS]
    else process.env[ENV_TW_AXIS] = prev
  }
}
ok(withEnv('1', () => buildParamMatrix({ ...SPEC, count: 30 }, CFG).tw_axis.on === true),
  '㉗ env DSH_L0_TW_AXIS=1 ⇒ 轴开启（spec 未传）')
ok(withEnv('1', () => buildParamMatrix({ ...SPEC, count: 30, tw_axis: false }, CFG).tw_axis.on === false),
  '㉘ env=1 + opts=false ⇒ 关闭（opts 胜出，防 env 静默吞）')
ok(withEnv('0', () => buildParamMatrix({ ...SPEC, count: 30, tw_axis: true }, CFG).tw_axis.on === true),
  '㉙ env=0 + opts=true ⇒ 开启（opts 胜出，防 env 静默吞）')
ok(withEnv('0', () => buildParamMatrix({ ...SPEC, count: 30 }, CFG).tw_axis.on === false),
  '㉚ env=0 ⇒ 关闭')
ok(withEnv(undefined, () => buildParamMatrix({ ...SPEC, count: 30 }, CFG).tw_axis.on === false),
  '㉛ env 缺省 ⇒ 关闭（默认 OFF 零回归）')
const envOn = withEnv('1', () => buildParamMatrix({ ...SPEC, count: 30 }, CFG))
ok(envOn.matrix.length === 30 && envOn.matrix.every((r) => r._physics?.tw_axis),
  '㉜ env 通道开启后矩阵结构与 opts 通道一致（行数+meta）')

// ═════════════════════════════════════════════════════════════
console.log('\n=== §5 下游响应（估计链逐位验证） ===\n')
// OFF count=30 与 ON count=90 的基础网格同预算（30）⇒ 控制档与 OFF 行同几何
const off30 = buildParamMatrix({ ...SPEC, count: 30 }, CFG)
const on90 = buildParamMatrix({ ...SPEC, count: 90, tw_axis: true }, CFG)
ok(on90.matrix.length === 90 && on90.matrix.filter((r) => r._physics.tw_axis.factor === 1).length === 30,
  '㉝ count=90 展开：30 基础行 × 3 档 = 90（控制档 30 个）')
const offByGeo = new Map(off30.matrix.map((r) => [geoKey(r), r]))
const ctl90 = on90.matrix.filter((r) => r._physics.tw_axis.factor === 1)
const est = (r) => { try { return quickL0Estimate(r, {}) } catch { return null } }
const METRICS = ['efficiency_raw', 'temp_rise', 'tooth_flux_density', 'tooth_flux_density_actual',
  'yoke_flux_density_actual', 'slot_fill_engineering', 'feasible']
let zeroRegOk = true, compared = 0
for (const c of ctl90) {
  const o = offByGeo.get(geoKey(c))
  if (!o) { zeroRegOk = false; continue }
  const eo = est(o), ec = est(c)
  if (!eo || !ec) { zeroRegOk = false; continue }
  compared++
  for (const m of METRICS) {
    if (JSON.stringify(eo[m]) !== JSON.stringify(ec[m])) { zeroRegOk = false; break }
  }
}
ok(zeroRegOk && compared === 30,
  '㉞ 零回归锚点：ON 的控制档行估计与 OFF 同行七项指标逐位一致',
  `compared=${compared}/30`)
// 变体档 Bt ≈ 控制档/f（逐位响应，同口径重算）
let btRespOk = true, btChecked = 0, btMaxSeen = 0
for (const v of on90.matrix) {
  if (v._physics.tw_axis.factor === 1) continue
  const c = ctl90.find((x) => geoKey(x) === geoKey(v))
  if (!c) { btRespOk = false; continue }
  const ev = est(v), ec2 = est(c)
  if (!ev || !ec2) { btRespOk = false; continue }
  const f = v._physics.tw_axis.factor
  if (!near(ev.tooth_flux_density, ec2.tooth_flux_density / f, 0.02)
    || !near(ev.tooth_flux_density_actual, ec2.tooth_flux_density_actual / f, 0.02)) btRespOk = false
  btMaxSeen = Math.max(btMaxSeen, ev.tooth_flux_density_actual ?? 0)
  btChecked++
}
ok(btRespOk && btChecked === 60,
  '㉟ 变体档逐位响应：意图/实际口径 Bt 均 ≈ 控制档/f（容差 0.02=round2 累积）',
  `checked=${btChecked}/60`)
ok(btMaxSeen <= 1.8,
  '㊱ 默认档位下变体 Bt ≤ 1.8T（解析齿饱和线，工程裕度）', `max=${f2(btMaxSeen)}`)
// 引擎反绑：控制档 tooth_flux_density == 4·bg/(π·k_stack)（矩阵侧 Bg 查找与引擎同源）
let bgTieOk = true, bgTieN = 0
for (const c of ctl90) {
  const ec3 = est(c)
  if (!ec3) { bgTieOk = false; continue }
  const bg = AIR_GAP_FLUX_BY_POLES.induction?.[c.poles] ?? AIR_GAP_FLUX_DEFAULT
  const expect = Math.round((4 * bg) / (Math.PI * STACKING_FACTOR) * 100) / 100
  if (!near(ec3.tooth_flux_density, expect, 0.011)) bgTieOk = false
  bgTieN++
}
ok(bgTieOk && bgTieN === 30,
  '㊲ 引擎反绑：控制档 tooth_flux_density == 4·Bg_分档/(π·k_stack)（矩阵侧 Bg 查找与引擎同源，防双源漂移）',
  `n=${bgTieN}`)
// validate 不因变体抛错
let valOk = true
try {
  const v = runDesignValidate({ params_list: on90.matrix }, CFG)
  const s = v.summary ?? {}
  valOk = (s.passed ?? 0) + (s.warning ?? 0) + (s.failed ?? 0) === on90.matrix.length
} catch { valOk = false }
ok(valOk, '㊳ design-validate 对变体池不抛错且计数自洽（passed+warning+failed=generated）')

// ═════════════════════════════════════════════════════════════
console.log('\n=== §6 pipeline 集成（整链透传） ===\n')
const pOn = runL0Pipeline({ ...SPEC, count: 30, tw_axis: true, write_handoff: false }, CFG)
ok(pOn.summary?.generated === 30 && pOn.summary?.truncated === false && pOn.summary?.count_ok === true
  && (pOn.warnings ?? []).some((w) => w.code === 'TW_AXIS_ACTIVE'),
  '㊴ pipeline(tw_axis:true)：generated=30 无截断且 TW_AXIS_ACTIVE 告警透传',
  `generated=${pOn.summary?.generated} count_ok=${pOn.summary?.count_ok}`)
const pOff = runL0Pipeline({ ...SPEC, count: 30, write_handoff: false }, CFG)
ok(pOff.summary?.generated === 30 && pOff.summary?.count_ok === true
  && !(pOff.warnings ?? []).some((w) => w.code === 'TW_AXIS_ACTIVE'),
  '㊵ pipeline 默认路径：无轴告警、计数自洽（零回归）')

// ═════════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(60)}`)
console.log(`L2 tw_axis 门禁: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
