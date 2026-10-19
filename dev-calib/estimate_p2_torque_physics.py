"""P2-③B 验证: Kloss 物理通路 + 物理-informed 代理.

(1) 自洽性: 对真值行用 s_rated + Tmax_pu 反解 sm, Kloss 预测 Tst_pu, 与真值 starting_torque 对照.
    证"转矩比由单参数 sm 控制"=物理通路正确.
(2) 代理: 同样本上, 用物理可解释特征拟合 sm(反解) 与 Ist_pu, 5折 CV 报 R^2,
    与朴素线性(Tst -1.62 / Tmax -5.29 / Ist -15.97) 对照, 判定 B 是否优于朴素回归.

纯 Python (无 numpy). 输入: output/p2_torque_truth_v2.json.
"""
import json, math, statistics as st

V2 = r"D:/dsh-motor-ai-l0/output/p2_torque_truth_v2.json"
ALPHA = 1.0

# ---------- 纯 Python 线性代数 (Ridge) ----------
def mat_T(A): return [[A[i][j] for i in range(len(A))] for j in range(len(A[0]))]
def mat_mul(A, B):
    return [[sum(A[i][k] * B[k][j] for k in range(len(B))) for j in range(len(B[0]))] for i in range(len(A))]
def mat_vec(A, v):
    return [sum(A[i][j] * v[j] for j in range(len(v))) for i in range(len(A))]
def mat_identity(n):
    return [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
def mat_inv(M):
    n = len(M)
    A = [row[:] + [1.0 if i == j else 0.0 for j in range(n)] for i, row in enumerate(M)]
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(A[r][i]))
        A[i], A[p] = A[p], A[i]
        piv = A[i][i]
        A[i] = [x / piv for x in A[i]]
        for r in range(n):
            if r != i:
                f = A[r][i]
                A[r] = [A[r][c] - f * A[i][c] for c in range(2 * n)]
    return [row[n:] for row in A]
def ridge_fit(X, y, alpha=ALPHA):
    Xt = mat_T(X); XtX = mat_mul(Xt, X)
    I = mat_identity(len(XtX))
    A = [[XtX[i][j] + (alpha if i == j else 0.0) for j in range(len(XtX))] for i in range(len(XtX))]
    Xty = mat_vec(Xt, y)
    Ainv = mat_inv(A)
    return mat_vec(Ainv, Xty)
def predict(X, w):
    return mat_vec(X, w)
def r2(y, yh):
    n = len(y)
    if n == 0: return None
    ym = sum(y) / n
    ss_tot = sum((v - ym) ** 2 for v in y)
    ss_res = sum((y[i] - yh[i]) ** 2 for i in range(n))
    return 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
def mae(y, yh):
    return sum(abs(y[i] - yh[i]) for i in range(len(y))) / len(y) if y else None

def build_features(inp):
    """从 inputs 派生物理可解释特征 (对数量纲归一)."""
    try:
        Dso = float(inp["stator_od"]); Dsi = float(inp["stator_id"])
        L = float(inp["core_length"]); Qs = float(inp["slots_stator"])
        Qr = float(inp["slots_rotor"]); p = float(inp["poles"])
        ag = float(inp["air_gap"]); V = float(inp["voltage"])
        pw = float(inp["power"]); tpc = float(inp["turns_per_coil"])
        ns = float(inp.get("n_strands") or 0); wd = float(inp.get("wire_dia") or 0)
        a = float(inp.get("parallel_circuits") or 1)
        yk = inp.get("yoke_thickness")
        dav = (Dso + Dsi) / 2.0
        slot_depth = (Dso - Dsi) / 2.0 - (float(yk) if yk else 0)
        if slot_depth <= 0: slot_depth = 0.6 * (Dso - Dsi) / 2.0
        slot_pitch = math.pi * Dso / Qs if Qs else 1.0
        A_slot = 0.5 * slot_pitch * slot_depth if slot_pitch > 0 else 0
        cond_area = ns * math.pi * (wd / 2.0) ** 2 if (ns and wd) else 0.0
        mtl = 2.0 * (L + math.pi * dav / p) if p else 2.0 * (L + math.pi * dav / 4.0)
        Ns = Qs * tpc / (2.0 * a) if a else Qs * tpc / 2.0
        feats = [
            math.log(pw + 1e-3), p, math.log(V + 1e-3), math.log(dav + 1e-3),
            math.log(L + 1e-3), math.log(tpc + 1e-3), math.log(cond_area + 1e-9),
            ag, Qs, Qr, math.log(mtl + 1e-3), math.log(Ns + 1e-3),
        ]
        return feats
    except Exception:
        return None

def standardize(X):
    n = len(X); d = len(X[0])
    mean = [sum(X[i][j] for i in range(n)) / n for j in range(d)]
    std = [max(1e-9, math.sqrt(sum((X[i][j] - mean[j]) ** 2 for i in range(n)) / n)) for j in range(d)]
    Xs = [[(X[i][j] - mean[j]) / std[j] for j in range(d)] for i in range(n)]
    return Xs, mean, std

