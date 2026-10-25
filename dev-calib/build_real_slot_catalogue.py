#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_real_slot_catalogue.py — 建「真机型谱 + 显式自洽槽形」 catalogue（≥30 台）

背景（2026-10-20 取证，见 output/p2_slot_geom_probe.json）：
  生产链路把 tooth_width 经 B-1 残差反驱写成 Slot.Bs1，而 Bs0/Bs1/Bs2 又被 k_slot_w
  独立缩放并钳制 ⇒ 生成 **倒梯形槽**（Y160L-4: Bs1=11.09 > Bs2=6.68），与真机梨形槽
  （槽底宽 > 槽身宽）方向相反；RMxprt 真值反解的等效齿宽 7.27mm 是入参 3.92mm 的 1.85×。
  ⇒ 「真机域 K=0.718、双域分离 34%」是**入参与求解器槽形不同源**的假象。

本脚本的取舍：
  · 型谱（Dso/Dsi/L/gap/Qs/Qr/p/P/n）取 **Y 系列真机型谱** y_series_physics.json（65 台，真实）；
  · 槽形 **显式给定**（Slot__Hs0/Hs1/Hs2/Bs0/Bs1/Bs2），不传 tooth_width / yoke_thickness，
    绕开 B-1/B-2 反驱，保证"喂给 RMxprt 的槽形" == "喂给解析的槽形"（A+C 的同源要求）；
  · 槽形为**自洽梨形槽**（槽底宽 ≥ 槽身宽，齿宽沿径向由 τ 控制），
    ⚠ 非实测冲片 —— 型谱真、槽形为工程比例生成，报告须如实标注；
  · τ = 齿根宽/齿顶宽 在 65 台间轮转铺开 {1.00,1.15,1.30,1.45,1.60}，
    使 k_shape=(1+τ)/2 覆盖 1.00~1.30，从而**直接检验等效宽模型的形式**
    （若 K(解析/真值) 由 1 单调随 k 走，则 avg/min 成立）。
  · 轭厚取真机口径 0.50×half（Y160L-4 实测 22.51/45=0.500、Y180M-4 24.76/51.5=0.481），
    对照档 0.40×half（型谱库 y_series_physics 的机械粗估）用于验证
    "轭厚过薄 ⇒ By 虚高" 是否为主因。

用法：
  python dev-calib/build_real_slot_catalogue.py --out dev-calib/real_slot_catalogue.json
