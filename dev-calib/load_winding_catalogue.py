"""P2-③A: 可插拔"真实绕组 catalogue" 加载器 + CSV 模板生成.

用途: designs.db 真实绕组仅覆盖单一 55kW/4极/660V 家族 + 2 真机锚;
跨功率/跨极数(尤其中 6/8 极)的真机绕组本机缺失. 本模块提供统一接口,
用户补入外部 Y2/Y 系列绕组表(CSV)即可无缝并入 v3 真值集/回归训练.

CSV 列(真机绕组 catalogue):
  model,poles,power_kw,voltage_v,speed_rpm,frequency_hz,
  stator_od_mm,stator_id_mm,core_length_mm,air_gap_mm,
  slots_stator,slots_rotor,turns_per_coil,conductors_per_slot,
  n_strands,wire_dia_mm,parallel_circuits,winding_connection

load_winding_catalogue(path) -> list[dict] (数值列转 float/int, 坏行跳过并告警)
write_template(path, seed_from=None) -> 生成模板 CSV (含 2 真机锚作示例种子)
"""
import csv, os, math

NUM_FLOAT = ["power_kw", "voltage_v", "speed_rpm", "frequency_hz",
             "stator_od_mm", "stator_id_mm", "core_length_mm", "air_gap_mm",
             "turns_per_coil", "conductors_per_slot", "wire_dia_mm"]
NUM_INT = ["poles", "slots_stator", "slots_rotor", "n_strands", "parallel_circuits"]

FIELDS = (["model"] + NUM_INT + NUM_FLOAT + ["winding_connection"])

# 真机绕组种子(来自前序 Y160L/Y180M 实跑锚点, 供模板示例)
SEED_ANCHORS = [
    dict(model="Y160L-4", poles=4, power_kw=15.0, voltage_v=380.0, speed_rpm=1460.0,
         frequency_hz=50.0, stator_od_mm=260.0, stator_id_mm=170.0, core_length_mm=160.0,
         air_gap_mm=0.4, slots_stator=36, slots_rotor=28, turns_per_coil=22.0,
         conductors_per_slot=22, n_strands=4, wire_dia_mm=1.25, parallel_circuits=1,
         winding_connection="star"),
    dict(model="Y180M-4", poles=4, power_kw=18.5, voltage_v=380.0, speed_rpm=1470.0,
         frequency_hz=50.0, stator_od_mm=280.0, stator_id_mm=187.0, core_length_mm=190.0,
         air_gap_mm=0.45, slots_stator=48, slots_rotor=38, turns_per_coil=16.0,
         conductors_per_slot=16, n_strands=4, wire_dia_mm=1.40, parallel_circuits=2,
         winding_connection="star"),
]


def write_template(path, seed_from=None):
    """生成 catalogue CSV 模板; seed_from 为 list[dict] 用作示例行(默认 2 真机锚)."""
    rows = seed_from if seed_from is not None else SEED_ANCHORS
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in FIELDS})
    return path


def load_winding_catalogue(path):
    """读取真实绕组 catalogue CSV -> list[dict]; 数值列强转, 坏行跳过并打印告警."""
    if not os.path.exists(path):
        raise FileNotFoundError(f"catalogue 不存在: {path}")
    out = []
    with open(path, newline="", encoding="utf-8") as f:
        rd = csv.DictReader(f)
        miss = [c for c in FIELDS if c not in (rd.fieldnames or [])]
        if miss:
            raise ValueError(f"catalogue 缺列: {miss}")
        for i, row in enumerate(rd, start=2):
            try:
                rec = {"model": row["model"].strip(),
                       "winding_connection": (row.get("winding_connection") or "star").strip()}
                for k in NUM_FLOAT:
                    v = row.get(k, "")
                    rec[k] = float(v) if v not in ("", None) else None
                for k in NUM_INT:
                    v = row.get(k, "")
                    rec[k] = int(float(v)) if v not in ("", None) else None
                if rec["model"] and rec["poles"] and rec["power_kw"]:
                    out.append(rec)
                else:
                    print(f"  [warn] 第{i}行缺关键字段(model/poles/power), 跳过")
            except Exception as e:
                print(f"  [warn] 第{i}行解析失败: {e}, 跳过")
    return out


if __name__ == "__main__":
    import sys
    if len(sys.argv) >= 2 and sys.argv[1] == "template":
        p = sys.argv[2] if len(sys.argv) > 2 else r"D:/dsh-motor-ai-l0/dev-calib/winding_catalogue_template.csv"
        write_template(p)
        print(f"[template] 已生成: {p}")
        print(f"[fields] {FIELDS}")
    else:
        p = sys.argv[1] if len(sys.argv) > 1 else r"D:/dsh-motor-ai-l0/dev-calib/winding_catalogue_template.csv"
        try:
            cat = load_winding_catalogue(p)
            print(f"[load] {p}: {len(cat)} 行")
            for c in cat[:5]:
                print("   ", {k: c[k] for k in ("model", "poles", "power_kw", "voltage_v", "turns_per_coil", "wire_dia_mm")})
        except Exception as e:
            print(f"[load] 失败: {e}")
