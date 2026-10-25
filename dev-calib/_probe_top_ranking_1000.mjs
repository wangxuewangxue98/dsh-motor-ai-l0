/**
 * 探针：count=1000（新默认）对候选池构成与 TOP10 截断效应的第一方复跑
 * ============================================================================
 * 背景：并行会话实证「count=1000 + sort_by:efficiency ⇒ Top10 全大机座高轭磁密，
 * 三项达标的小机座设计（615/54）被挤出返回集」。本探针在本地复跑该工况，
 * 定量区分两种机制：①设计未进可行池（网格/门禁层）②设计在池内被单键序截断（TOP 层）。
 *
 * 规格复刻：450kW/690V/985rpm/6极/风冷/H级（通风机异步电机）
 * 配额：freeQuotaEnabled:false（本地探针不扣免费额度；真实用户 1 次 pipeline 调用=1 次计数，
 *      与 count 大小无关——闸门按调用链计，不按候选数计）。
 *
 * EM 判据（仅用本地可溯源带宽）：
 *   EM0103 齿磁密 Bt ∈ [1.4,1.7]T（p2_tooth_stamp_rootcause_report.md §警告项）
 *   EM0105 轭磁密 By < 1.5T（V08 预警线 B_YOKE_WARN_T；实际口径 *_actual）
 *   EM0106 槽满率 fill ≤ 0.78（V15 门 SLOT_FILL_MAX；MD-SDE 侧下界未知，诚实标注）
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

function metricsOf(row) {
  return {
    od: num(row?.params?.stator_od ?? row?.stator_od),
    len: num(row?.params?.core_length ?? row?.core_length),
    poles: row?.params?.poles ?? null,
    eff: num(row?.efficiency_raw ?? row?.efficiency),
    tr: num(row?.temp_rise),
    bt: num(row?.tooth_flux_density),
    by: num(row?.yoke_flux_density_actual ?? row?.yoke_flux_density),
    fill: num(row?.slot_fill_ratio ?? row?.slot_fill?.ratio),
    feasible: row?.feasible ?? null,
    verdict: row?.verdict ?? null,
  }
}
// 三项达标（本地可溯源判据）
const emOk = (m) => num(m.bt) != null && m.bt >= 1.4 && m.bt <= 1.7
  && num(m.by) != null && m.by < 1.5
  && num(m.fill) != null && m.fill <= 0.78

const row = (m) => `OD${f(m.od, 0)}/L${f(m.len, 0)} eff=${f(m.eff, 2)} tr=${f(m.tr, 1)}K Bt=${f(m.bt)} By=${f(m.by)} fill=${f(m.fill)} v=${m.verdict}`

for (const count of [150, 1000]) {
  const t0 = Date.now()
  const matrix = buildParamMatrix({ ...SPEC, count }, CFG)
  const rows = matrix.matrix
  const validated = runDesignValidate({ params_list: rows }, CFG)
  const failed = new Set(validated.failed_indices ?? [])
  const feasibleRows = rows.filter((_, i) => !failed.has(i))

  // 全量行度量（top_n:0 ⇒ wantAll，与 Top10 同口径同函数）
  const estAll = runL0Estimate({ params_list: feasibleRows, top_n: 0, sort_by: 'efficiency' }, CFG)
  const pool = (estAll.results ?? []).map(metricsOf)
  const poolOk = pool.filter(emOk)

  // 现行默认 TOP10（efficiency）
  const estTop = runL0Estimate({ params_list: feasibleRows, top_n: 10, sort_by: 'efficiency' }, CFG)
  const top10 = (estTop.results ?? []).map(metricsOf)
  const top10Ok = top10.filter(emOk)

  // 对照：temp_rise 序 Top10（展示单键序如何整体翻转可见集）
  const estTr = runL0Estimate({ params_list: feasibleRows, top_n: 10, sort_by: 'temp_rise' }, CFG)
  const top10Tr = (estTr.results ?? []).map(metricsOf)

  console.log(`\n${'='.repeat(72)}`)
  console.log(`count=${count}｜生成 ${rows.length}｜validate ${validated.summary?.passed ?? 0}过/${validated.summary?.warning ?? 0}警/${validated.summary?.failed ?? 0}败｜可行池 ${feasibleRows.length}｜用时 ${Date.now() - t0}ms`)
  if ((matrix.warnings ?? []).length) console.log('矩阵告警:', JSON.stringify(matrix.warnings))
  console.log(`池内三项达标：${poolOk.length} 台｜Top10(efficiency) 内达标：${top10Ok.length} 台`)
  console.log(`  -- 现行 Top10(sort_by=efficiency) --`)
  for (const m of top10) console.log(`   ${emOk(m) ? '★' : ' '} ${row(m)}`)
  console.log(`  -- 池内达标设计全量（前三台）--`)
  for (const m of poolOk.slice(0, 3)) console.log(`   ${row(m)}`)
  console.log(`  -- 对照 Top10(sort_by=temp_rise) --`)
  for (const m of top10Tr.slice(0, 5)) console.log(`   ${emOk(m) ? '★' : ' '} ${row(m)}`)

  // ---- 三种增强排序方案原型（仅在探针内演算，不改插件）----
  const minmax = (arr, key) => {
    const vs = arr.map(key).filter((v) => v != null)
    const lo = Math.min(...vs), hi = Math.max(...vs)
    return (v) => (v == null || hi === lo ? 0 : (v - lo) / (hi - lo))
  }
  const nEff = minmax(pool, (m) => m.eff)
  const nTr = minmax(pool, (m) => m.tr)
  const nBy = minmax(pool, (m) => m.by)
  const nBt = minmax(pool, (m) => m.bt)
  const nFill = minmax(pool, (m) => m.fill)
  // 方案 A：合规优先（达标数降序 → 效率降序）
  const schemeA = [...pool].sort((a, b) => {
    const ca = [emOk(a), a.bt >= 1.4 && a.bt <= 1.7, a.by < 1.5, a.fill <= 0.78].filter(Boolean).length
    const cb = [emOk(b), b.bt >= 1.4 && b.bt <= 1.7, b.by < 1.5, b.fill <= 0.78].filter(Boolean).length
    return cb - ca || (b.eff ?? 0) - (a.eff ?? 0)
  })
  // 方案 B：复合评分（0.35 效率 + 0.25 低温升 + 0.20 By 带宽 + 0.20 Bt 带宽；fill 作门）
  const schemeB = [...pool].sort((a, b) => {
    const sa = 0.35 * nEff(a.eff) + 0.25 * (1 - nTr(a.tr)) + 0.20 * (1 - nBy(a.by)) + 0.20 * (1 - Math.abs(nBt(a.bt) - 0.5) * 2)
    const sb = 0.35 * nEff(b.eff) + 0.25 * (1 - nTr(b.tr)) + 0.20 * (1 - nBy(b.by)) + 0.20 * (1 - Math.abs(nBt(b.bt) - 0.5) * 2)
    return sb - sa
  })
  // 方案 C：分层配额（OD 三分位 → 桶内效率序 → 轮询取 10）
  const ods = pool.map((m) => m.od).filter((v) => v != null).sort((a, b) => a - b)
  const q1 = ods[Math.floor(ods.length / 3)], q2 = ods[Math.floor((2 * ods.length) / 3)]
  const buckets = [[], [], []]
  for (const m of pool) buckets[m.od <= q1 ? 0 : m.od <= q2 ? 1 : 2].push(m)
  for (const b of buckets) b.sort((x, y) => (y.eff ?? 0) - (x.eff ?? 0))
  const schemeC = []
  for (let i = 0; schemeC.length < 10 && i < Math.max(...buckets.map((b) => b.length)); i++) {
    for (const b of buckets) if (b[i]) schemeC.push(b[i])
  }
  const show = (name, list) => {
    const okN = list.slice(0, 10).filter(emOk).length
    const odsIn = list.slice(0, 10).map((m) => f(m.od, 0)).join('/')
    console.log(`  -- ${name}：Top10 达标 ${okN} 台｜OD 分布 ${odsIn}`)
  }
  show('方案A 合规优先', schemeA)
  show('方案B 复合评分', schemeB)
  show('方案C 分层配额', schemeC)
  console.log(`  方案A 首行: ${row(schemeA[0])}`)
  console.log(`  方案B 首行: ${row(schemeB[0])}`)
  console.log(`  方案C 首行: ${row(schemeC[0])}`)

  // ---- 汇总统计（报告用）----
  const ods2 = pool.map((m) => m.od).filter((v) => v != null)
  const topOds = top10.map((m) => m.od).filter((v) => v != null)
  const bts = pool.map((m) => m.bt).filter((v) => v != null)
  const fills = pool.map((m) => m.fill).filter((v) => v != null)
  const trs = pool.map((m) => m.tr).filter((v) => v != null)
  const estFeasible = pool.filter((m) => m.feasible === true).length
  console.log(`  [统计] 池 ${pool.length} 台｜estimate级可行(v=feasible) ${estFeasible} 台`
    + `｜Bt∈[${f(Math.min(...bts))},${f(Math.max(...bts))}]（EM0103 带 [1.4,1.7] 内 0 台）`
    + `｜fill∈[${f(Math.min(...fills))},${f(Math.max(...fills))}]`
    + `｜OD 池 [${f(Math.min(...ods2), 0)},${f(Math.max(...ods2), 0)}] vs Top10 [${f(Math.min(...topOds), 0)},${f(Math.max(...topOds), 0)}]`
    + `｜温升池 [${f(Math.min(...trs), 1)},${f(Math.max(...trs), 1)}]K`)
}
