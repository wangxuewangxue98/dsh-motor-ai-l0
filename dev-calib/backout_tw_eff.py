# -*- coding: utf-8 -*-
"""
反推 RMxprt 内部齿磁密所用等效齿宽：
    tw_eff = Bg_truth x pitch_D0 x k_fe x (2/pi) / Bt_truth
（解析 At 含 K_WAVE=pi/2，反推需除掉）
与各候选口径对比：气隙齿宽(pitch_D0-Bs0) / D2处(pitch_D2-Bs1) / D3处=pitch_D3-Bs2
/ tw_top / tw_root / tw_avg / tw_geo。
若 tw_eff 恒等于其中某一个 ⇒ 找到正确口径，等效齿宽模型即定为该截面。
"""
import json, math, io

L0 = 'D:/dsh-motor-ai-l0'
KFE = 0.96
truth = json.load(io.open(f'{L0}/output/p2_real_truth.json', encoding='utf-8'))['rows']
cat = {r['tag']: r for r in json.load(io.open(f'{L0}/dev-calib/real_slot_catalogue.json', encoding='utf-8'))['rows']}

rows = []
for r in truth:
    if not r.get('solve_ok'):
        continue
    bt = (r.get('rmxprt') or {}).get('stator_tooth_flux_density')
    bg = (r.get('rmxprt') or {}).get('air_gap_flux_density')
    if not (bt and bt > 0.05 and bg and bg > 0.05):
        continue
    c = cat[r['tag']]
    g = c['geom']; p = c['params']
    Qs = p['slots_stator']; Dsi = p['stator_id']
    pitch0 = math.pi * Dsi / Qs
    Bs0 = float(p['Slot__Bs0'].strip("'mm")); Bs1 = float(p['Slot__Bs1'].strip("'mm")); Bs2 = float(p['Slot__Bs2'].strip("'mm"))
    tw_gap = pitch0 - Bs0            # 气隙处齿宽
    tw_d2 = g['pitch_D2'] - Bs1      # 槽身起点齿宽
    tw_d3 = g['pitch_D3'] - Bs2      # 槽底齿宽
    tw_eff = bg * pitch0 * KFE * (2 / math.pi) / bt
    rows.append(dict(tag=r['tag'], p=p['poles'], P=p['power'], tw_eff=tw_eff,
                     tw_gap=tw_gap, tw_d2=tw_d2, tw_d3=tw_d3,
                     tw_top=g['tw_top_mm'], tw_root=g['tw_root_mm'], tw_avg=g['tw_avg_mm'],
                     tw_geo=g['tw_geo_mean_mm'], bt=bt, bg=bg, pitch0=pitch0))

print(f'[load] {len(rows)} 台')
cands = ['tw_gap', 'tw_d2', 'tw_d3', 'tw_top', 'tw_root', 'tw_avg', 'tw_geo']
print('\n口径'.ljust(12) + 'MAPE(tw_eff/口径−1)'.rjust(20) + 'mean K'.rjust(10) + 'std K'.rjust(9) + 'R²'.rjust(8))
for c in cands:
    ks = [r['tw_eff'] / r[c] for r in rows]
    m = sum(ks) / len(ks)
    sd = (sum((k - m) ** 2 for k in ks) / len(ks)) ** 0.5
    mape = sum(abs(k - 1) for k in ks) / len(ks)
    xs = [r[c] for r in rows]; ys = [r['tw_eff'] for r in rows]
    mx = sum(xs) / len(xs); my = sum(ys) / len(ys)
    sxx = sum((x - mx) ** 2 for x in xs); sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    syy = sum((y - my) ** 2 for y in ys)
    r2 = (sxy * sxy) / (sxx * syy) if syy > 0 else 0
    print(c.ljust(12) + f'{mape*100:>18.2f}%' + f'{m:>10.3f}' + f'{sd:>9.3f}' + f'{r2:>8.3f}')

print('\n逐台：tw_eff vs 气隙齿宽 vs tw_top')
print('机型'.ljust(11) + 'p'.rjust(2) + 'kW'.rjust(6) + 'tw_eff'.rjust(8) + '气隙齿宽'.rjust(9) + 'tw_top'.rjust(8) + '比值eff/gap'.rjust(11))
for r in rows:
    print(r['tag'].ljust(11) + str(r['p']).rjust(2) + f"{r['P']:>6.2f}" +
          f"{r['tw_eff']:>8.2f}" + f"{r['tw_gap']:>9.2f}" + f"{r['tw_top']:>8.2f}" + f"{r['tw_eff']/r['tw_gap']:>11.3f}")

# 分族统计（极数 x 功率段）
print('\n分族 mean(tw_eff/tw_gap):')
fam = {}
for r in rows:
    seg = '<=7.5kW' if r['P'] <= 7.5 else ('<=30kW' if r['P'] <= 30 else '>30kW')
    fam.setdefault((r['p'], seg), []).append(r['tw_eff'] / r['tw_gap'])
for k in sorted(fam):
    v = fam[k]
    print(f'  p={k[0]} {k[1]:>8}: n={len(v):>2} mean={sum(v)/len(v):.3f} range=[{min(v):.3f},{max(v):.3f}]')

json.dump(rows, io.open(f'{L0}/output/p2_tw_eff_backout.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f'\n[done] → {L0}/output/p2_tw_eff_backout.json')
