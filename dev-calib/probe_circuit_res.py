"""P2-③B 探针: 实跑 Y160L-4, dump .res 等效电路标签, 确认真实字段名.

目的: worker 当前 RES_PATTERNS 未抽等效电路参数(R1/X1/R2'/X2'/Xm).
本探针求解一台已知可解锚点, 扫描其 .res 文本, 打印含电路语义的原始行,
以便后续给 worker 增量加正确标签的抽取正则(纯增量, 不影响既有字段).
"""
import sys, os, glob, json, time, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_p2_torque_truth as R

V2 = r"D:/dsh-motor-ai-l0/output/p2_torque_truth_v2.json"


def main():
    if not R.rt.is_available():
        print("[FATAL] RMxprt 不可用")
        return 2
    d = json.load(open(V2, encoding="utf-8"))
    anchor = [r for r in d["rows"] if "Y160L-4" in r["tag"]]
    if not anchor:
        print("[FATAL] v2 中无 Y160L-4 锚点")
        return 2
    p = dict(anchor[0]["inputs"])
    p["tag"] = "Y160L-4-circuit-probe"
    print(f"[probe] 求解 {p['tag']} power={p['power']} poles={p['poles']} V={p['voltage']}")

    t0 = time.time()
    res = R.rt.solve_batch([p], verbose=True, machine_type="induction")
    print(f"[probe] solve 完成, 耗时 {time.time()-t0:.1f}s")
    x = res[0]
    print("[keys in result]:", sorted(x.keys()))

    # 找最新 .res
    cands = glob.glob(os.path.join(tempfile.gettempdir(), "**", "*.res"), recursive=True)
    cands = [c for c in cands if os.path.getmtime(c) > t0 - 30]
    cands.sort(key=os.path.getmtime, reverse=True)
    print(f"[probe] 找到 {len(cands)} 个候选 .res")
    kw = ("esistan", "eactance", "ircuit", "Rated Voltage", "Rated Current",
          "Rated Frequency", "Rated Speed", "Output Power", "Input Power",
          "Power Factor", "Rated Slip", "Phase Current")
    for c in cands[:4]:
        txt = open(c, encoding="utf-8", errors="replace").read()
        print(f"\n==== {c}  (size={len(txt)}) ====")
        for line in txt.splitlines():
            ls = line.strip()
            if any(k.lower() in ls.lower() for k in kw) and any(ch.isdigit() for ch in ls):
                print("   ", ls)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
