#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probe_slot_geom.py — 取回「生产链路真正喂给 RMxprt 的定子槽形」

动机（证伪自身）：
  真机域 K(预测/真值)=0.718 的结论建立在「解析吃真机设计齿宽 3.92mm」这一假设上。
  但 RMxprt 的 Bt 真值 1.39767T / Bg 0.630078T 可反解其**实际使用的齿宽** ≈ 7.04mm，
  与 3.92mm 差 1.8×。若属实，则「双域 K 分离 34%」可能是**输入不同源造成的假象**，
  而非真实物理域差异 —— 这会推翻"需补 ≥30 台真机才能定标"的前提。

本脚本：
  1. 复制 RMxprt 官方模板 yz200-6.aedt，调用**生产同一函数** modify_aedt_text()
     （不重实现缩放逻辑，杜绝口径漂移）；
  2. 解析改写后的 Stator / Slot 段，取回 OD/ID/Qs/StackingFactor/SlotType 与
     Hs0/Hs1/Hs2/Bs0/Bs1/Bs2/ToothWidth；
  3. 由槽形反算齿宽沿径向的分布（顶/中/根），供与 RMxprt 真值反解的齿宽对拍。

用法：
  python dev-calib/probe_slot_geom.py
"""
import io
import json
import math
import os
import re
import shutil
import sys
import tempfile

SCRIPTS = r"D:/MotorDesign/Scripts"
sys.path.insert(0, SCRIPTS)
import _rmxprt_venv_worker as W  # noqa: E402

TPL = W.get_template_path("induction")

# 两台已有真值的真机（与 y160_y180_rmxprt_params.json 同口径）
MACHINES = [
    {"tag": "Y160L-4", "stator_od": 260, "stator_id": 170, "air_gap": 0.51,
     "slots_stator": 36, "slots_rotor": 28, "poles": 4, "voltage": 380, "speed": 1460,
     "frequency": 50, "core_length": 195, "power": 15, "turns_per_coil": 31,
     "wire_dia": 1.25, "n_strands": 4, "parallel_circuits": 1, "connection": "star",
     "motor_type": "induction", "shaft_dia": 42, "rotor_od": 168.98,
     "conductors_per_slot": 15, "tooth_width": 3.92, "yoke_thickness": 22.51,
     "truth": {"Bt": 1.39767, "By": 1.4845, "Bg": 0.630078}},
    {"tag": "Y180M-4", "stator_od": 290, "stator_id": 187, "air_gap": 0.55,
     "slots_stator": 48, "slots_rotor": 44, "poles": 4, "voltage": 380, "speed": 1470,
     "frequency": 50, "core_length": 175, "power": 18.5, "turns_per_coil": 25,
     "wire_dia": 1.4, "n_strands": 4, "parallel_circuits": 1, "connection": "star",
     "motor_type": "induction", "shaft_dia": 48, "rotor_od": 185.9,
     "conductors_per_slot": 11, "tooth_width": 3.23, "yoke_thickness": 24.76,
     "truth": {"Bt": 1.42464, "By": 1.51724, "Bg": 0.651108}},
]


def _num(s):
    m = re.search(r"([-\d.eE+]+)", str(s))
    return float(m.group(1)) if m else None


def parse_block(text, name):
    """取 $begin 'name' ... $end 'name' 段内 key='val' / key=val 的键值"""
    b = text.find("$begin '%s'" % name)
    if b < 0:
        return {}
    e = text.find("$end '%s'" % name, b)
    seg = text[b:e if e > 0 else len(text)]
    out = {}
    for m in re.finditer(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:'([^']*)'|([-\d.eE+]+))", seg, re.M):
        out[m.group(1)] = m.group(2) if m.group(2) is not None else m.group(3)
    return out


def tooth_profile(st, sl):
    """由槽形反算齿宽沿径向分布。返回 dict。

    径向分层（RMxprt 定子槽通用约定）：
      D0 = 内径（齿顶面）
      D1 = D0 + 2*Hs0      （槽口底 / 槽楔位）
      D2 = D1 + 2*Hs1      （槽肩 = 槽身起点）
      D3 = D2 + 2*Hs2      （槽底）
    齿宽 = 该直径齿距 π·D/Qs − 该处槽宽。
      槽身处顶宽用 Bs1（槽身起点槽宽），底宽用 Bs2（槽底槽宽）。
    """
    d0 = _num(st.get("InnerDiameter"))
    q = int(_num(st.get("NumberOfSlots")) or 0)
    hs0 = _num(sl.get("Hs0")) or 0.0
    hs1 = _num(sl.get("Hs1")) or 0.0
    hs2 = _num(sl.get("Hs2")) or 0.0
    bs0 = _num(sl.get("Bs0")) or 0.0
    bs1 = _num(sl.get("Bs1")) or 0.0
    bs2 = _num(sl.get("Bs2")) or 0.0
    d1, d2, d3 = d0 + 2 * hs0, d0 + 2 * (hs0 + hs1), d0 + 2 * (hs0 + hs1 + hs2)
    pitch = lambda d: math.pi * d / q  # noqa: E731
    return {
        "D0": round(d0, 3), "D1": round(d1, 3), "D2": round(d2, 3), "D3": round(d3, 3),
        "pitch_D0": round(pitch(d0), 3), "pitch_D2": round(pitch(d2), 3), "pitch_D3": round(pitch(d3), 3),
        "tw_at_D0_minus_Bs0": round(pitch(d0) - bs0, 3),
        "tw_at_D1_minus_Bs0": round(pitch(d1) - bs0, 3),
        "tw_top_D2_minus_Bs1": round(pitch(d2) - bs1, 3),
        "tw_root_D3_minus_Bs2": round(pitch(d3) - bs2, 3),
        "tw_avg_top_root": round(((pitch(d2) - bs1) + (pitch(d3) - bs2)) / 2, 3),
    }


def main():
    print("模板:", TPL)
    out = []
    for m in MACHINES:
        params = {k: v for k, v in m.items() if k not in ("tag", "truth")}
        params["tag"] = m["tag"]
        tmp = os.path.join(tempfile.gettempdir(), f"_probe_slot_{m['tag']}.aedt")
        shutil.copy2(TPL, tmp)
        W.modify_aedt_text(tmp, params, machine_type="induction")
        text = io.open(tmp, encoding="utf-8", errors="replace").read()
        st = parse_block(text, "Stator")
        sl = parse_block(text, "Slot")
        prof = tooth_profile(st, sl)
        rec = {"tag": m["tag"], "params_tooth_width": m["tooth_width"],
               "params_yoke": m["yoke_thickness"],
               "stator": {k: st.get(k) for k in
                          ("OuterDiameter", "InnerDiameter", "NumberOfSlots", "Length",
                           "StackingFactor", "SlotType")},
               "slot": {k: sl.get(k) for k in
                        ("Hs0", "Hs1", "Hs2", "Bs0", "Bs1", "Bs2", "Rs", "ToothWidth",
                         "AutoDesign", "ParallelTooth")},
               "tooth_profile": prof, "truth": m["truth"]}
        # RMxprt 真值反解的实际等效齿宽：Bt = Bg · pitch / (tw · kFe)
        kfe = _num(st.get("StackingFactor")) or 0.92
        bt, bg = m["truth"]["Bt"], m["truth"]["Bg"]
        pitch0 = math.pi * _num(st.get("InnerDiameter")) / int(_num(st.get("NumberOfSlots")))
        tw_implied = pitch0 * bg / (bt * kfe)
        rec["tw_implied_by_truth"] = round(tw_implied, 3)
        rec["ratio_implied_over_given"] = round(tw_implied / m["tooth_width"], 3)
        out.append(rec)

        print("\n" + "=" * 78)
        print(f"--- {m['tag']} ---")
        print("  Stator:", json.dumps(rec["stator"], ensure_ascii=False))
        print("  Slot  :", json.dumps(rec["slot"], ensure_ascii=False))
        print("  齿形  :", json.dumps(prof, ensure_ascii=False))
        print(f"  入参 tooth_width = {m['tooth_width']} mm")
        print(f"  真值反解等效齿宽 = {tw_implied:.3f} mm (Bt={bt} Bg={bg} kFe={kfe})")
        print(f"  ⇒ 反解/入参 = {rec['ratio_implied_over_given']:.3f}")
        os.remove(tmp)

    dst = r"D:/dsh-motor-ai-l0/output/p2_slot_geom_probe.json"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump({"generated_by": "dev-calib/probe_slot_geom.py",
                   "template": TPL, "rows": out}, f, ensure_ascii=False, indent=1)
    print(f"\n[done] → {dst}")


if __name__ == "__main__":
    main()
