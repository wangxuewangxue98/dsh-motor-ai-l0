"""P2-③C: 分极数桶 + 多项式(度2) Ridge, 与 B 全局物理特征对照.

- 复用 estimate_p2_torque_physics.build_features 的物理可解释特征(log 缩放+派生量).
- 对 Tst_pu / Tmax_pu / Ist_pu 各做: (i) 全局 5折 CV, (ii) 按极数分桶 CV.
- 报告 R^2, 与 B 全局 Tst +0.296 对照; 诚实判定 C 是否优于 B.
纯 Python. 输入 output/p2_torque_truth_v2.json.
"""
import json, math, os, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
V2 = r"D:/dsh-motor-ai-l0/output/p2_torque_truth_v2.json"
ALPHA = 1.0

# ---------- Ridge (纯 Python) ----------
def mat_T(A): return [[A[i][j] for i in range(len(A))] for j in range(len(A[0]))]
def mat_mul(A, B):
    return [[sum(A[i][k]*B[k][j] for k in range(len(B))) for j in range(len(B[0]))] for i in range(len(A))]
def mat_vec(A, v):
    return [sum(A[i][j]*v[j] for j in range(len(v))) for i in range(len(A))]
def mat_identity(n):
    return [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
def mat_inv(M):
    n = len(M); A = [row[:] + [1.0 if i == j else 0.0 for j in range(n)] for i, row in enumerate(M)]
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(A[r][i])); A[i], A[p] = A[p], A[i]
        piv = A[i][i]; A[i] = [x/piv for x in A[i]]
        for r in range(n):
            if r != i:
                f = A[r][i]; A[r] = [A[r][c]-f*A[i][c] for c in range(2*n)]
    return [row[n:] for row in A]
def ridge_fit(X, y, alpha=ALPHA):
    Xt = mat_T(X); XtX = mat_mul(Xt, X); I = mat_identity(len(XtX))
    A = [[XtX[i][j]+(alpha if i == j else 0.0) for j in range(len(XtX))] for i in range(len(XtX))]
    Ainv = mat_inv(A); return mat_vec(Ainv, mat_vec(Xt, y))
def r2(y, yh):
    n = len(y)
    if n == 0: return None
    ym = sum(y)/n; ss_t = sum((v-ym)**2 for v in y); ss_r = sum((y[i]-yh[i])**2 for i in range(n))
    return 1.0 - ss_r/ss_t if ss_t > 0 else 0.0
def mae(y, yh):
    return sum(abs(y[i]-yh[i]) for i in range(len(y)))/len(y) if y else None
def standardize(X):
    n = len(X); d = len(X[0])
    mean = [sum(X[i][j] for i in range(n))/n for j in range(d)]
    std = [max(1e-9, math.sqrt(sum((X[i][j]-mean[j])**2 for i in range(n))/n)) for j in range(d)]
    return [[(X[i][j]-mean[j])/std[j] for j in range(d)] for i in range(n)], mean, std

def poly2(X):
    """度2展开: 原特征 + 平方 + 两两乘积(不含重复)."""
    out = []
    for x in X:
        d = len(x); fe = list(x)
        fe += [x[i]*x[i] for i in range(d)]
        for i in range(d):
            for j in range(i+1, d):
                fe.append(x[i]*x[j])
        out.append(fe)
    return out

