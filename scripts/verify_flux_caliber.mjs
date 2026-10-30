#!/usr/bin/env node
/**
 * P0-8 门禁：磁密口径统一（齿部峰值）+ 匝数反标 k_E（v0.6.10 + core 1.5.4, 2026-10-31）
 * ---------------------------------------------------------------------------
 * 根因①（口径并存，300kW 方案 L1 实跑实证）：
 *   齿磁密 Bt = 2·Bg·Dsi/(Qs·tw·k) 的分子是每极磁通 Φ=(2/π)·B_peak·A_pole
 *   ⇒ 算出的是**极内平均**磁密；硅钢饱和限/RMxprt 报告/V08 的 1.9T 是**峰值** ⇒ 差 π/2。
 *   后果：窄齿方案实际深度饱和却显示"达标"（300kW：平均 1.61T ⇒ 峰值 2.53T，超限 33%）。
 * 根因②（匝数偏多）：turnsIdeal 按 E=Uph 反解，忽略定子漏抗压降。
 *   RMxprt 实测 k_E=E/Uph = 0.883(I=247A)/0.857(I=392A)。
 *
 * 本门禁验证的是 **l0 → core 的接线**（core 侧公式与真值同源性由 core 的
 * tests/flux-caliber.test.mjs 11/11 覆盖，此处不重复）。
 *
 * 覆盖：
 *   §1 静态锚点（l0-estimate / pipeline 的透传与 TOOL_PARAMS 声明真实存在）
 *   §2 l0 args 通道：tooth_peak_gate（默认 ON / 显式 false 静默）
 *   §3 l0 args 通道：back_emf_drop（默认 1.0 / 0.88 生效 / 非法值回落）
 *   §4 env 通道（DSH_L0_TOOTH_PEAK_GATE / DSH_L0_BACKEMF_DROP 由 core 直读）
 *   §5 pipeline 透传（三步链同口径）
 *   §6 300kW 实证锚点（峰值 2.53T 超饱和限 33%；k_E 反标 3.241→2.852）
 *
 * 🔴 门禁纪律：每个返回的声明体内必须有对应断言；开关必须 opts 与 env 双通道分别断言；
 *    取值路径必须构造"只有该路径能区分"的用例。
 * 配额：freeQuotaEnabled:false。用法： node scripts/verify_flux_caliber.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runL0Estimate } from '../tools/l0/l0-estimate.mjs'
import { runL0Pipeline } from '../tools/l0/pipeline.mjs'
import { runDesignValidate } from '../tools/l0/design-validate.mjs'
import { quickL0Estimate } from '@wangxue98/dsh-motor-ai-core'

let pass = 0, fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`) }
}
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROW300 = {
  stator_od: 602, stator_id: 402, rotor_od: 400, core_length: 640, air_gap: 1.02,
  tooth_width: 4.39, yoke_thickness: 39.6, shaft_dia: 140,
  poles: 6, voltage: 690, speed: 985, slots_stator: 72, slots_rotor: 28,
  turns_per_coil: 3, parallel_circuits: 2, power_kw: 300, torque_nm: 2909,
  cooling: 'forced_air', line_freq_hz: 50, insulation_class: 'H', motor_type: 'induction',
}
const WIDE = { ...ROW300, tooth_width: 8.77 }
const CFG = { freeQuotaEnabled: false }
const near = (a, b, tol = 0.05) => Math.abs(a - b) < tol
const PI2 = Math.PI / 2

// ── §1 静态锚点 ──────────────────────────────────────────────
console.log('\n§1 静态锚点（源码级守卫）')
{
  const est = readFileSync(`${__dirname}/../tools/l0/l0-estimate.mjs`, 'utf8')
  const pipe = readFileSync(`${__dirname}/../tools/l0/pipeline.mjs`, 'utf8')
  ok(est.includes('toothPeakGate: false') && est.includes("args.tooth_peak_gate === false"),
    'l0-estimate 主路径透传 args.tooth_peak_gate ⇒ opts.toothPeakGate（源码锚点）')
  ok(est.includes('config.toothPeakGate === false'),
    'compare 模式经 config.toothPeakGate 透传（源码锚点）')
  ok(est.includes('backEmfDrop: Number(args.back_emf_drop)') || est.includes('backEmfDrop: Number(config.backEmfDrop)'),
    'l0-estimate 透传 back_emf_drop ⇒ opts.backEmfDrop（源码锚点）')
  ok(est.includes('tooth_peak_gate:') && est.includes('back_emf_drop:'),
    'TOOL_PARAMS 声明 tooth_peak_gate / back_emf_drop（源码锚点）')
  ok(pipe.includes('args.tooth_peak_gate != null ? { tooth_peak_gate: args.tooth_peak_gate }')
    && pipe.includes('args.back_emf_drop != null ? { back_emf_drop: args.back_emf_drop }'),
    'pipeline 透传两个新参数（源码锚点）')
}

// ── §2 args 通道：齿部峰值门禁 ───────────────────────────────
console.log('\n§2 args 通道：tooth_peak_gate（默认 ON，显式 false 静默）')
{
  const on = runL0Estimate({ params_list: [ROW300], top_n: 1 }, CFG).results[0]
  const off = runL0Estimate({ params_list: [ROW300], top_n: 1, tooth_peak_gate: false }, CFG).results[0]
  ok(on.tooth_flux_density_peak != null, '默认回吐峰值字段（不声明参数也有）', `peak=${on.tooth_flux_density_peak}`)
  ok(near(on.tooth_flux_density_peak, on.tooth_flux_density_actual * PI2, 0.02),
    '峰值 = 平均 × π/2（恒等式）', `${on.tooth_flux_density_actual}×1.5708=${(on.tooth_flux_density_actual * PI2).toFixed(3)}`)
  ok(on.tooth_peak_sat === true, '窄齿 4.39mm ⇒ 峰值判饱和', `peak=${on.tooth_flux_density_peak}`)
  ok(on.yoke_flux_density_peak === on.yoke_flux_density_actual,
    '轭磁密峰值 == 实际值（轭式本身即峰值口径，禁止误乘 π/2）')
  ok(off.tooth_flux_density_peak === on.tooth_flux_density_peak,
    '开关只控告警、不改字段（OFF 时峰值字段仍回吐）')
  // 区分力断言：只有峰值口径能区分窄齿/宽齿的饱和状态
  const onWide = runL0Estimate({ params_list: [WIDE], top_n: 1 }, CFG).results[0]
  ok(onWide.tooth_peak_sat === false, '宽齿 8.77mm ⇒ 峰值未饱和（区分力）', `peak=${onWide.tooth_flux_density_peak}`)
  ok(on.tooth_flux_density_peak > onWide.tooth_flux_density_peak * 1.5,
    '窄齿峰值显著高于宽齿（方向正确）', `${on.tooth_flux_density_peak} vs ${onWide.tooth_flux_density_peak}`)
}

// ── §2b 告警侧区分力（design-validate 透传：只有它能观测 V07 峰值告警）──
// 🔴 教训：l0-estimate 的结果行不回吐规则告警，只断言"字段"无法发现透传被拆
//   （反向破坏 S1 首次未变红即此因）⇒ 必须走 design-validate 观测告警差异。
console.log('\n§2b 告警侧区分力（design-validate：tooth_peak_gate 影响 V07 峰值告警）')
{
  const peakIssue = (r) => (r?.issues ?? []).filter((i) => i.rule === 'V07' && /峰值/.test(i.msg))
  const vOn = runDesignValidate({ params: ROW300 }, CFG)
  const vOff = runDesignValidate({ params: ROW300, tooth_peak_gate: false }, CFG)
  ok(peakIssue(vOn).length === 1, 'design-validate 默认挂 V07 峰值告警', `n=${peakIssue(vOn).length}`)
  ok(peakIssue(vOff).length === 0, 'tooth_peak_gate=false ⇒ 峰值告警消失（透传生效）', `n=${peakIssue(vOff).length}`)
  const vWide = runDesignValidate({ params: WIDE }, CFG)
  ok(peakIssue(vWide).length === 0, '宽齿 8.77mm 不挂峰值告警（区分力）')
  // metrics 侧也回吐峰值（leverage_audit 用得上）
  ok(vOn?.metrics?.flux?.tooth_peak_t > 1.9, 'metrics.flux.tooth_peak_t 回吐峰值', `got=${vOn?.metrics?.flux?.tooth_peak_t}`)
  ok(vOff?.metrics?.flux?.tooth_peak_t === undefined, 'OFF 时 metrics 不回吐峰值（与开关一致）')
}

// ── §2c solve_turns 路径（probeRow 就地注入的观测面）──
console.log('\n§2c solve_turns：匝数反标 + Bg 口径差异披露')
{
  const st = runDesignValidate({ solve_turns: ROW300, back_emf_drop: 0.88 }, CFG)
  const e = st?.electrical ?? {}
  ok(Number.isFinite(e.turns_ideal), 'solve_turns 回吐理想匝数', `turns_ideal=${e.turns_ideal}`)
  ok(e.back_emf_drop_factor === 0.88, 'solve_turns 回吐 k_E=0.88（probeRow 就地注入生效）', `got=${e.back_emf_drop_factor}`)
  ok(Math.abs(e.turns_ideal_at_load - e.turns_ideal * 0.88) < 0.002,
    'solve_turns at_load = ideal × k_E', `${e.turns_ideal}×0.88=${(e.turns_ideal * 0.88).toFixed(3)}`)
  const st0 = runDesignValidate({ solve_turns: ROW300 }, CFG)
  ok(st0?.electrical?.back_emf_drop_factor === 1, '默认 k_E=1（零回归）')
  // 🔴 Bg 口径差异披露：solve_turns 用意图 Bg=0.8，l0-estimate 用分档 0.575
  const est = runL0Estimate({ params_list: [ROW300], top_n: 1 }, CFG).results[0]
  const ratio = est.turns_per_coil_ideal / e.turns_ideal
  ok(Math.abs(ratio - 0.8 / 0.575) < 0.02,
    '⚠ 两处理想匝数比值 = Bg 口径比 0.8/0.575（差异源是 Bg 目标，非公式错误）',
    `${est.turns_per_coil_ideal}/${e.turns_ideal}=${ratio.toFixed(3)} vs ${(0.8 / 0.575).toFixed(3)}`)
  ok(e.turns_ideal < 2.5,
    'solve_turns（Bg=0.8 口径）理想匝 2.329，接近 RMxprt 达标所需的 2 匝 ⇒ '
    + '300kW 出力不足的主因是 Bg 分档值偏低，须显式确认 Bg 口径', `got=${e.turns_ideal}`)
}

// ── §3 args 通道：匝数反标 k_E ───────────────────────────────
console.log('\n§3 args 通道：back_emf_drop（默认 1.0，0.88 生效，非法回落）')
{
  const d = runL0Estimate({ params_list: [ROW300], top_n: 1 }, CFG).results[0]
  const e = runL0Estimate({ params_list: [ROW300], top_n: 1, back_emf_drop: 0.88 }, CFG).results[0]
  ok(d.back_emf_drop_factor === 1, '默认 k_E=1.0（零回归）', `got=${d.back_emf_drop_factor}`)
  ok(d.turns_per_coil_ideal_at_load === d.turns_per_coil_ideal,
    '默认 at_load == ideal（未反标）', `${d.turns_per_coil_ideal} / ${d.turns_per_coil_ideal_at_load}`)
  ok(e.back_emf_drop_factor === 0.88, 'args 通道生效 k_E=0.88', `got=${e.back_emf_drop_factor}`)
  ok(near(e.turns_per_coil_ideal_at_load, e.turns_per_coil_ideal * 0.88, 0.005),
    'at_load = ideal × k_E', `${e.turns_per_coil_ideal}×0.88=${(e.turns_per_coil_ideal * 0.88).toFixed(3)}`)
  ok(e.back_emf_drop_ref === 0.88, '回显 RMxprt 实测参考值', `got=${e.back_emf_drop_ref}`)
  // 只回显不改写（零回归的核心断言）
  for (const k of ['turns_per_coil', 'tooth_flux_density_actual', 'efficiency', 'total_loss', 'temp_rise']) {
    ok(e[k] === d[k], `k_E 反标不改写 ${k}（只回显）`, `${d[k]} → ${e[k]}`)
  }
  const bad1 = runL0Estimate({ params_list: [ROW300], top_n: 1, back_emf_drop: 1.5 }, CFG).results[0]
  const bad2 = runL0Estimate({ params_list: [ROW300], top_n: 1, back_emf_drop: -1 }, CFG).results[0]
  ok(bad1.back_emf_drop_factor === 1 && bad2.back_emf_drop_factor === 1,
    '非法 k_E（>1 / ≤0）回落 1.0，绝不静默接受', `1.5→${bad1.back_emf_drop_factor}, -1→${bad2.back_emf_drop_factor}`)
}

// ── §4 env 通道（core 直读）──────────────────────────────────
console.log('\n§4 env 通道（DSH_L0_TOOTH_PEAK_GATE / DSH_L0_BACKEMF_DROP）')
{
  const prevG = process.env.DSH_L0_TOOTH_PEAK_GATE
  const prevE = process.env.DSH_L0_BACKEMF_DROP
  try {
    process.env.DSH_L0_TOOTH_PEAK_GATE = '0'
    const g = quickL0Estimate(ROW300, {})
    ok(g.tooth_flux_density_peak != null, 'env 关门禁时峰值字段仍回吐（字段恒有，与开关解耦）')
    process.env.DSH_L0_BACKEMF_DROP = '0.88'
    const e = quickL0Estimate(ROW300, {})
    ok(e.back_emf_drop_factor === 0.88, 'env 通道 k_E 生效', `got=${e.back_emf_drop_factor}`)
    ok(near(e.turns_per_coil_ideal_at_load, e.turns_per_coil_ideal * 0.88, 0.005),
      'env 与 args 通道同值（双通道一致）')
  } finally {
    if (prevG === undefined) delete process.env.DSH_L0_TOOTH_PEAK_GATE
    else process.env.DSH_L0_TOOTH_PEAK_GATE = prevG
    if (prevE === undefined) delete process.env.DSH_L0_BACKEMF_DROP
    else process.env.DSH_L0_BACKEMF_DROP = prevE
  }
}

// ── §5 pipeline 透传（三步链同口径）──────────────────────────
console.log('\n§5 pipeline 透传（三步链）')
{
  const base = {
    power_kw: 300, voltage: 690, speed: 985, poles: 6, frequency: 50,
    motor_type: 'induction', cooling: 'forced_air', insulation_class: 'H',
  }
  const p = runL0Pipeline({ ...base, count: 4, tooth_peak_gate: true, back_emf_drop: 0.88 }, CFG)
  const rows = p?.results ?? p?.top ?? []
  ok(rows.length > 0 && !p?.error, 'pipeline 可运行且回吐结果', p?.error ? `error=${p.error}` : `n=${rows.length}`)
  const r0 = rows[0]
  ok(r0?.tooth_flux_density_peak != null, 'pipeline 回吐峰值字段（透传生效）', `peak=${r0?.tooth_flux_density_peak}`)
  ok(r0?.back_emf_drop_factor === 0.88, 'pipeline 回吐 k_E=0.88（透传生效）', `got=${r0?.back_emf_drop_factor}`)
}

// ── §6 300kW 实证锚点 ────────────────────────────────────────
console.log('\n§6 300kW 实证锚点（与 L1 RMxprt 实跑结论同源）')
{
  const e = runL0Estimate({ params_list: [ROW300], top_n: 1 }, CFG).results[0]
  ok(e.tooth_flux_density_actual === 1.61, '平均口径 Bt=1.61T（报告值）', `got=${e.tooth_flux_density_actual}`)
  ok(e.tooth_flux_density_peak === 2.53, '峰值口径 Bt=2.53T', `got=${e.tooth_flux_density_peak}`)
  ok(near(e.tooth_flux_density_peak / 1.9, 1.332, 0.01), '超硅钢饱和限 33%', `ratio=${(e.tooth_flux_density_peak / 1.9).toFixed(3)}`)
  ok(e.flux_density_caliber === 'peak_and_pole_mean_dual', '口径标注字段存在', `got=${e.flux_density_caliber}`)
  const e2 = runL0Estimate({ params_list: [ROW300], top_n: 1, back_emf_drop: 0.88 }, CFG).results[0]
  ok(near(e2.turns_per_coil_ideal, 3.241, 0.002), '理想匝数 3.241（E=Uph 口径）', `got=${e2.turns_per_coil_ideal}`)
  ok(near(e2.turns_per_coil_ideal_at_load, 2.852, 0.005), '反标后 2.852 匝（k_E=0.88）', `got=${e2.turns_per_coil_ideal_at_load}`)
  ok(e2.turns_per_coil_ideal_at_load > 2.0,
    '⚠ 反标后仍 >2 匝：与 RMxprt 达标所需的 2 匝仍有差距 ⇒ 主因是 Bg 目标 0.575 < 所需 ~0.78T，'
    + 'k_E 仅解释其中约 5%，绝对出力必须由 L1 实跑确认', `at_load=${e2.turns_per_coil_ideal_at_load}`)
}

console.log(`\n══ P0-8 磁密口径/匝数反标门禁：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail > 0 ? 1 : 0)
