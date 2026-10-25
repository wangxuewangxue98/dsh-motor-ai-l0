# -*- coding: utf-8 -*-
"""
治本方案预演（只读，不改生产代码）：
① 口径层：tw_top vs tw_avg 直接喂解析的 MAPE
② 饱和层：Bt_true 对 Bt_lin 的全局响应函数（幂律压缩）——形式须可从硅钢 B-H 曲线推导
③ 组合层：口径+饱和的极限 MAPE
判定：若幂律 R² 高且指数有物理对应（非逐台拟合），则方案有骨架。
"""
import json, math, io

L0 = 'D:/dsh-motor-ai-l0'
cal = json.load(io.open(f'{L0}/output/p2_k_shape_calib.json', encoding='utf-8'))
d = cal['detail']
cat = {r['tag']: r for r in json.load(io.open(f'{L0}/dev-calib/real_slot_catalogue.json', encoding='utf-8'))['rows']}

rows = []
for r in d:
    c = cat[r['tag']]
    rows.append(dict(tag=r['tag'], btTruth=r['btTruth'], bt0=r['bt0'], btAvg=r['btAvg'],
                     tw_top=c['geom']['tw_top_mm'], tw_avg=c['geom']['tw_avg_mm'],
                     poles=c['params']['poles'], P=c['params']['power']))

def mape(pred, obs):
    return sum(abs(p/o - 1) for p, o in zip(pred, obs)) / len(pred) * 100
def bias(pred, obs):
    return sum(p/o - 1 for p, o in zip(pred, obs)) / len(pred) * 100

print('=== ① 口径层（同 65 台同口径重算）===')
print('  k=1 (tw_top)   MAPE=%.2f%% bias=%+.2f%%' % (mape([r['bt0'] for r in rows], [r['btTruth'] for r in rows]),
                                                      bias([r['bt0'] for r in rows], [r['btTruth'] for r in rows])))
print('  avg/min        MAPE=%.2f%% bias=%+.2f%%' % (mape([r['btAvg'] for r in rows], [r['btTruth'] for r in rows]),
                                                      bias([r['btAvg'] for r in rows], [r['btTruth'] for r in rows])))

print('\n=== ② 饱和响应函数 Bt_true = c x Bt_lin^a（log-log OLS）===')
for name, key in [('bt0(tw_top)', 'bt0'), ('btAvg', 'btAvg')]:
    xs = [math.log(r[key]) for r in rows]
    ys = [math.log(r['btTruth']) for r in rows]
    n = len(xs); mx = sum(xs)/n; my = sum(ys)/n
    sxx = sum((x-mx)**2 for x in xs); sxy = sum((x-mx)*(y-my) for x, y in zip(xs, ys))
    a = sxy/sxx; c = math.exp(my - a*mx)
    ss_tot = sum((y-my)**2 for y in ys)
    ss_res = sum((y-(a*x+my-a*mx))**2 for x, y in zip(xs, ys))
    r2 = 1 - ss_res/ss_tot
    pred = [c*r[key]**a for r in rows]
    print(f'  {name:14s} a={a:.3f} c={c:.3f} R2={r2:.3f}  MAPE={mape(pred,[r["btTruth"] for r in rows]):.2f}%  bias={bias(pred,[r["btTruth"] for r in rows]):+.2f}%')

print('\n=== ③ 分族幂律（每族单独拟合，检验是否族内收敛）===')
fam = {}
for r in rows:
    seg = 'P<=15' if r['P'] <= 15 else 'P>15'
    fam.setdefault((r['poles'], seg), []).append(r)
for k in sorted(fam):
    v = fam[k]
    if len(v) < 4: continue
    xs = [math.log(r['btAvg']) for r in v]; ys = [math.log(r['btTruth']) for r in v]
    n = len(xs); mx = sum(xs)/n; my = sum(ys)/n
    sxx = sum((x-mx)**2 for x in xs); sxy = sum((x-mx)*(y-my) for x, y in zip(xs, ys))
    a = sxy/sxx if sxx > 0 else 0; c = math.exp(my - a*mx)
    ss_tot = sum((y-my)**2 for y in ys); ss_res = sum((y-(a*x+my-a*mx))**2 for x, y in zip(xs, ys))
    r2 = 1 - ss_res/ss_tot if ss_tot > 0 else 0
    pred = [c*r['btAvg']**a for r in v]
    print(f'  p={k[0]} {k[1]:>6} n={len(v):>2} a={a:.3f} c={c:.3f} R2={r2:.3f} MAPE={mape(pred,[r["btTruth"] for r in v]):.1f}%')

print('\n=== ④ 全局 vs 分族对比（若分族无系统性增益 ⇒ 全局幂律即最优简约形式）===')
# 全局幂律在分族上的 MAPE 已由②给出；这里算"完美 oracle 分族"的上界
tot = []
for k in sorted(fam):
    v = fam[k]
    if len(v) < 4: continue
    xs = [math.log(r['btAvg']) for r in v]; ys = [math.log(r['btTruth']) for r in v]
    n = len(xs); mx = sum(xs)/n; my = sum(ys)/n
    sxx = sum((x-mx)**2 for x in xs); sxy = sum((x-mx)*(y-my) for x, y in zip(xs, ys))
    a = sxy/sxx if sxx > 0 else 1; c = math.exp(my - a*mx)
    pred = [c*r['btAvg']**a for r in v]
    tot.extend(abs(p/o-1) for p, o in zip(pred, [r['btTruth'] for r in v]))
print(f'  oracle 分族 MAPE = {sum(tot)/len(tot)*100:.2f}%')
