# -*- coding: utf-8 -*-
"""
方案1可行性预演：从 65 台真值反算"有效绕组系数" kw_eff。
E 平衡闭合式：E_phase = 4.44 * f * N_phase * kw * Φ，Φ = Bg_true * Ag
N_phase = (Qs/3) * (cps/2) / a   （每线圈匝数 = cps/2）
kw_eff = (V/sqrt(3)) / (4.44 * f * N * Φ)
若 kw_eff 集中（CV 小）⇒ E 平衡可闭合，方案1（绕组锁定+E平衡）可行；
若 kw_eff 分散 ⇒ 还需建模漏阻抗压降/滑差，方案1成本上升。
"""
import json, math, io, statistics

L0 = 'D:/dsh-motor-ai-l0'
rows = json.load(io.open(f'{L0}/output/p2_real_truth.json', encoding='utf-8'))['rows']

recs = []
for r in rows:
    if not r.get('solve_ok'):
        continue
    p = r['inputs']; rm = r['rmxprt']
    bg = rm.get('air_gap_flux_density')
    if not (bg and bg > 0.05):
        continue
    Qs = p['slots_stator']; a = p.get('parallel_circuits', 1) or 1
    cps = p['conductors_per_slot']
    f = p['frequency']
    V = p['voltage']
    Dsi = p['stator_id']; L = p['core_length']; pp = max(1, p['poles'] // 2)
    Ag = math.pi * Dsi * L / (2 * pp)  # m^2→注意单位 mm
    Ag_m2 = Ag * 1e-6
    Phi = bg * Ag_m2
    N = (Qs / 3) * (cps / 2) / a
    E = V / math.sqrt(3)
    kw = E / (4.44 * f * N * Phi)
    recs.append(dict(tag=r['tag'], poles=p['poles'], P=p['power'], kw=kw, bg=bg, N=N, Phi=Phi,
                     cps=cps, Qs=Qs, a=a, f=f, V=V))

kws = [r['kw'] for r in recs]
n = len(kws)
mean = sum(kws) / n
sd = statistics.pstdev(kws)
print(f'n={n}  kw_eff: mean={mean:.4f} std={sd:.4f} CV={sd/mean*100:.1f}%')
print(f'  range=[{min(kws):.4f}, {max(kws):.4f}]  IQR=[{sorted(kws)[n//4]:.4f}, {sorted(kws)[3*n//4]:.4f}]')
print(f'  中位={statistics.median(kws):.4f}')

print('\n分族 kw_eff（极数 x 功率段）:')
fam = {}
for r in recs:
    seg = 'P<=3' if r['P'] <= 3 else ('P<=15' if r['P'] <= 15 else 'P>15')
    fam.setdefault((r['poles'], seg), []).append(r)
for k in sorted(fam):
    v = [x['kw'] for x in fam[k]]
    m = sum(v) / len(v); s = statistics.pstdev(v)
    print(f'  p={k[0]} {k[1]:>6} n={len(v):>2} mean={m:.4f} CV={s/m*100:>5.1f}% range=[{min(v):.3f},{max(v):.3f}]')

# 若 kw 取各族中位，E 平衡预测 Bg 的误差
print('\n用 kw=族中位 反算 Bg 预测误差（oracle 分族）:')
errs = []
for k in sorted(fam):
    v = fam[k]
    med = statistics.median([x['kw'] for x in v])
    for x in v:
        Phi_pred = (x['V'] / math.sqrt(3)) / (4.44 * x['f'] * x['N'] * med)
        bg_pred = Phi_pred / (x['Phi'] / x['bg'])
        errs.append(abs(bg_pred / x['bg'] - 1))
print(f'  MAPE = {sum(errs)/len(errs)*100:.2f}%  (n={len(errs)})')

# 全局单 kw
Phi_err = []
for x in recs:
    Phi_pred = (x['V'] / math.sqrt(3)) / (4.44 * x['f'] * x['N'] * mean)
    bg_pred = Phi_pred / (x['Phi'] / x['bg'])
    Phi_err.append(abs(bg_pred / x['bg'] - 1))
print(f'  全局单 kw=mean: MAPE = {sum(Phi_err)/len(Phi_err)*100:.2f}%')

json.dump(recs, io.open(f'{L0}/output/p2_kw_eff.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f'\n[done] → {L0}/output/p2_kw_eff.json')
