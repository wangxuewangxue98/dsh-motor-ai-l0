#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""S0 真值提取与清洗审计：从 designs.db 提取 rmxprt 真值，产出 S0 标定数据集。

清洗门（仿 G1-G6 精神，全部为只读审计，不写任何库）：
  G1 几何完整：stator_od/stator_id/core_length/air_gap 非 NULL
  G2 电气完整：voltage_v/speed_rpm/poles 非 NULL 且 power_kw>0
  G3 效率合理：50 <= efficiency <= 100（百分数口径）
  G4 磁密有界：0.3 <= B_tooth/B_yoke/B_gap <= 2.5 T
  G5 损耗闭合：total_loss/copper_loss/iron_loss 均 > 0
  G6 绕组完整：slots_stator/turns_per_coil > 0
"""
import json
import sqlite3
import sys

DB = "D:/MotorDesign/KnowledgeBase/designs.db"
OUT = "D:/dsh-motor-ai-l0/output/s0_calibration_dataset.json"


def main():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    rows = [dict(r) for r in cur.execute(
        "SELECT * FROM designs WHERE solve_mode='rmxprt'")]
    con.close()

    total = len(rows)
    kept, rejected = [], []
    for r in rows:
        fails = []
        if not all(r.get(k) is not None for k in
                   ("stator_od", "stator_id", "core_length", "air_gap")):
            fails.append("G1_geo")
        if not all(r.get(k) is not None for k in ("voltage_v", "speed_rpm", "poles")) \
                or not (r.get("power_kw") or 0) > 0:
            fails.append("G2_elec")
        eff = r.get("efficiency")
        if not (50.0 <= (eff or 0) <= 100.0):
            fails.append("G3_eff")
        for k in ("stator_tooth_flux_density", "stator_yoke_flux_density",
                  "air_gap_flux_density"):
            v = r.get(k)
            if v is None or not (0.3 <= v <= 2.5):
                fails.append("G4_" + k.split("_")[1][:6])
        for k in ("total_loss", "copper_loss", "iron_loss"):
            if not (r.get(k) or 0) > 0:
                fails.append("G5_loss")
        if not (r.get("slots_stator") or 0) > 0 or not (r.get("turns_per_coil") or 0) > 0:
            fails.append("G6_wind")
        if fails:
            rejected.append({"id": r.get("id"), "power_kw": r.get("power_kw"),
                             "poles": r.get("poles"), "fails": fails})
        else:
            kept.append(r)

    # 覆盖审计
    powers = sorted({r["power_kw"] for r in kept})
    poles_d = {}
    for r in kept:
        poles_d[r["poles"]] = poles_d.get(r["poles"], 0) + 1
    frames = sorted({r["stator_od"] for r in kept})

    # Y160L-4 / Y180M-4 特征匹配（几何锚点：260/170、290/187）
    y160 = [r for r in kept if abs(r["stator_od"] - 260) < 1 and abs(r["stator_id"] - 170) < 1]
    y180 = [r for r in kept if abs(r["stator_od"] - 290) < 1 and abs(r["stator_id"] - 187) < 1]

    print("=" * 70)
    print("S0 真值提取审计（designs.db / solve_mode='rmxprt'）")
    print("=" * 70)
    print(f"  rmxprt 总行数      : {total}")
    print(f"  通过清洗          : {len(kept)}  ({len(kept)/max(total,1)*100:.1f}%)")
    print(f"  剔除              : {len(rejected)}")
    if rejected[:8]:
        for x in rejected[:8]:
            print(f"    - id={x['id']} P={x['power_kw']} poles={x['poles']} fails={x['fails']}")
    print(f"\n  功率档覆盖({len(powers)}): {powers}")
    print(f"  极数分布          : {dict(sorted(poles_d.items()))}")
    print(f"  机座(Dso)覆盖({len(frames)}): {frames}")
    print(f"\n  Y160L-4 匹配(260/170): {len(y160)} 行"
          + (f"  id={[r['id'] for r in y160]} P={[r['power_kw'] for r in y160]}" if y160 else ""))
    print(f"  Y180M-4 匹配(290/187): {len(y180)} 行"
          + (f"  id={[r['id'] for r in y180]} P={[r['power_kw'] for r in y180]}" if y180 else ""))

    # 磁密真值分布（解析法标定的核心锚）
    import statistics as st
    for k in ("stator_tooth_flux_density", "stator_yoke_flux_density", "air_gap_flux_density"):
        vals = [r[k] for r in kept]
        print(f"  {k:30s} n={len(vals)} min={min(vals):.3f} p50={st.median(vals):.3f} "
              f"max={max(vals):.3f} mean={st.mean(vals):.3f}")

    # 产出 S0 数据集
    designs = []
    for r in kept:
        designs.append({
            "src_id": r["id"], "tag": f"db{r['id']}",
            "power_kw": r["power_kw"], "voltage_v": r["voltage_v"],
            "speed_rpm": r["speed_rpm"], "poles": r["poles"],
            "stator_od": r["stator_od"], "stator_id": r["stator_id"],
            "core_length": r["core_length"], "air_gap": r["air_gap"],
            "slots_stator": r["slots_stator"], "slots_rotor": r.get("slots_rotor"),
            "turns_per_coil": r["turns_per_coil"],
            "motor_type": "pmsm" if r.get("rotor_od") else "induction",
            "truth": {
                "efficiency_pct": round(r["efficiency"], 3),
                "total_loss": r["total_loss"], "copper_loss": r["copper_loss"],
                "iron_loss": r["iron_loss"],
                "b_tooth": round(r["stator_tooth_flux_density"], 4),
                "b_yoke": round(r["stator_yoke_flux_density"], 4),
                "b_gap": round(r["air_gap_flux_density"], 4),
            },
        })
    # ── 补充设计：Y160L-4 / Y180M-4 ──
    # designs.db 全库无 260/170、290/187 几何（实测 0 行），提案点名两机真值缺失。
    # 几何取 tests/probe/y160_y180_rewind_v3.mjs 权威参数，真值标 pending_rmxprt，
    # 待 ANSYS 环境补齐后由 calibrate_analytic_rmxprt.mjs --run 回填。
    supplements = [
        {"src_id": None, "tag": "Y160L-4", "power_kw": 15, "voltage_v": 380,
         "speed_rpm": 1460, "poles": 4, "stator_od": 260, "stator_id": 170,
         "core_length": 195, "air_gap": 0.51, "slots_stator": 36, "slots_rotor": 28,
         "turns_per_coil": 31, "motor_type": "induction",
         "truth": None, "truth_status": "pending_rmxprt",
         "truth_src": "y160_y180_rewind_v3.mjs（几何）；铭牌 η=88.5%/I=30.3A 仅作锚点"},
        {"src_id": None, "tag": "Y180M-4", "power_kw": 18.5, "voltage_v": 380,
         "speed_rpm": 1470, "poles": 4, "stator_od": 290, "stator_id": 187,
         "core_length": 175, "air_gap": 0.55, "slots_stator": 48, "slots_rotor": 44,
         "turns_per_coil": 25, "motor_type": "induction",
         "truth": None, "truth_status": "pending_rmxprt",
         "truth_src": "y160_y180_rewind_v3.mjs（几何 L=175 标准机；旧 DESIGN_SWEEP 的 190 为误值，已修正）；铭牌 η=91.0%/I=37.3A 仅作锚点"},
    ]
    designs.extend(supplements)

    payload = {
        "generated_by": "S0 真值提取（designs.db rmxprt 行）",
        "db": DB, "solve_mode": "rmxprt",
        "gate": {"G1": "几何完整", "G2": "电气完整", "G3": "效率50-100%",
                 "G4": "磁密0.3-2.5T", "G5": "损耗>0", "G6": "绕组>0"},
        "stats": {"total": total, "kept": len(kept), "rejected": len(rejected),
                  "power_levels": powers,
                  "poles_hist": {str(k): v for k, v in sorted(poles_d.items())},
                  "frames": frames,
                  "y160l_hits": len(y160), "y180m_hits": len(y180),
                  "supplements": [s["tag"] for s in supplements],
                  "supplement_truth_status": "pending_rmxprt"},
        "rejected": rejected,
        "rows": designs,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"\n  → S0 数据集已写出: {OUT}  (rows={len(designs)})")
    ok = len(designs) >= 30
    print(f"  ≥30 机型门: {'PASS' if ok else 'FAIL'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
