# -*- coding: utf-8 -*-
"""diag_p2_alpha.py — 扫描 Ridge α, 排除"正则太弱致近奇异"假阴性.
若增大 α 后 R² 回到可解释范围(≥ -0.5), 则线性代理技术上可训练, 问题在特征表达力;
若仍显著为负, 则确认线性代理在现有数据上不可用."""
import json, random, statistics as st
import fit_p2_torque_model as F

V2 = r"D:/dsh-motor-ai-l0/output/p2_torque_truth_v2.json"

def cv_alpha(rows, name, alpha, k=5):
    feats = [(n, r) for n, r in F.FEATURES]
    drefs = [("D2L", 0.01), ("lambda", 1.0), ("tau_m", 0.15)]
    r2s = []
    random.seed(42)
    idx = list(range(len(rows))); random.shuffle(idx)
    folds = [idx[i::k] for i in range(k)]
    for f in range(k):
        te_i = set(folds[f])
        tr = [rows[i] for i in range(len(rows)) if i not in te_i]
        te = [rows[i] for i in range(len(rows)) if i in te_i]
        Xtr, mean, std = F.build_X(tr, feats, drefs)
        Xte, _, _ = F.build_X(te, feats, drefs, mean, std)
        ytr = [r[name] for r in tr]; yte = [r[name] for r in te]
        w = F.ridge_fit(Xtr, ytr, alpha=alpha)
        yh = F.predict(Xte, w)
        r2, mae, _ = F.r2_mae(yte, yh)
        r2s.append(r2)
    return st.mean(r2s), max(r2s)-min(r2s)

def main():
    v2 = json.load(open(V2, encoding="utf-8"))
    data = F.load_targets(v2)
    rows = [d[0] for d in data]
    for i, d in enumerate(data):
        rows[i]["Tst_pu"] = d[1]; rows[i]["Tmax_pu"] = d[2]; rows[i]["Ist_pu"] = d[3]
    rel = [r for r in rows if r.get("provenance") == "reliable_db"]

    print("α 扫描 (R²; 越接近/高于0越好, 显著负=线性代理不可用)\n")
    print(f"{'α':>10} | {'Tst 全量':>10} {'Tst rel':>10} | {'Tmax 全量':>10} {'Tmax rel':>10} | {'Ist 全量':>10} {'Ist rel':>10}")
    for a in (1e-3, 1e-2, 0.1, 1.0, 10.0, 100.0):
        line = f"{a:>10.3g} | "
        for name in ("Tst_pu", "Tmax_pu", "Ist_pu"):
            r2a, _ = cv_alpha(rows, name, a)
            r2r, _ = cv_alpha(rel, name, a)
            line += f"{r2a:>10.3f} {r2r:>10.3f} | "
        print(line)

if __name__ == "__main__":
    main()