"""
import argparse
import json
import math
import os

CAT = r"D:/MotorDesign/Knowledge/y_series_physics.json"

# 槽形生成参数（工程比例，诚实标注为合成槽形）
HS0_MM = 0.8          # 槽口高（半闭口槽，标准 0.5~1.0mm）
HS1_MM = 0.6          # 斜肩高
TW_RATIO = 0.47       # 齿顶宽 / 槽身起点齿距（真机平行齿典型 0.45~0.50）
TAU_SPREAD = [1.00, 1.15, 1.30, 1.45, 1.60]   # 齿根宽/齿顶宽（梯形度）轮转
BS2_PITCH_MAX = 0.75  # 槽底宽 / 槽底齿距 上界（防相邻槽重叠）
YOKE_RATIO = 0.50     # 初始轭厚比例
YOKE_RATIO_MAX = 0.68 # 轭厚上限（再厚则槽深不足）
BY_TARGET = 1.55      # 轭部磁密设计目标（用于反解轭厚，使整机物理可行）
KFE = 0.92            # 叠压系数（与模板 StackingFactor 一致）


def bg_target(power_kw):
    """气隙磁密设计分档（小机座磁负荷本来就低；用 0.75T 一刀切会让
    小机座 2 极机轭部饱和到 2.4T，非物理 —— 2026-10-20 探针实证）。"""
    if power_kw <= 1.5:
        return 0.55
    if power_kw <= 7.5:
        return 0.63
    if power_kw <= 30:
        return 0.71
    return 0.76


def yoke_from_by(Dso, Dsi, L, poles, bg):
    """按 By ≤ BY_TARGET 反解轭厚（mm），并钳在 [0.35·half, 0.68·half]。
    返回 (yoke, phi_wb, note)；note 标明是否被钳制。"""
    half = (Dso - Dsi) / 2.0
    tau_p = math.pi * Dsi / (2.0 * poles)          # mm
    phi = bg * (tau_p / 1000.0) * (L / 1000.0)     # Wb
    lfe = (L / 1000.0) * KFE
    yoke_req = phi / (2.0 * BY_TARGET * lfe) * 1000.0   # mm
    lo, hi = 0.35 * half, YOKE_RATIO_MAX * half
    y = min(max(yoke_req, lo), hi)
    note = "by_target"
    if y <= lo + 1e-9:
        note = "floor_0.35half"
    elif y >= hi - 1e-9:
        note = "cap_0.68half(可能仍饱和)"
    return round(y, 2), phi, note


def estimate_turns(poles, Dsi, L, Qs, a, V, f=50.0, Bg=0.75):
    Vph = V / math.sqrt(3)
    phi = Bg * (Dsi / 1000) * (L / 1000) / poles
    kw1 = 0.955
    Nph = Vph / (4.44 * f * kw1 * phi) if phi > 0 else 0
    return max(1, int(round(Nph * 6 * a / (2 * Qs))))


def build_slot(Dso, Dsi, Qs, tau, yoke):
    """由几何 + 给定轭厚生成自洽梨形槽；返回 (slot_dict, geom_dict) 或 (None, reason)"""
    half = (Dso - Dsi) / 2.0
    hs = half - yoke
    hs2 = hs - HS0_MM - HS1_MM
    if hs2 < 2.0:
        return None, f"槽深不足 hs2={hs2:.2f}mm<2mm (half={half:.1f} yoke={yoke:.2f})"
    D2 = Dsi + 2 * (HS0_MM + HS1_MM)
    D3 = D2 + 2 * hs2
    pitch2 = math.pi * D2 / Qs
    pitch3 = math.pi * D3 / Qs
    tw_top = TW_RATIO * pitch2
    tw_root = tau * tw_top
    # 正梯形约束：槽底宽 ≥ 槽身宽（梨形槽方向）
    tau_eff = tau
    for _ in range(40):
        bs1 = pitch2 - tw_top
        bs2 = pitch3 - tw_top * tau_eff
        if bs2 >= bs1:
            break
        tau_eff -= 0.02
        if tau_eff < 1.0:
            break
    bs1 = pitch2 - tw_top
    bs2 = pitch3 - tw_top * tau_eff
    if bs2 > BS2_PITCH_MAX * pitch3:            # 防相邻槽重叠
        bs2 = BS2_PITCH_MAX * pitch3
        tw_root_eff = pitch3 - bs2
        tau_eff = tw_root_eff / tw_top if tw_top > 0 else 1.0
    else:
        tw_root_eff = tw_top * tau_eff
    bs0 = min(max(0.45 * bs1, 2.0), 4.0)
    if not (bs0 + 0.5 <= bs1):
        return None, f"槽口宽与槽身宽冲突 Bs0={bs0:.2f} Bs1={bs1:.2f}"
    # ⚠ 注入值必须自带单引号：worker 的通用扩展 #7 用
    #   replace_in_section(content, section, prop, str(val)) 直接拼接，
    #   裸 `0.80mm` 会写成 `Hs0=0.80mm` ⇒ AEDT 报 `Slot:834: expected a '(' or '='`
    #   并弹模态框阻塞 OpenProject（2026-10-20 实测踩坑，见 output/_probe2.log）。
    q = lambda v: "'%.2fmm'" % v  # noqa: E731
    slot = {
        "Slot__Hs0": q(HS0_MM),
        "Slot__Hs1": q(HS1_MM),
        "Slot__Hs2": q(hs2),
        "Slot__Bs0": q(bs0),
        "Slot__Bs1": q(bs1),
        "Slot__Bs2": q(bs2),
    }
    tw_min = min(tw_top, tw_root_eff)
    geom = {
        "half": round(half, 2), "yoke": yoke, "slot_depth_hs": round(hs, 2),
        "D2": round(D2, 2), "D3": round(D3, 2),
        "pitch_D0": round(math.pi * Dsi / Qs, 3),
        "pitch_D2": round(pitch2, 3), "pitch_D3": round(pitch3, 3),
        "tw_top_mm": round(tw_top, 3), "tw_root_mm": round(tw_root_eff, 3),
        "tw_min_mm": round(tw_min, 3),
        "tw_avg_mm": round((tw_top + tw_root_eff) / 2, 3),
        "tw_geo_mean_mm": round(math.sqrt(tw_top * tw_root_eff), 3),
        "tw_harmonic_mm": round(2 / (1 / tw_top + 1 / tw_root_eff), 3),
        "tw_third_mm": round(tw_top + (tw_root_eff - tw_top) / 3.0, 3),
        "tau_requested": tau, "tau_effective": round(tw_root_eff / tw_top, 4),
        "k_shape_avg_over_min": round(((tw_top + tw_root_eff) / 2) / tw_min, 4),
        "Bs0": round(bs0, 2), "Bs1": round(bs1, 2), "Bs2": round(bs2, 2),
    }
    return slot, geom


def verify_roundtrip(rows, n=3):
    """自检：用生产同一函数 modify_aedt_text 改写模板，回读 Slot 段，
    断言写入值 == 期望值（防"注入静默失败/语法非法"再耗一轮 AEDT 空跑）。"""
    import io
    import re as _re
    import shutil
    import sys
    import tempfile
    sys.path.insert(0, r"D:/MotorDesign/Scripts")
    import _rmxprt_venv_worker as W

    tpl = W.get_template_path("induction")
    bad = 0
    for r in rows[:n]:
        tmp = os.path.join(tempfile.gettempdir(), f"_verify_slot_{r['tag']}.aedt")
        shutil.copy2(tpl, tmp)
        W.modify_aedt_text(tmp, r["params"], machine_type="induction")
        text = io.open(tmp, encoding="utf-8", errors="replace").read()
        b = text.find("$begin 'Slot'")
        e = text.find("$end 'Slot'", b)
        seg = text[b:e]
        got = dict(_re.findall(r"^\s*(Hs0|Hs1|Hs2|Bs0|Bs1|Bs2)\s*=\s*'([^']*)'", seg, _re.M))
        exp = {k.split("__", 1)[1]: v.strip("'") for k, v in r["params"].items()
               if k.startswith("Slot__")}
        diffs = {k: (exp[k], got.get(k)) for k in exp if got.get(k) != exp[k]}
        # 语法自检：不应出现无引号赋值（AEDT 会报 expected a '(' or '='）
        unquoted = _re.findall(r"^\s*(Hs[012]|Bs[012])\s*=\s*[^'\r\n]", seg, _re.M)
        flag = "OK " if (not diffs and not unquoted) else "BAD"
        if diffs or unquoted:
            bad += 1
        print(f"  [{flag}] {r['tag']}: 回读={got} unquoted={unquoted}")
        for k, (a, c) in diffs.items():
            print(f"         差异 {k}: 期望 {a} 实得 {c}")
        os.remove(tmp)
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=r"D:/dsh-motor-ai-l0/dev-calib/real_slot_catalogue.json")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--verify", type=int, default=0, help="改写模板回读自检 N 台")
    a = ap.parse_args()

    cat = json.load(open(CAT, encoding="utf-8"))["catalog"]
    rows, skipped = [], []
    for i, m in enumerate(cat):
        Dso = float(m["stator_od_mm"]); Dsi = float(m["stator_inner_dia_mm"])
        ag = float(m["air_gap_mm"]); L = float(m["core_length_mm"])
        Qs = int(m["slots_stator"]); Qr = int(m["slots_rotor"])
        p = int(m["poles"]); V = float(m["voltage_v"]); n = float(m["speed_rpm"])
        P = float(m["power_kw"])
        tau = TAU_SPREAD[i % len(TAU_SPREAD)]
        bg = bg_target(P)
        yoke, phi, ynote = yoke_from_by(Dso, Dsi, L, p, bg)
        slot, geom = build_slot(Dso, Dsi, Qs, tau, yoke)
        if slot is None:
            skipped.append({"model": m["model"], "reason": geom})
            continue
        geom["yoke_note"] = ynote
        geom["yoke_ratio_eff"] = round(yoke / geom["half"], 3)
        geom["bg_target"] = bg
        par = 1 if p <= 2 else 2
        tpc = estimate_turns(p, Dsi, L, Qs, par, V, Bg=bg)
        params = {
            "tag": f"{m['model']}", "model": m["model"],
            "stator_od": Dso, "stator_id": Dsi, "air_gap": ag,
            "slots_stator": Qs, "slots_rotor": Qr, "poles": p,
            "voltage": V, "speed": n, "frequency": 50.0,
            "core_length": L, "power": float(m["power_kw"]),
            "turns_per_coil": float(tpc), "conductors_per_slot": int(round(tpc)),
            "wire_dia": None, "n_strands": None, "parallel_circuits": par,
            "winding_connection": "star", "motor_type": "induction",
            "shaft_dia": round(max(14.0, 0.12 * Dso), 2),
            "rotor_od": round(Dsi - 2 * ag, 2),
        }
        params.update(slot)
        rows.append({"tag": params["tag"], "params": params, "geom": geom,
                     "yoke_for_analytic": geom["yoke"]})
        if a.limit and len(rows) >= a.limit:
            break

    doc = {
        "generated_by": "dev-calib/build_real_slot_catalogue.py",
        "catalogue_source": CAT,
        "n_models": len(rows), "n_skipped": len(skipped),
        "yoke_rule": {"by_target_T": BY_TARGET, "ratio_max": YOKE_RATIO_MAX,
                       "ratio_range": [0.35, YOKE_RATIO_MAX], "k_fe": KFE,
                       "bg_target_by_power": "<=1.5kW:0.55 <=7.5:0.63 <=30:0.71 else 0.76"},
        "slot_rules": {
            "Hs0_mm": HS0_MM, "Hs1_mm": HS1_MM, "tw_ratio_of_pitch_D2": TW_RATIO,
            "tau_spread": TAU_SPREAD, "Bs2_pitch_max": BS2_PITCH_MAX,
            "note": ("自洽梨形槽：Bs2>=Bs1（槽底宽≥槽身宽），齿宽沿径向由 tau 控制。"
                     "型谱取真机 Y 系列；槽形为工程比例合成，**非实测冲片**。"),
        },
        "caveats": [
            "型谱（Dso/Dsi/L/gap/Qs/Qr/p/P/n）为 Y 系列真机型谱，真实；",
            "定子槽形为显式工程比例合成，非实测冲片 —— 结论只能用于验证"
            "『等效齿宽模型的形式』，不能直接给出现役真机的 k 标定值；",
            "绕组为 EMF(Bg=0.75T) 合成 + RMxprt 自动选线，非真机绕组；",
            "不传 tooth_width / yoke_thickness，绕开 B-1/B-2 反驱，保证槽形同源。",
        ],
        "skipped": skipped,
        "rows": rows,
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    ks = [r["geom"]["k_shape_avg_over_min"] for r in rows]
    print(f"[done] {len(rows)} 台（跳过 {len(skipped)}）→ {a.out}")
    print(f"  k_shape(avg/min) 范围 {min(ks):.3f} ~ {max(ks):.3f}")
    print(f"  齿顶宽范围 {min(r['geom']['tw_top_mm'] for r in rows):.2f} ~ "
          f"{max(r['geom']['tw_top_mm'] for r in rows):.2f} mm")
    print(f"  轭厚范围 {min(r['geom']['yoke'] for r in rows):.2f} ~ "
          f"{max(r['geom']['yoke'] for r in rows):.2f} mm")
    from collections import Counter
    print("  轭厚来源:", dict(Counter(r["geom"]["yoke_note"] for r in rows)))
    print("  轭厚/半径向空间:", dict(Counter(round(r["geom"]["yoke_ratio_eff"], 1) for r in rows)))
    for s in skipped[:10]:
        print(f"  [skip] {s['model']}: {s['reason']}")

    if a.verify:
        print(f"\n[verify] 回读自检 {a.verify} 台 …")
        bad = verify_roundtrip(rows, a.verify)
        print(f"[verify] {'全部一致 ✅' if bad == 0 else f'{bad} 台不一致 ❌'}")


if __name__ == "__main__":
    main()
