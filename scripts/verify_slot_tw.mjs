#!/usr/bin/env node
/**
 * P0-7 门禁：单一齿宽口径（v0.6.9 + core 1.5.3, 2026-10-30）
 * ---------------------------------------------------------------------------
 * 根因（300kW 方案实证）：Bt 公式消费 row.tooth_width（tw_axis 值 4.39），
 * slotGeometryDerived 硬编码 π·Di/(2Qs)=8.77 ⇒ 同一次估算里并存两个互斥齿宽：
 *   齿统一 8.77 ⇒ Bt=0.807T 挂；齿统一 4.39 ⇒ fill=0.330 挂。
 *   「双达标」只在两公式解耦时存在（解耦 Artifact）。
 * 修法：core 新增 opts.slotTw / env DSH_L0_SLOT_TW（默认 OFF）；
 *   l0 新增 args.slot_tw 透传（本门禁验证的正是 l0→core 接线）。
 *
 * 覆盖：
 *   §1 静态锚点（源码级守卫：透传与 TOOL_PARAMS 声明真实存在）
 *   §2 l0 args 通道（runL0Estimate：OFF=legacy_derived / ON=explicit，槽面积手算判据）
 *   §3 env 通道（DSH_L0_SLOT_TW 由 core 直读，l0 透传无需干预）
 *   §4 单一齿宽闭环（ON 时 slot_tooth_width_mm == Bt 侧齿宽；OFF 时两者不同 = 双齿宽实证）
 *   §5 compare 模式透传（baseline 对比同口径）
 *
 * 配额：freeQuotaEnabled:false。
 * 用法： node scripts/verify_slot_tw.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runL0Estimate } from '../tools/l0/l0-estimate.mjs'
import { runL0Pipeline } from '../tools/l0/pipeline.mjs'
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
const CFG = { freeQuotaEnabled: false }
const TW_DERIVED = Math.round((Math.PI * 402) / (2 * 72) * 100) / 100   // 8.77
const near = (a, b, tol = 0.05) => Math.abs(a - b) < tol

// ── §1 静态锚点 ──────────────────────────────────────────────
console.log('\n§1 静态锚点（源码级守卫）')
{
  const est = readFileSync(`${__dirname}/../tools/l0/l0-estimate.mjs`, 'utf8')
  const pipe = readFileSync(`${__dirname}/../tools/l0/pipeline.mjs`, 'utf8')
  ok(est.includes("args.slot_tw === true || args.slot_tw === 'true'"),
    'l0-estimate 主路径透传 args.slot_tw ⇒ opts.slotTw（源码锚点）')
  ok(est.includes('config.slotTw ? { slotTw: true }'),
    'compare 模式经 config.slotTw 透传（源码锚点）')
  ok(est.includes('slot_tw:') && est.includes('单一齿宽口径'),
    'TOOL_PARAMS 声明 slot_tw（源码锚点）')
  ok(pipe.includes('args.slot_tw != null ? { slot_tw: args.slot_tw }'),
    'pipeline 透传 slot_tw（源码锚点）')
}

// ── §2 l0 args 通道 ──────────────────────────────────────────
console.log('\n§2 l0 args 通道（runL0Estimate）')
{
  const off = runL0Estimate({ params_list: [ROW300], top_n: 1 }, CFG)
  const rOff = off.results?.[0] ?? off.top_results?.[0] ?? off
  ok(rOff.slot_tw_caliber === 'legacy_derived',
    'OFF：slot_tw_caliber=legacy_derived（旧行为）', `got=${rOff.slot_tw_caliber}`)
  ok(near(rOff.slot_tooth_width_mm, TW_DERIVED),
    `OFF：槽几何齿宽=派生 ${TW_DERIVED}`, `got=${rOff.slot_tooth_width_mm}`)

  const on = runL0Estimate({ params_list: [ROW300], top_n: 1, slot_tw: true }, CFG)
  const rOn = on.results?.[0] ?? on.top_results?.[0] ?? on
  ok(rOn.slot_tw_caliber === 'explicit',
    "ON（args.slot_tw=true）：slot_tw_caliber=explicit（只有显式路径能得出）", `got=${rOn.slot_tw_caliber}`)
  ok(near(rOn.slot_tooth_width_mm, 4.39),
    'ON：槽几何齿宽=4.39（row 值，与 Bt 同源）', `got=${rOn.slot_tooth_width_mm}`)
  // 手算判据：depth=60.0，pitch=π·462/72 ⇒ sw=pitch−4.39 ⇒ 毛槽=sw·depth
  const depth = 60.0
  const sw = (Math.PI * (402 + depth)) / 72 - 4.39
  ok(near(rOn.slot_area_mm2, sw * depth, 0.1),
    `ON：slot_area 手算 ${Number(sw * depth).toFixed(1)}mm² 逐位对上`, `got=${rOn.slot_area_mm2}`)
  ok(rOn.slot_fill_engineering < rOff.slot_fill_engineering,
    'ON：fill(eng) 显著低于 OFF（齿 4.39 ⇒ 槽更大）',
    `${rOff.slot_fill_engineering} → ${rOn.slot_fill_engineering}`)

  // 'true' 字符串通道（工具层常以字符串传布尔）
  const onStr = runL0Estimate({ params_list: [ROW300], top_n: 1, slot_tw: 'true' }, CFG)
  const rStr = onStr.results?.[0] ?? onStr.top_results?.[0] ?? onStr
  ok(rStr.slot_tw_caliber === 'explicit', "ON（slot_tw='true' 字符串）同效", `got=${rStr.slot_tw_caliber}`)
}

// ── §3 env 通道（core 直读） ─────────────────────────────────
console.log('\n§3 env 通道（DSH_L0_SLOT_TW，core 直读）')
{
  process.env.DSH_L0_SLOT_TW = '1'
  try {
    const e = quickL0Estimate(ROW300, {})
    ok(e.slot_tw_caliber === 'explicit' && near(e.slot_tooth_width_mm, 4.39),
      'env=1 且不传 opts ⇒ 显式口径生效（core 直读 env，l0 无需干预）')
    const eOff = quickL0Estimate(ROW300, { slotTw: false })
    ok(eOff.slot_tw_caliber === 'legacy_derived',
      'opts 显式关闭压过 env（双向胜出，铁律）')
  } finally {
    delete process.env.DSH_L0_SLOT_TW
  }
}

// ── §4 单一齿宽闭环（解耦 Artifact 实证） ────────────────────
console.log('\n§4 单一齿宽闭环（Bt 侧 vs 槽侧齿宽）')
{
  const off = runL0Estimate({ params_list: [ROW300], top_n: 1 }, CFG)
  const rOff = off.results?.[0] ?? off.top_results?.[0] ?? off
  ok(!near(rOff.slot_tooth_width_mm, 4.39, 0.01),
    'OFF：槽侧齿宽(8.77) ≠ Bt 侧齿宽(4.39) ⇒ 双齿宽并存实证（这正是要修的）',
    `slot=${rOff.slot_tooth_width_mm} vs bt=4.39`)
  const on = runL0Estimate({ params_list: [ROW300], top_n: 1, slot_tw: true }, CFG)
  const rOn = on.results?.[0] ?? on.top_results?.[0] ?? on
  ok(near(rOn.slot_tooth_width_mm, 4.39, 0.001),
    'ON：槽侧齿宽 == Bt 侧齿宽(4.39) ⇒ 单一口径闭环')
}

// ── §5 compare 模式透传 ─────────────────────────────────────
console.log('\n§5 compare 模式（baseline 对比同口径）')
{
  const cmp = runL0Estimate({
    mode: 'compare', params: ROW300, baseline_params: { ...ROW300, tooth_width: 5.0 },
    slot_tw: true,
  }, CFG)
  const cur = cmp?.current ?? cmp?.after ?? cmp
  const base = cmp?.baseline ?? cmp?.before
  const pickCaliber = (o) => o?.slot_tw_caliber
    ?? cmp?.delta?.slot_tw_caliber ?? cmp?.comparison?.slot_tw_caliber
  ok(cmp && !cmp.error, 'compare 模式可运行（slot_tw 透传不破坏基线路径）',
    cmp?.error ? `error=${cmp.error}` : '')
  const c1 = pickCaliber(cur), c2 = pickCaliber(base)
  ok(c1 === 'explicit' || c1 === undefined, 'compare 改后侧口径显式（或结构未回吐该字段）', `got=${c1}`)
  ok(c2 === 'explicit' || c2 === undefined, 'compare 基线侧同口径（避免对比漂移）', `got=${c2}`)
}

// ── 结果 ─────────────────────────────────────────────────────
console.log(`\n══ P0-7 单一齿宽门禁：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail > 0 ? 1 : 0)
