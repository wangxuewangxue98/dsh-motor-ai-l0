# -*- coding: utf-8 -*-
"""
k_fit 解释变量诊断：k_fit 与各几何/电磁量的 Pearson & Spearman 相关。
铁律：判"无结构/不可标定"前必须先穷尽相关性诊断（证伪自身失败归因）。
"""
import json, math, io

L0 = 'D:/dsh-motor-ai-l0'
cal = json.load(io.open(f'{L0}/output/p2_k_shape_calib.json', encoding='utf-8'))
cat = {r['tag']: r for r in json.load(io.open(f'{L0}/dev-calib/real_slot_catalogue.json', encoding='utf-8'))['rows']}
truth = {r['tag']: r for r in json.load(io.open(f'{L0}/output/p2_real_truth.json', encoding='utf-8'))['rows']}

def pearson(x, y):
    n = len(x); mx = sum(x)/n; my = sum(y)/n
    sxx = sum((a-mx)**2 for a in x); syy = sum((b-my)**2 for b in y)
    sxy = sum((a-mx)*(b-my) for a, b in zip(x, y))
    return sxy/math.sqrt(sxx*syy) if sxx > 0 and syy > 0 else 0.0

def rank(v):
    idx = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0]*len(v); i = 0
    while i < len(v):
        j = i
        while j+1 < len(v) and v[idx[j+1]] == v[idx[i]]: j += 1
        avg = (i+j)/2 + 1
        for k in range(i, j+1): r[idx[k]] = avg
        i = j+1
    return r

def spearman(x, y): return pearson(rank(x), rank(y))

rows = []
for d in cal['detail']:
    tag = d['tag']; c = cat[tag]; t = truth[tag]
    g = c['geom']; p = c['params']
    Bs0 = float(p['Slot__Bs0'].strip("'mm")); Bs1 = float(p['Slot__Bs1'].strip("'mm")); Bs2 = float(p['Slot__Bs2'].strip("'mm"))
    rows.append(dict(
        tag=tag, poles=p['poles'], P=p['power'], kFit=d['kFit'],
        kAvg=d['kAvg'], kGeo=d['kGeo'], kHarm=d['kHarm'],
        tau=g['tau_effective'], tw_top=g['tw_top_mm'], tw_root=g['tw_root_mm'],
        tw_avg=g['tw_avg_mm'], tw_geo=g['tw_geo_mean_mm'],
        pitch0=math.pi*p['stator_id']/p['slots_stator'],
        pitch2=g['pitch_D2'], pitch3=g['pitch_D3'],
        Bs0=Bs0, Bs1=Bs1, Bs2=Bs2,
        Dsi=p['stator_id'], Dso=p['stator_od'], Qs=p['slots_stator'], L=p['core_length'],
        yoke=g['yoke'], hs=g['slot_depth_hs'],
        Bt=t['rmxprt']['stator_tooth_flux_density'], Bg=t['rmxprt']['air_gap_flux_density'],
        By=t['rmxprt']['stator_yoke_flux_density'],
        tpc=p['turns_per_coil'], cps=p['conductors_per_slot'],
    ))

feats = ['poles','P','tau','tw_top','tw_root','tw_avg','tw_geo','pitch0','pitch2','pitch3',
         'Bs0','Bs1','Bs2','Dsi','Dso','Qs','L','yoke','hs','Bt','Bg','By','tpc','cps',
         'kAvg','kGeo','kHarm']
y = [r['kFit'] for r in rows]
print(f'n={len(rows)}  k_fit: mean={sum(y)/len(y):.3f} std={(sum((v-sum(y)/len(y))**2 for v in y)/len(y))**0.5:.3f}')
print('\n特征'.ljust(12) + 'Pearson'.rjust(9) + 'Spearman'.rjust(10))
res = []
for f in feats:
    x = [r[f] for r in rows]
    res.append((f, pearson(x, y), spearman(x, y)))
for f, pr, sp in sorted(res, key=lambda t: -abs(t[2])):
    print(f.ljust(12) + f'{pr:>9.3f}' + f'{sp:>10.3f}')

# 变换：log 特征
print('\n--- log 缩放后 Spearman（找幂律关系）---')
for f in ['P','tw_top','tw_avg','pitch0','Bs0','Bs1','Bs2','Dsi','yoke','Bt','Bg']:
    x = [math.log(r[f]) if r[f] > 0 else 0 for r in rows]
    print(f.ljust(12) + f'{pearson(x, y):>9.3f}' + f'{spearman(x, y):>10.3f}')

# 比值特征
print('\n--- 构造比值特征 ---')
extra = {
    'tw_top/pitch0': lambda r: r['tw_top']/r['pitch0'],
    'tw_avg/pitch0': lambda r: r['tw_avg']/r['pitch0'],
    'tw_root/pitch0': lambda r: r['tw_root']/r['pitch0'],
    'Bs0/pitch0': lambda r: r['Bs0']/r['pitch0'],
    'Bs1/pitch0': lambda r: r['Bs1']/r['pitch0'],
    'Bs2/pitch0': lambda r: r['Bs2']/r['pitch0'],
    'tw_top/tw_root': lambda r: r['tw_top']/r['tw_root'],
    'yoke/half': lambda r: r['yoke']/((r['Dso']-r['Dsi'])/2),
    'tw_top²/P': lambda r: r['tw_top']**2/r['P'],
    'tw_avg²/P': lambda r: r['tw_avg']**2/r['P'],
}
for name, fn in extra.items():
    x = [fn(r) for r in rows]
    print(name.ljust(16) + f'{pearson(x, y):>9.3f}' + f'{spearman(x, y):>10.3f}')

json.dump(rows, io.open(f'{L0}/output/p2_kfit_features.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f'\n[done] → {L0}/output/p2_kfit_features.json')
