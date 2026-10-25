/**
 * 探针：L2 tw_axis 池 × §4-B 复合评分 —— 达标设计可检索性与分离度实测
 * ============================================================================
 * 目的（output/p2_top_ranking_1000_analysis.md §4-B 的实证收尾）：
 *   ① tw_axis ON 后，池内是否出现 EM0103 带宽 [1.4,1.7]T 达标的设计（OFF 时为 0 台）；
 *   ② 硬约束层（合规优先）+ 复合评分（固定锚点）能否把达标设计顶到 Top10；
 *   ③ 双口径记录 Bt（intent / actual）—— MD-SDE 读哪个口径未确认（L3 待办），
 *      两种口径都算达标数，避免把口径假设当结论。
 *
 * 规格：450kW/690V/985rpm/6极/H级/风冷/异步（复刻并行会话工况）
 * 配额：freeQuotaEnabled:false（本地探针不扣额度）
 *
 * 判据（本地可溯源）：
 *   EM0103 Bt ∈ [1.4,1.7]T；EM0105 By_actual < 1.5T（V08 预警线）；
 *   EM0106 fill_eng ≤ 0.78（V15 SLOT_FILL_MAX，工程槽满率口径）
 * 复合评分权重（工程优先级，报告 §4-B 推荐）：
 *   0.30·eff_n + 0.30·tr_n + 0.15·by_n + 0.15·bt_n + 0.10·fill_n
 *   （效率/温升为两大 KPI；磁密为安全约束（硬门兜底后的软裕度）；fill 为工艺约束）
 *   归一化用**固定锚点**而非池内 min/max —— 池内相对分会随池构成漂移，跨 run 不可比。
 */
import { buildParamMatrix } from '../tools/l0/param-matrix.mjs'
import { runDesignValidate } from '../tools/l0/design-validate.mjs'
import { runL0Estimate } from '../tools/l0/l0-estimate.mjs'

const SPEC = {
  power_kw: 450, speed_rpm: 985, voltage_v: 690, poles: 6,
  cooling: 'forced_air', insulation_class: 'H', motor_type: 'induction',
}
const CFG = { freeQuotaEnabled: false }
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const f = (v, d = 2) => (num(v) == null ? '-' : Number(v).toFixed(d))
const clamp01 = (x) => Math.max(0, Math.min(1, x))

// 判据带宽（本地可溯源）
const BT_LO = 1.4, BT_HI = 1.7, BT_CTR = 1.55
const BY_WARN = 1.5, BY_SEVERE = 1.7, BY_FLOOR = 1.2
const FILL_MAX = 0.78, FILL_FLOOR = 0.5
const EFF_LO = 92, EFF_HI = 96          // 用户目标 η≥92%；96=展示上限先例
const TR_GOOD = 70, TR_BAD = 125        // H 级温升限值 125K；70K=优
const W = { eff: 0.30, tr: 0.30, by: 0.15, bt: 0.15, fill: 0.10 }

function metricsOf(row) {
  return {
    od: num(row?.stator_od ?? row?.params?.stator_od),
    len: num(row?.core_length ?? row?.params?.core_length),
    poles: row?.poles ?? row?.params?.poles ?? null,
    qs: row?.slots_stator ?? row?.params?.slots_stator ?? null,
    tw: num(row?.tooth_width ?? row?.params?.tooth_width),
    eff: num(row?.efficiency_raw ?? row?.efficiency),
    tr: num(row?.temp_rise),
    btI: num(row?.tooth_flux_density),
    btA: num(row?.tooth_flux_density_actual),
    byA: num(row?.yoke_flux_density_actual ?? row?.yoke_flux_density),
    fill: num(row?.slot_fill_engineering ?? row?.slot_fill_ratio ?? row?.slot_fill?.ratio),
    feasible: row?.feasible ?? null,
    verdict: row?.verdict ?? null,
  }
}
const emOk = (m, btKey = 'btA') => num(m[btKey]) != null && m[btKey] >= BT_LO && m[btKey] <= BT_HI
  && num(m.byA) != null && m.byA < BY_WARN
  && num(m.fill) != null && m.fill <= FILL_MAX
const gateCount = (m) => [emOk(m, 'btA'), num(m.byA) != null && m.byA < BY_WARN,
  num(m.fill) != null && m.fill <= FILL_MAX, num(m.tr) != null && m.tr <= TR_BAD].filter(Boolean).length

