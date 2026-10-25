/**
 * 验证 params.tooth_width 通道在 quickL0Estimate 的齿磁密路径是否生效
 * 运行：node dev-calib/probe_tooth_width_channel.mjs
 */
import { quickL0Estimate } from '@wangxue98/dsh-motor-ai-core'

const base = {
  motor_type: 'induction', voltage: 380, speed: 1480, poles: 4,
  power_kw: 15, core_length: 200, air_gap: 0.6,
  stator_od: 640, slots_stator: 54,
}

console.log('=== tooth_width 通道响应（同机，变齿宽）===')
console.log('tooth_width'.padEnd(14) + '齿磁密T'.padStart(10) + '轭磁密T'.padStart(10) + ' 预期(2·Bg·Di/(Qs·tw·k))')
for (const tw of [undefined, 5.85, 3.92, 3.0, 2.5]) {
  const e = quickL0Estimate(tw === undefined ? base : { ...base, tooth_width: tw })
  const pitch = Math.PI * (640 * 0.6) / 54
  const exp = tw === undefined
    ? (4 * 0.80 / (Math.PI * 0.98)).toFixed(3)
    : (2 * 0.80 * (640 * 0.6) / (54 * tw * 0.98)).toFixed(3)
  console.log(String(tw ?? '派生').padEnd(14) + String(e.tooth_flux_density).padStart(10)
    + String(e.yoke_flux_density).padStart(10) + '  ' + exp
    + (tw === undefined ? `  (派生=${(pitch / 2).toFixed(2)}mm)` : ''))
}

console.log('\n=== tooth_width 通道响应（doSaturationLoop 侧，A+C 后）===')
const { doSaturationLoop } = await import('../tools/l0/analytic-engine.mjs')
for (const tw of [undefined, 5.85, 3.92]) {
  const e = quickL0Estimate(tw === undefined ? base : { ...base, tooth_width: tw })
  const sat = doSaturationLoop({
    B_delta_base: e.air_gap_flux_density ?? 0.8,
    B_t_base: e.tooth_flux_density ?? 0, B_y_base: e.yoke_flux_density ?? 0,
    statorId: 640 * 0.6, statorOd: 640, yokeThickness: e.yoke_thickness ?? 30,
    toothWidth: tw, airGap: 0.6, slotsStator: 54, poles: 4, coreLength: 200,
  })
  console.log(`tooth_width=${String(tw ?? '派生').padEnd(8)} → formula=${e.tooth_flux_density}`
    + ` sat=${sat.B_t}  sat.tooth_width=${JSON.stringify(sat.tooth_width)}`)
}
