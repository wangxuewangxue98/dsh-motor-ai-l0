#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""update_s0_with_truth.py — 把 RMxprt 实测真值回填进 S0 标定数据集。

输入：
  output/y160_y180_rmxprt_results.json（run_y160_y180_rmxprt.py 产物）
  output/s0_calibration_dataset.json（extract_s0_truth.py 产物）
行为：
  - 按 tag 匹配 pending_rmxprt 行，用 RMxprt 真值替换 truth 对象、truth_status → 'rmxprt'
  - 失败行（solve_failed / 效率异常 / 磁密缺失）保留 pending 并记录原因
  - 只改 S0 数据集 JSON，不写 designs.db（外部库写回需用户单独授权）
"""
import json
import sys

S0 = "D:/dsh-motor-ai-l0/output/s0_calibration_dataset.json"
RES = "D:/dsh-m-motor-placeholder"  # 占位，运行时被命令行参数覆盖


# ── 合理性门（G3/G4 范围门 + P0-5 相对门） ──
# 范围门挡不住"系统性坍缩"型坏值（实测教训：15kW 机输出 2.8kW、效率 81%、Bt=0.51T
# 全都落在 [50,100]% / [0.3,2.5]T 合法区间内）。故追加：
#   ① 功率门：|power − 目标功率| / 目标功率 > 30% → 拒（真值必须落在目标邻域）
#   ② 电流门：stator_current 对铭牌偏差 > 35% → 拒
#   ③ 磁密量级门：4 极异步机按 designs.db 同功率档真值分布收紧
#      （新代 15kW 行 Bt 1.456-1.553 / By 1.478-1.571 / Bg 0.698-0.743）
NAMEPLATE_I = {"Y160L-4": 30.3, "Y180M-4": 37.3}
NAMEPLATE_EFF = {"Y160L-4": 88.5, "Y180M-4": 91.0}
FLUX_RANGE = {"b_tooth": (0.8, 2.2), "b_yoke": (1.0, 2.2), "b_gap": (0.4, 0.9)}


def check_truth(tag, res, truth):
    """返回拒绝原因列表；空列表 = 通过。"""
    bad = []
    p_target = res.get("_target_power_kw")
    if p_target and truth.get("power") is not None:
        dev = abs(truth["power"] - p_target) / p_target
        if dev > 0.30:
            bad.append(f"功率偏差 {dev*100:.0f}% ({truth['power']} vs {p_target}kW)")
    i_name = NAMEPLATE_I.get(tag)
    if i_name and truth.get("stator_current"):
        dev = abs(truth["stator_current"] - i_name) / i_name
        if dev > 0.35:
            bad.append(f"电流偏差 {dev*100:.0f}% ({truth['stator_current']} vs 铭牌 {i_name}A)")
    for k, (lo, hi) in FLUX_RANGE.items():
        v = truth.get(k)
        if v is None or not (lo <= v <= hi):
            bad.append(f"{k}={v} 出界[{lo},{hi}]")
    eff = truth.get("efficiency_pct")
    e_name = NAMEPLATE_EFF.get(tag)
    if e_name and eff and eff < e_name - 15:
        bad.append(f"效率 {eff} 低于铭牌 {e_name} 逾 15pt")
    # P0-5 第二轮实证新增：线规失配形态（pf 塌/J 爆）
    if truth.get("power_factor") is not None and truth["power_factor"] < 0.5:
        bad.append(f"pf={truth['power_factor']} 塌陷(<0.5)")
    if truth.get("current_density") is not None and truth["current_density"] > 12:
        bad.append(f"J={truth['current_density']} 爆表(>12A/mm²)")
    return bad


def pick(res, *keys):
    for k in keys:
        v = res.get(k)
        if v is not None:
            return v
    return None


def main(res_path):
    results = json.load(open(res_path, encoding="utf-8"))
    s0 = json.load(open(S0, encoding="utf-8"))
    params = json.load(
        open("D:/dsh-motor-ai-l0/output/y160_y180_rmxprt_params.json", encoding="utf-8"))

    filled, still_pending = 0, []
    for i, res in enumerate(results):
        tag = params[i].get("tag", f"#{i}")
        row = next((r for r in s0["rows"] if r.get("tag") == tag), None)
        if row is None:
            continue
        if res.get("solve_failed"):
            row["truth_status"] = "pending_rmxprt"
            row["truth_error"] = str(res.get("error"))[:200]
            still_pending.append(tag)
            continue
        eff = pick(res, "efficiency")
        bt = pick(res, "stator_tooth_flux_density")
        by = pick(res, "stator_yoke_flux_density")
        bg = pick(res, "air_gap_flux_density")
        # 合理性门：G3/G4 范围门 + P0-5 相对门（功率/电流/磁密量级/效率-铭牌差）
        bad = []
        if not (eff and 50.0 <= eff <= 100.0):
            bad.append(f"eff={eff}")
        for name, v in (("Bt", bt), ("By", by), ("Bg", bg)):
            if v is None or not (0.3 <= v <= 2.5):
                bad.append(f"{name}={v}")
        if not bad:
            truth_probe = {
                "power": res.get("power"),
                "efficiency_pct": eff,
                "b_tooth": bt, "b_yoke": by, "b_gap": bg,
                "stator_current": res.get("stator_current"),
                "power_factor": res.get("power_factor"),
                "current_density": res.get("current_density"),
            }
            res["_target_power_kw"] = params[i].get("power")
            bad = check_truth(tag, res, truth_probe)
        if bad:
            row["truth_status"] = "pending_rmxprt"
            row["truth_error"] = "真值被门拒收: " + ",".join(bad)
            still_pending.append(tag)
            print(f"  [拒收] {tag}: {row['truth_error']}")
            continue
        row["truth"] = {
            "efficiency_pct": round(float(eff), 3),
            "total_loss": res.get("total_loss"),
            "copper_loss": res.get("copper_loss"),
            "iron_loss": res.get("iron_loss"),
            "b_tooth": round(float(bt), 4),
            "b_yoke": round(float(by), 4),
            "b_gap": round(float(bg), 4),
            "slip": res.get("slip"),
            "torque": res.get("torque"),
            "breakdown_torque": res.get("breakdown_torque"),
            "starting_torque": res.get("starting_torque"),
            "stator_current": res.get("stator_current"),
            "power_factor": res.get("power_factor"),
            "current_density": res.get("current_density"),
            "slot_fill_rate": res.get("slot_fill_rate"),
            "max_temp": res.get("max_temp"),
        }
        row["truth_status"] = "rmxprt"
        row["truth_src"] = "RMxprt 实测（solve_batch/induction，run_y160_y180_rmxprt.py）"
        row["src_id"] = None
        filled += 1

    # 刷新统计
    truth_rows = [r for r in s0["rows"] if r.get("truth")]
    s0["stats"]["filled_by_rmxprt"] = filled
    s0["stats"]["still_pending"] = still_pending
    s0["stats"]["rows_with_truth"] = len(truth_rows)

    with open(S0, "w", encoding="utf-8") as f:
        json.dump(s0, f, ensure_ascii=False, indent=2)
    print(f"回填完成: filled={filled} still_pending={still_pending}")
    print(f"S0 数据集带真值行: {len(truth_rows)}/{len(s0['rows'])}")
    for r in s0["rows"]:
        if r.get("truth_status") in ("rmxprt", "pending_rmxprt") and r["tag"].startswith("Y1"):
            t = r.get("truth") or {}
            print(f"  {r['tag']}: status={r['truth_status']} "
                  f"eff={t.get('efficiency_pct')} Bt={t.get('b_tooth')} "
                  f"By={t.get('b_yoke')} Bg={t.get('b_gap')} "
                  f"slip={t.get('slip')}")
    return 0 if not still_pending else 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python update_s0_with_truth.py <results.json>")
        sys.exit(3)
    sys.exit(main(sys.argv[1]))