function composite(m) {
  const effN = clamp01((m.eff - EFF_LO) / (EFF_HI - EFF_LO))
  const trN = 1 - clamp01((m.tr - TR_GOOD) / (TR_BAD - TR_GOOD))
  const byN = clamp01((BY_SEVERE - m.byA) / (BY_SEVERE - BY_FLOOR))
  const btN = 1 - clamp01(Math.abs(m.btA - BT_CTR) / (BT_HI - BT_CTR))
  const fillN = clamp01((FILL_MAX - m.fill) / (FILL_MAX - FILL_FLOOR))
  return {
    s: W.eff * effN + W.tr * trN + W.by * byN + W.bt * btN + W.fill * fillN,
    parts: { effN, trN, byN, btN, fillN },
  }
}
const rankKey = (m) => {
  const c = composite(m)
  return { gates: gateCount(m), score: c.s, ...c.parts }
}
const row = (m, rk) => `OD${f(m.od, 0)}/L${f(m.len, 0)}/${m.poles}P/Qs${m.qs} tw=${f(m.tw, 1)} eff=${f(m.eff, 2)} tr=${f(m.tr, 1)}K Bt_i=${f(m.btI)} Bt_a=${f(m.btA)} By_a=${f(m.byA)} fill=${f(m.fill)} G=${rk.gates} S=${f(rk.score, 3)}`

for (const twAxis of [false, true]) {
  const t0 = Date.now()
  const matrix = buildParamMatrix({ ...SPEC, count: 1000, ...(twAxis ? { tw_axis: true } : {}) }, CFG)
  const rows = matrix.matrix
  const validated = runDesignValidate({ params_list: rows }, CFG)
  const failed = new Set(validated.failed_indices ?? [])
  const feasibleRows = rows.filter((_, i) => !failed.has(i))
  const estAll = runL0Estimate({ params_list: feasibleRows, top_n: 0, sort_by: 'efficiency' }, CFG)
  const pool = (estAll.results ?? []).map(metricsOf)
  const okA = pool.filter((m) => emOk(m, 'btA'))
  const okI = pool.filter((m) => emOk(m, 'btI'))

  // 现行默认 Top10（效率序）
  const estTop = runL0Estimate({ params_list: feasibleRows, top_n: 10, sort_by: 'efficiency' }, CFG)
  const top10Eff = (estTop.results ?? []).map(metricsOf)

  // 推荐方案：硬约束层（合规数降序）→ 复合评分降序
  const ranked = pool.map((m) => ({ m, rk: rankKey(m) }))
    .sort((a, b) => b.rk.gates - a.rk.gates || b.rk.score - a.rk.score)
  const top10Rec = ranked.slice(0, 10)

  console.log(`\n${'='.repeat(78)}`)
  console.log(`tw_axis=${twAxis ? 'ON (targets [1.55,1.2])' : 'OFF (默认)'}｜生成 ${rows.length}｜可行池 ${pool.length}｜用时 ${Date.now() - t0}ms`)
  const btsA = pool.map((m) => m.btA).filter((v) => v != null)
  const btsI = pool.map((m) => m.btI).filter((v) => v != null)
  const tws = pool.map((m) => m.tw).filter((v) => v != null)
  console.log(`  池内 Bt_actual∈[${f(Math.min(...btsA))},${f(Math.max(...btsA))}]｜Bt_intent∈[${f(Math.min(...btsI))},${f(Math.max(...btsI))}]｜tw∈[${f(Math.min(...tws), 1)},${f(Math.max(...tws), 1)}]mm`)
  console.log(`  三项达标（actual 口径）：${okA.length} 台｜（intent 口径）：${okI.length} 台`)
  console.log(`  Top10(efficiency) 内达标：${top10Eff.filter((m) => emOk(m)).length} 台`)
  console.log(`  -- 现行 Top10(sort_by=efficiency) --`)
  for (const m of top10Eff) console.log(`   ${emOk(m) ? '★' : ' '} ${row(m, rankKey(m))}`)
  console.log(`  -- 推荐 Top10（合规数降序 → 复合评分）--`)
  for (const { m, rk } of top10Rec) console.log(`   ${emOk(m) ? '★' : ' '} ${row(m, rk)}`)
  if (okA.length) {
    console.log(`  -- 池内达标设计全量（前 5 台，actual 口径）--`)
    for (const m of okA.slice(0, 5)) console.log(`   ${row(m, rankKey(m))}`)
  }
}