def kfold_cv(rows, k=5, alpha=ALPHA, poly=False):
    """rows: list of (feat, target). 返回 (yt, pred, R2)."""
    n = len(rows)
    if n < k or n < 3: return None, None, None
    Xall = poly2([r[0] for r in rows]) if poly else [r[0] for r in rows]
    y = [r[1] for r in rows]
    pred = [0.0]*n
    for fold in range(k):
        te = set(range(fold*n//k, (fold+1)*n//k))
        tr = [i for i in range(n) if i not in te]
        Xtr, mean, std = standardize([Xall[i] for i in tr])
        w = ridge_fit([[1.0]+r for r in Xtr], [y[i] for i in tr], alpha)
        for i in te:
            xv = [(Xall[i][j]-mean[j])/std[j] for j in range(len(mean))]
            pred[i] = w[0] + sum(w[j+1]*xv[j] for j in range(len(xv)))
    return y, pred, r2(y, pred)

def build_features(inp):
    try:
        Dso=float(inp["stator_od"]); Dsi=float(inp["stator_id"]); L=float(inp["core_length"])
        Qs=float(inp["slots_stator"]); Qr=float(inp["slots_rotor"]); p=float(inp["poles"])
        ag=float(inp["air_gap"]); V=float(inp["voltage"]); pw=float(inp["power"])
        tpc=float(inp["turns_per_coil"]); ns=float(inp.get("n_strands") or 0); wd=float(inp.get("wire_dia") or 0)
        a=float(inp.get("parallel_circuits") or 1); yk=inp.get("yoke_thickness")
        dav=(Dso+Dsi)/2.0
        sd=(Dso-Dsi)/2.0-(float(yk) if yk else 0)
        if sd<=0: sd=0.6*(Dso-Dsi)/2.0
        A_slot=0.5*(math.pi*Dso/Qs)*sd if Qs else 0
        cond=ns*math.pi*(wd/2.0)**2 if (ns and wd) else 0.0
        mtl=2.0*(L+math.pi*dav/p) if p else 2.0*(L+math.pi*dav/4.0)
        Ns=Qs*tpc/(2.0*a) if a else Qs*tpc/2.0
        return [math.log(pw+1e-3), p, math.log(V+1e-3), math.log(dav+1e-3),
                math.log(L+1e-3), math.log(tpc+1e-3), math.log(cond+1e-9),
                ag, Qs, Qr, math.log(mtl+1e-3), math.log(Ns+1e-3)]
    except Exception:
        return None

def collect(ykey):
    d = json.load(open(V2, encoding="utf-8"))
    rows = []
    for r in d["rows"]:
        if not r.get("solve_ok"): continue
        rm = r.get("rmxprt", {}); inp = r.get("inputs", {})
        y = rm.get(ykey)
        if y is None: continue
        f = build_features(inp)
        if f is None: continue
        rows.append((f, float(y), int(inp.get("poles", 0))))
    return rows

def main():
    print("P2-③C: 分极数桶 + 多项式(度2) Ridge\n" + "="*50)
    for ykey in ("Tst_pu", "Tmax_pu", "Ist_pu"):
        rows = collect(ykey)
        n = len(rows)
        print(f"\n### {ykey}  (n={n}) ###")
        # 全局: 线性 vs 多项式
        yt, pr, r_lin = kfold_cv(rows, poly=False)
        yt2, pr2, r_poly = kfold_cv(rows, poly=True)
        print(f"  全局线性   CV_R2={r_lin:.3f}  MAE={mae(yt,pr):.4f}")
        print(f"  全局度2    CV_R2={r_poly:.3f}  MAE={mae(yt2,pr2):.4f}")
        # 分桶
        byp = {}
        for f, y, pol in rows:
            byp.setdefault(pol, []).append((f, y, pol))
        for pol in sorted(byp):
            bucket = byp[pol]
            nb = len(bucket)
            if nb < 5:
                print(f"  {pol}极(n={nb}): 样本不足5, 跳过 CV")
                continue
            _, _, rb_lin = kfold_cv(bucket, poly=False)
            _, _, rb_poly = kfold_cv(bucket, poly=True)
            print(f"  {pol}极(n={nb}): 桶内线性 R2={rb_lin:.3f}  桶内度2 R2={rb_poly:.3f}")
    print("\n" + "="*50)
    print("对照: B 全局物理特征 Tst CV_R2=+0.296(线性). 若C的分桶/度2 提升 Ist/Tst 则C有增益;")
    print("小样本桶(<=20)CV 抖动大, 结论需谨慎.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
