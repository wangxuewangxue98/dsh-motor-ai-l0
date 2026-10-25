/**
 * P2-A 绕组锁定（winding-lock）门禁
 * 覆盖：默认 OFF / env 通道 / opts 通道 / 零回归锚点 / 公式自证 /
 *       入参消费 / kw_eff 双通道 / 新字段登记 / 65 台真值验收门。
 * 运行：node scripts/verify_winding_lock.mjs
 */
import { quickL0Estimate, deriveElectricalClosure, windingLockOn, kwEffOf, KW_EFF_DEFAULT } from '@wangxue98/dsh-motor-ai-core'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TRUTH_PATH = fileURLToPath(new URL('../output/p2_real_truth.json', import.meta.url))

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✅ ${name}${detail ? ' | ' + detail : ''}`) }
  else { fail++; console.log(`❌ ${name}${detail ? ' | ' + detail : ''}`) }
}

// ── 锚点行（Y801-2 真实参数，65 台真值集首行）──
const ROW = {
  stator_od: 132, stator_id: 76, air_gap: 0.4, slots_stator: 18, poles: 2,
  voltage: 380, speed: 2820, core_length: 90, power_kw: 2.2,
  motor_type: 'induction', conductors_per_slot: 144, turns_per_coil: 144,
  parallel_circuits: 1,
}

console.log('═══ P2-A 绕组锁定门禁 ═══\n')

// 1. 默认 OFF
ok('默认 OFF（windingLockOn({})===false）', windingLockOn({}) === false)
ok('kwEff 默认 = 0.697', Math.abs(kwEffOf({}) - 0.697) < 1e-9 && KW_EFF_DEFAULT === 0.697)

// 2. env 通道
process.env.DSH_L0_WINDING_LOCK = '1'
const eEnv = quickL0Estimate(ROW, {})
ok('env 通道：DSH_L0_WINDING_LOCK=1 ⇒ lock 生效', eEnv.winding_lock === true,
  `wl=${eEnv.winding_lock} bgL=${eEnv.bg_locked_t}`)
delete process.env.DSH_L0_WINDING_LOCK

// 3. opts 通道
const eOn = quickL0Estimate(ROW, { windingLock: true })
ok('opts 通道：windingLock=true ⇒ lock 生效', eOn.winding_lock === true,
  `bgL=${eOn.bg_locked_t}`)

// 4. 零回归锚点（lock OFF 时关键字段与历史值一致）
const eOff = quickL0Estimate(ROW, {})
ok('零回归：lock OFF 时 winding_lock=false 且 bg_locked=null',
  eOff.winding_lock === false && eOff.bg_locked_t === null)
ok('零回归：lock OFF 时 Bg_eff 保持旧路径（≈0.79 附近，非 0.325）',
  Math.abs(eOff.air_gap_flux_density_effective - 0.325) > 0.1,
  `Bg_eff=${eOff.air_gap_flux_density_effective}`)

// 5. 公式自证（同口径重算 bg_locked）
{
  const { voltage, speed, poles, stator_id: Di, core_length: L, slots_stator: Qs, parallel_circuits: a, conductors_per_slot: cps } = ROW
  const f = (speed * poles) / 120
  const uph = voltage / Math.sqrt(3)
  const N = ((cps / 2) * Qs) / (3 * a)
  const Ag = (Math.PI * (Di / 1000) * (L / 1000)) / poles   // 极距面积 = π·Di·L/poles（= π·Di·L/(2pp)）
  const bgCalc = uph / (4.44 * f * N * 0.697 * Ag)
  ok('公式自证：bg_locked == Uph/(4.44·f·N·kw·Ag)（Δ<0.5%）',
    Math.abs(eOn.bg_locked_t - bgCalc) / bgCalc < 0.005,
    `输出=${eOn.bg_locked_t} 重算=${bgCalc.toFixed(4)}`)
}

// 6. 入参消费（turns 输出入参值而非重算值）
ok('入参消费：lock ON 时 turns_per_coil=72（=cps/2，非重算 34）', eOn.turns_per_coil === 72,
  `turns=${eOn.turns_per_coil}`)
ok('入参消费：lock OFF 时 turns_per_coil=34（重算值不变）', eOff.turns_per_coil === 34,
  `turns=${eOff.turns_per_coil}`)

// 7. kw_eff 双通道
{
  const eOpts = quickL0Estimate(ROW, { windingLock: true, kwEff: 0.9 })
  ok('kwEff opts 通道：kw_eff_used=0.9 且 Bg 按 1/kw 缩放',
    eOpts.kw_eff_used === 0.9 && Math.abs(eOpts.bg_locked_t - eOn.bg_locked_t * 0.697 / 0.9) < 0.005,
    `bgL=${eOpts.bg_locked_t}`)
  process.env.DSH_L0_KW_EFF = '0.9'
  const eEnvKw = quickL0Estimate(ROW, { windingLock: true })
  ok('kwEff env 通道：DSH_L0_KW_EFF=0.9 生效', eEnvKw.kw_eff_used === 0.9,
    `kw=${eEnvKw.kw_eff_used}`)
  delete process.env.DSH_L0_KW_EFF
}

// 8. 新字段透传（行为断言：防 buildL0Result 白名单过滤 —— 比静态读白名单更终态）
{
  const need = ['winding_lock', 'bg_locked_t', 'kw_eff_used', 'air_gap_flux_density_effective']
  const missing = need.filter((f) => eOn[f] === undefined)
  ok('新字段透传：4 个新字段均出现在 lock ON 输出（白名单未过滤）',
    missing.length === 0,
    missing.length ? `缺失 ${missing.join(',')}` : 'winding_lock/bg_locked_t/kw_eff_used/air_gap_flux_density_effective')
}

// 9. closure 直连回显
{
  const c = deriveElectricalClosure({
    voltage: 380, speed: 2820, poles: 2, statorId: 76, coreLength: 90, slotsStator: 18,
    parallelCircuits: 1, airGapFlux: 0.8, powerKw: 2.2,
    windingLock: true, turnsPerCoilIn: 144, conductorsPerSlotIn: 144, kwEff: 0.697,
  })
  ok('closure 回显：winding_lock/n_phase_locked/turns_per_coil_locked 三字段齐',
    c.winding_lock === true && c.n_phase_locked === 432 && c.turns_per_coil_locked === 72,
    JSON.stringify({ wl: c.winding_lock, npl: c.n_phase_locked, tpcL: c.turns_per_coil_locked }))
}

// 10. 65 台真值验收门（Bg MAPE<10% 且 pearson>0.9）
{
  try {
    const truth = JSON.parse(readFileSync(TRUTH_PATH, 'utf8')).rows
    const on = [], tru = []
    for (const r of truth) {
      if (!r.solve_ok) continue
      const i = r.inputs
      const e = quickL0Estimate({
        stator_od: i.stator_od, stator_id: i.stator_id, air_gap: i.air_gap,
        slots_stator: i.slots_stator, poles: i.poles, voltage: i.voltage,
        speed: i.speed ?? i.speed_rpm, core_length: i.core_length,
        power_kw: i.power ?? i.power_kw, motor_type: 'induction',
        yoke_thickness: i.yoke_thickness,
        turns_per_coil: i.turns_per_coil, conductors_per_slot: i.conductors_per_slot,
        parallel_circuits: i.parallel_circuits ?? 1,
      }, { windingLock: true })
      const bgT = Number(r.rmxprt?.air_gap_flux_density)
      if (Number.isFinite(bgT) && e.winding_lock) { on.push(e.bg_locked_t); tru.push(bgT) }
    }
    const mape = on.reduce((s, x, k) => s + Math.abs(x / tru[k] - 1), 0) / on.length * 100
    const n = on.length, mx = on.reduce((a, b) => a + b, 0) / n, my = tru.reduce((a, b) => a + b, 0) / n
    const sxy = on.reduce((s, a, k) => s + (a - mx) * (tru[k] - my), 0)
    const sxx = on.reduce((s, a) => s + (a - mx) ** 2, 0), syy = tru.reduce((s, b) => s + (b - my) ** 2, 0)
    const pr = sxy / Math.sqrt(sxx * syy)
    ok('65 台验收：Bg MAPE<10% 且 pearson>0.9（lock ON）',
      mape < 10 && pr > 0.9 && n >= 60,
      `n=${n} MAPE=${mape.toFixed(1)}% pearson=${pr.toFixed(3)}`)
  } catch (err) {
    ok('65 台验收：真值集可读且达标', false, String(err?.message ?? err).slice(0, 80))
  }
}

console.log(`\n${'═'.repeat(50)}`)
console.log(fail === 0 ? `✅ 全部通过（${pass}/${pass + fail}）` : `❌ ${fail} 项失败（${pass}/${pass + fail}）`)
process.exit(fail === 0 ? 0 : 1)
