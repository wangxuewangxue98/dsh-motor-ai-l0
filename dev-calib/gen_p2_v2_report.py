# -*- coding: utf-8 -*-
"""gen_p2_v2_report.py — 由 p2_torque_truth_v2.json 生成 v2 真值集汇总报告 (markdown)。
统计: 来源/极数/合理性分布, slip 分布, 样本表, 过滤器剔除明细。
"""
import argparse
import json
import collections

V2 = r"D:/dsh-motor-ai-l0/output/p2_torque_truth_v2.json"
OUT = r"D:/dsh-motor-ai-l0/output/p2_torque_truth_v2_report.md"


def pct(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return "n/a"
    return (f"min={min(vals):.3f} max={max(vals):.3f} "
            f"mean={sum(vals)/len(vals):.3f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--v2", default=V2)
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    d = json.load(open(args.v2, encoding="utf-8"))
    rows = d["rows"]
    st = d.get("stats", {})

    by_prov = collections.Counter(r.get("provenance") for r in rows)
    by_pole = collections.Counter()
    slip_all, slip_plau = [], []
    plau_rows = []
    filtered = []
    for r in rows:
        if not r.get("solve_ok"):
            continue
        by_pole[r["inputs"].get("poles")] += 1
        s = r.get("slip")
        if s is not None:
            slip_all.append(s)
        if r.get("plausible"):
            plau_rows.append(r)
            if s is not None:
                slip_plau.append(s)
        else:
            filtered.append(r)

    lines = []
    lines.append("# P2 转矩真值集 v2 汇总报告\n")
    lines.append(f"- 生成时间: {d.get('generated_at')}")
    lines.append(f"- 合并来源: reliable_db(designs.db 真实绕组) + synthesized_y2(Y系列 EMF合成绕组)")
    lines.append(f"- 总行数: **{len(rows)}** (reliable_db {st.get('v1_reliable_db')} + synthesized_y2 {st.get('y2_total')})")
    lines.append(f"- plausible 行: **{st.get('merged_plausible')}** / {st.get('merged_total')} (slip∈[{d['filters']['slip'][0]},{d['filters']['slip'][1]}], 效率与 Tst≠Tmax 过滤)")
    lines.append(f"- 全量批耗时: {st.get('elapsed_s')}s\n")

    lines.append("## 1. 来源与极数分布")
    lines.append(f"- 按来源: {dict(by_prov)}")
    lines.append(f"- 按极数(已解): {dict(sorted(by_pole.items()))}")
    lines.append("")

    lines.append("## 2. slip 分布（合理性核心指标）")
    lines.append(f"- 全部已解 slip: {pct(slip_all)}")
    lines.append(f"- plausible slip: {pct(slip_plau)} (应落在 0.5%~8%)")
    lines.append("")

    lines.append("## 3. 过滤器剔除明细 (synthesized_y2 退化小机座)")
    if filtered:
        lines.append("| tag | 极数 | 功率kW | slip | 剔除原因 |")
        lines.append("|---|---|---|---|---|")
        for r in filtered:
            inp = r["inputs"]
            lines.append(f"| {r['tag']} | {inp.get('poles')} | {inp.get('power')} | "
                         f"{r.get('slip')} | {r.get('plausible_reason')} |")
    else:
        lines.append("- 无剔除")
    lines.append("")

    lines.append("## 4. plausible 样本（前 25 行）")
    lines.append("| tag | 极数 | 功率kW | 电压V | eff% | slip | Tst_pu | Tmax_pu | Ist_pu | 来源 |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for r in plau_rows[:25]:
        inp = r["inputs"]; rm = r.get("rmxprt", {})
        lines.append(f"| {r['tag']} | {inp.get('poles')} | {inp.get('power')} | {inp.get('voltage')} | "
                     f"{rm.get('efficiency')} | {r.get('slip')} | {rm.get('Tst_pu')} | "
                     f"{rm.get('Tmax_pu')} | {rm.get('Ist_pu')} | {r.get('provenance')} |")
    lines.append("")

    lines.append("## 5. 诚实边界")
    for c in d.get("caveats", []):
        lines.append(f"- {c}")

    open(args.out, "w", encoding="utf-8").write("\n".join(lines))
    print(f"[report] 写出 {args.out}; plausible={len(plau_rows)} filtered={len(filtered)}")


if __name__ == "__main__":
    main()
