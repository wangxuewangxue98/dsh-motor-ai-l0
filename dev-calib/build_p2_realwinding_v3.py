"""P2-③A: 组装"真实绕组"真值集 v3 (p2_torque_truth_v3.json).

来源优先级:
  1) designs.db 真实绕组行(v2 中 provenance != synthesized_y2 者: 55kW/4极/660V 家族 + 2 真机锚)
  2) 外部真实绕组 catalogue CSV(用户补入, 经 load_winding_catalogue 读入; 可选 --solve 用 RMxprt 补解)

诚实边界: 本机真实绕组仅覆盖单一 55kW 家族 + 2 锚点; 6/8 极真机绕组缺失,
补入 catalogue 前 v3 的跨极数/跨功率真值不可得(以 gap_note 显式标注).
"""
import json, os, sys, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
V2 = r"D:/dsh-motor-ai-l0/output/p2_torque_truth_v2.json"
from load_winding_catalogue import load_winding_catalogue  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalogue", default=None, help="外部真实绕组 CSV 路径(可选)")
    ap.add_argument("--solve", action="store_true", help="对 catalogue 行用 RMxprt 补解(慢)")
    ap.add_argument("--out", default=r"D:/dsh-motor-ai-l0/output/p2_torque_truth_v3.json")
    args = ap.parse_args()

    d = json.load(open(V2, encoding="utf-8"))
    v3_rows = []
    prov_count = {}
    for r in d["rows"]:
        prov = r.get("provenance", "reliable_db")
        if prov == "synthesized_y2":
            continue  # 排除合成绕组
        if not r.get("solve_ok"):
            continue
        rr = dict(r)
        rr["winding_source"] = prov  # real
        v3_rows.append(rr)
        prov_count[prov] = prov_count.get(prov, 0) + 1

    poles_avail = sorted({int(r["inputs"]["poles"]) for r in v3_rows})
    powers = [r["inputs"]["power"] for r in v3_rows]
    gap_poles = [p for p in (6, 8) if p not in poles_avail]

    cat_rows = []
    cat_status = "not_provided"
    if args.catalogue:
        try:
            cat = load_winding_catalogue(args.catalogue)
            cat_rows = cat
            cat_status = f"loaded {len(cat)} rows (solve={'yes' if args.solve else 'no'})"
            if args.solve:
                import run_p2_torque_truth as R
                if R.rt.is_available():
                    params = []
                    for c in cat:
                        params.append({
                            "tag": f"CAT_{c['model']}", "db_id": None, "model": c["model"],
                            "stator_od": c["stator_od_mm"], "stator_id": c["stator_id_mm"],
                            "air_gap": c["air_gap_mm"], "slots_stator": c["slots_stator"],
                            "slots_rotor": c["slots_rotor"], "poles": c["poles"],
                            "voltage": c["voltage_v"], "speed": c["speed_rpm"],
                            "frequency": c["frequency_hz"] or 50.0,
                            "core_length": c["core_length_mm"], "power": c["power_kw"],
                            "turns_per_coil": c["turns_per_coil"],
                            "conductors_per_slot": int(round(c["conductors_per_slot"] or c["turns_per_coil"])),
                            "wire_dia": c["wire_dia_mm"], "n_strands": c["n_strands"],
                            "parallel_circuits": c["parallel_circuits"] or 1,
                            "winding_connection": c["winding_connection"], "motor_type": "induction",
                        })
                    res = R.rt.solve_batch(params, machine_type="induction")
                    for p, x in zip(params, res):
                        rec = {"tag": p["tag"], "db_id": None, "inputs": p,
                               "provenance": "catalogue_real", "winding_source": "catalogue_real",
                               "solve_ok": (x.get("solve_mode") == "rmxprt") and float(x.get("power") or 0) > 0}
                        rec["rmxprt"] = x
                        v3_rows.append(rec)
        except Exception as e:
            cat_status = f"load_failed: {e}"

    payload = {
        "generated_by": "P2-③A 真实绕组真值集 v3 (designs.db real windings + optional catalogue)",
        "generated_at": __import__("time").strftime("%Y-%m-%d %H:%M:%S"),
        "source": "v2 real-winding subset (+ catalogue if provided)",
        "winding_type": "real (非合成)",
        "rows": v3_rows,
        "stats": {
            "total_real": len(v3_rows),
            "by_provenance": prov_count,
            "poles_available": poles_avail,
            "power_range_kW": [min(powers), max(powers)] if powers else None,
            "catalogue": cat_status,
        },
        "gap_note": (
            f"本机真实绕组仅覆盖极数 {poles_avail}、功率 {min(powers):.1f}~{max(powers):.1f}kW "
            f"(单一 55kW/4极/660V 家族 + 2 真机锚). 缺极数 {gap_poles} 的真机绕组, "
            f"跨极数真值需外部 Y2/Y 绕组 catalogue 经 load_winding_catalogue 补入(见 dev-calib/winding_catalogue_template.csv)."
        ),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump(payload, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"[v3] 写出 {args.out}")
    print(f"  total_real={len(v3_rows)} by_provenance={prov_count}")
    print(f"  poles_available={poles_avail} gap={gap_poles}")
    print(f"  catalogue: {cat_status}")
    print(f"  gap_note: {payload['gap_note']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