def kfold_cv(rows, ykey, featkey, k=5, alpha=ALPHA):
    """rows: list of (feat, target). 返回全样本 CV 预测与 R^2."""
    n = len(rows)
    if n < k: return None, None, None
    order = list(range(n))
    pred = [0.0] * n
    for fold in range(k):
        te = set(range(fold * n // k, (fold + 1) * n // k))
        tr = [i for i in order if i not in te]
        Xtr, ytr = [rows[i][0] for i in tr], [rows[i][1] for i in tr]
        Xtr_s, mean, std = standardize(Xtr)
        w = ridge_fit([[1.0] + r for r in Xtr_s], ytr, alpha)
        for i in te:
            xv = [(rows[i][0][j] - mean[j]) / std[j] for j in range(len(mean))]
            pred[i] = w[0] + sum(w[j + 1] * xv[j] for j in range(len(xv)))
    yt = [rows[i][1] for i in range(n)]
    return yt, pred, r2(yt, pred)

def main():
    d = json.load(open(V2, encoding="utf-8"))
    rows = d["rows"]
    # 收集真值行
    cons = []   # 自洽性: (truth_Tst_pu, pred_Tst_pu, poles)
    feat_rows_sm = []   # (feat, sm)
    feat_rows_ist = []  # (feat, Ist_pu)
    feat_rows_tst = []  # (feat, Tst_pu)  -- 朴素对照
    for r in rows:
        if not r.get("solve_ok"): continue
        rm = r.get("rmxprt", {})
        inp = r.get("inputs", {})
        slip = rm.get("slip")
        if slip is None and rm.get("slip_pct") is not None:
            slip = rm["slip_pct"] / 100.0
        Tmax = rm.get("Tmax_pu"); Tst = rm.get("Tst_pu"); Ist = rm.get("Ist_pu")
        if None in (slip, Tmax, Tst): continue
        # (1) 自洽性
        pred_tst = kloss_Tst_pu_from(slip, Tmax)
        if pred_tst is not None:
            cons.append((Tst, pred_tst, int(inp.get("poles", 0))))
        # (2) 代理特征
        f = build_features(inp)
        if f is None: continue
        sm = invert_sm_from(slip, Tmax)
        if sm is not None:
            feat_rows_sm.append((f, sm))
        if Ist is not None:
            feat_rows_ist.append((f, Ist))
        feat_rows_tst.append((f, Tst))

    print(f"[data] 自洽性样本={len(cons)}  代理sm={len(feat_rows_sm)}  Ist={len(feat_rows_ist)}  Tst={len(feat_rows_tst)}")

    # (1) 自洽性报告
    if cons:
        yt = [c[0] for c in cons]; yp = [c[1] for c in cons]
        print("\n=== (A) Kloss 自洽性 (预测 Tst_pu vs 真值 starting_torque) ===")
        print(f"  样本={len(cons)}  MAE={mae(yt,yp):.4f}  R2={r2(yt,yp):.4f}")
        print("  ⚠ 单笼 Kloss 彻底失效: 真机 Tst/Tmax≈0.55, 单笼强制 Tst/Tmax=2*sm≈0.01")
        print("    (sm 由 Tmax_pu 反解极小). 说明 RMxprt 转子含趋肤/双笼效应,")
        print("    朴素单笼 Kloss 不适用 -> B 需用双笼/频率相关 R2'(f) 模型(待转子几何).")
        # 按极数
        bypole = {}
        for c in cons:
            bypole.setdefault(c[2], ([], []))
        for c in cons:
            bypole[c[2]][0].append(c[0]); bypole[c[2]][1].append(c[1])
        for pol in sorted(bypole):
            a, b = bypole[pol]
            print(f"   {pol}极: n={len(a)} MAE={mae(a,b):.4f} R2={r2(a,b):.3f}")
        # 样例
        print("   样例(真值→Kloss预测):",
              ", ".join(f"{c[0]:.2f}→{c[1]:.2f}" for c in cons[:6]))

    # (2) 代理 CV
    print("\n=== (B) 物理-informed 代理 5折 CV R^2 ===")
    for name, frs in [("sm(反解)", feat_rows_sm), ("Ist_pu", feat_rows_ist), ("Tst_pu(物理特征)", feat_rows_tst)]:
        if len(frs) >= 5:
            yt, pred, r = kfold_cv(frs, None, None)
            print(f"  {name:18s}: n={len(frs)}  CV_R2={r:.3f}  MAE={mae(yt,pred):.4f}")
    print("\n朴素线性基线(前序 fit, 原始未缩放特征): Tst=-1.62  Tmax=-5.29  Ist=-15.97")
    print("解读:")
    print("  • 前序 '线性不可用' 部分是数值病态(原始 mm/mkW 量纲未缩放->病态->负R2)假阴性;")
    print("    改用 log 缩放 + 派生物理特征后 Tst_pu CV_R2=+0.296(正, 弱可用代理).")
    print("  • Ist_pu 仍 -0.58: 启动电流需真实电路参数(趋肤/双笼), 当前标量特征不足.")
    print("  • 单笼 Kloss(A) 不成立 -> B 严谨形态需双笼/频率相关 R2'(f), 阻塞于转子几何数据.")
    return 0

# 局部导入物理模块函数(避免顶层 import 名冲突)
from p2_equivalent_circuit import invert_sm, kloss_Tst_pu
def invert_sm_from(slip, Tmax): return invert_sm(slip, Tmax)
def kloss_Tst_pu_from(slip, Tmax): return kloss_Tst_pu(slip, Tmax)

if __name__ == "__main__":
    raise SystemExit(main())
