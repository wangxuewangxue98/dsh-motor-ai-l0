# -*- coding: utf-8 -*-
"""diag_p2_fit.py — 诊断线性 Ridge 代理在 P2 真值集上的失效根因.
分层: ① 全量混合 CV; ② reliable_db 单一家族内部 CV; ③ 特征有限性 + 靶标分布.
"""
import json, math, statistics as st
import fit_p2_torque_model as F

V2 = r"D:/dsh-motor-ai-l0/output/p2_torque_truth_v2.json"

def desc(name, ys):
    if not ys:
        print(f"  {name}: (空)"); return
    print(f"  {name}: n={len(ys)} min={min(ys):.3f} max={max(ys):.3f} "
          f"mean={st.mean(ys):.3f} std={st.pstdev(ys):.3f}")

def cv_only(rows, name, k=5):
    """仅用给定 rows 做 5 折 CV (不跨源)."""
    feats = [(n, r) for n, r in F.FEATURES]
    drefs = [("D2L", 0.01), ("lambda", 1.0), ("tau_m", 0.15)]
    r2s, maes = [], []
    import random
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
        w = F.ridge_fit(Xtr, ytr)
        yh = F.predict(Xte, w)
        r2, mae, _ = F.r2_mae(yte, yh)
        r2s.append(r2); maes.append(mae)
    return st.mean(r2s), st.mean(maes), r2s

def main():
    v2 = json.load(open(V2, encoding="utf-8"))
    data = F.load_targets(v2)
    rows = [d[0] for d in data]
    for i, d in enumerate(data):
        rows[i]["Tst_pu"] = d[1]; rows[i]["Tmax_pu"] = d[2]; rows[i]["Ist_pu"] = d[3]

    rel = [r for r in rows if r.get("provenance") == "reliable_db"]
    syn = [r for r in rows if r.get("provenance") == "synthesized_y2"]

    print("=== 靶标分布 ===")
    for name in ("Tst_pu", "Tmax_pu", "Ist_pu"):
        print(f"[{name}]")
        desc("  全量", [r[name] for r in rows])
        desc("  reliable_db(37台55kW/4极)", [r[name] for r in rel])
        desc("  synthesized_y2", [r[name] for r in syn])

    print("\n=== 分层 CV R² (mean±std) ===")
    for name in ("Tst_pu", "Tmax_pu", "Ist_pu"):
        r2m, maem, r2s = cv_only(rows, name)
        r2r, maer, _ = cv_only(rel, name)
        print(f"[{name}] 全量混合: R²={r2m:.3f}±{max(r2s)-min(r2s):.3f} MAE={maem:.3f}")
        print(f"         reliable_only: R²={r2r:.3f} MAE={maer:.3f} (n={len(rel)})")

    print("\n=== 特征有限性检查 ===")
    bad = 0
    for r in rows:
        raw, der = F.feat_row(r["inputs"])
        for v in list(raw.values()) + list(der.values()):
            if not math.isfinite(v):
                bad += 1; break
    print(f"  含非有限特征的行: {bad}/{len(rows)}")
    # 特征方差 (全量)
    feats = [(n, r) for n, r in F.FEATURES]
    drefs = [("D2L", 0.01), ("lambda", 1.0), ("tau_m", 0.15)]
    X, _, _ = F.build_X(rows, feats, drefs)
    cols = ["bias"] + [n for n, _ in feats] + [n for n, _ in drefs]
    var = []
    for j in range(len(X[0])):
        cj = [X[i][j] for i in range(len(X))]
        var.append(st.pvariance(cj) if len(cj) > 1 else 0)
    print("  特征列方差(标准化后应为~1, 此处未标准化原始):")
    for c, v in zip(cols, var):
        if v < 1e-6:
            print(f"    [零方差] {c} (该特征在样本中恒定→无信息)")

    print("\n=== 极端样本 (Ist_pu 最大/最小 3 条) ===")
    for r in sorted(rows, key=lambda x: x["Ist_pu"])[:3] + sorted(rows, key=lambda x: -x["Ist_pu"])[:3]:
        print(f"  {r['tag']:20} prov={r['provenance']:14} poles={r['inputs']['poles']} "
              f"P={r['inputs']['power']} Tst={r['Tst_pu']:.2f} Tmax={r['Tmax_pu']:.2f} Ist={r['Ist_pu']:.2f}")

if __name__ == "__main__":
    main()
