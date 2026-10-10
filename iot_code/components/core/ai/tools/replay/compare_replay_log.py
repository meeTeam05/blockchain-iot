"""Compare a board log captured with SA_AI_REPLAY=y against the expected
per-step results of the Python INT8 pipeline.

The firmware logs one "RS," line per 10s step (ai.c replay_log_step):
    RS,t_s, co ppm,stel15,twa8h,proj10,p_model,level, no2 (same 6), warmup

Run (stdlib only; any serial monitor log works, colour codes are ignored):
    idf.py monitor | tee replay.log          # wait for "replay '...' finished"
    python compare_replay_log.py replay.log  # scenario read from the log
    python compare_replay_log.py replay.log --scenario no2_event

Exit code 0 = every step matched (levels exactly, numbers within tolerance).
"""
from __future__ import annotations

import argparse
import csv
import math
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GASES = ("co", "no2")
NUM_COLS = ("ppm", "stel15_ppm", "twa8h_ppm", "proj10_ppm", "p_model")
LEVELS = {"AN_TOAN": 0, "CANH_BAO_SOM": 1, "VUOT_NGUONG": 2}

RS_RE = re.compile(r"RS,([0-9eE.,+\-naif]+)")
SCENARIO_RE = re.compile(r"replay '([a-z0-9_]+)'")


def num(s: str) -> float:
    return float(s) if s not in ("", "nan", "-nan") else math.nan


def read_log(path: Path):
    steps, scenario = {}, None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if scenario is None and (m := SCENARIO_RE.search(line)):
            scenario = m.group(1)
        m = RS_RE.search(line)
        if not m:
            continue
        v = m.group(1).rstrip(",").split(",")
        if len(v) != 1 + 6 * len(GASES) + 1:
            continue  # truncated line
        row, i = {}, 1
        for g in GASES:
            for c in NUM_COLS:
                row[f"{g}_{c}"] = num(v[i])
                i += 1
            row[f"{g}_level"] = int(v[i])
            i += 1
        steps[int(v[0])] = row
    return steps, scenario


def read_expected(scenario: str):
    rows = {}
    with open(HERE / f"replay_{scenario}_expected.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            row = {k: num(r[k]) for k in r if k != "t_s" and not k.endswith("_state")
                   and k not in ("model_ran", "warmup_or_nodata")}
            for g in GASES:
                row[f"{g}_level"] = LEVELS[r[f"{g}_state"]]
            rows[int(r["t_s"])] = row
    return rows


def close(a: float, b: float, abs_tol: float, rel_tol: float) -> bool:
    if math.isnan(a) or math.isnan(b):
        return math.isnan(a) and math.isnan(b)
    return abs(a - b) <= abs_tol + rel_tol * abs(b)


def first_times(rows: dict, gas: str):
    """t_s when the gas first reaches level 1 and level 2."""
    out = []
    for lvl in (1, 2):
        out.append(next((t for t in sorted(rows) if rows[t][f"{gas}_level"] >= lvl), None))
    return out


def fmt_t(t):
    return "-" if t is None else f"{t // 60} min {t % 60:02d} s"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("log")
    ap.add_argument("--scenario", help="co_event / no2_event (default: read from the log)")
    ap.add_argument("--p-tol", type=float, default=0.01, help="abs tolerance on p_model (1 int8 LSB = 0.0039)")
    ap.add_argument("--rel-tol", type=float, default=2e-3, help="rel tolerance on ppm/STEL/TWA/projection")
    ap.add_argument("--show", type=int, default=10, help="mismatches to print")
    args = ap.parse_args()

    got, scenario = read_log(Path(args.log))
    scenario = args.scenario or scenario
    if scenario is None:
        sys.exit("scenario not found in the log; pass --scenario")
    if not got:
        sys.exit("no RS, lines in the log (SA_AI_REPLAY off, or the AI switched off with ai_set?)")
    exp = read_expected(scenario)

    missing = [t for t in exp if t not in got]
    bad = []
    for t in sorted(exp):
        if t not in got:
            continue
        e, g = exp[t], got[t]
        for k in e:
            if k.endswith("_level"):
                ok = e[k] == g[k]
            elif k.endswith("p_model"):
                ok = close(g[k], e[k], args.p_tol, 0.0)
            else:
                ok = close(g[k], e[k], 1e-4, args.rel_tol)
            if not ok:
                bad.append((t, k, e[k], g[k]))

    print(f"scenario {scenario}: {len(exp)} expected steps, {len(got)} logged, "
          f"{len(missing)} missing, {len(bad)} mismatching values")
    for t, k, e, g in bad[: args.show]:
        print(f"  t={fmt_t(t)}  {k}: expected {e:g}, board {g:g}")
    if missing:
        print(f"  missing steps: {fmt_t(missing[0])} .. {fmt_t(missing[-1])}")

    print("\nalarm times (from the first replay sample):")
    print(f"  {'':4} {'expected L1':>14} {'board L1':>14} {'expected L2':>14} {'board L2':>14}")
    for gas in GASES:
        e1, e2 = first_times(exp, gas)
        g1, g2 = first_times({t: got[t] for t in got if t in exp}, gas)
        print(f"  {gas:4} {fmt_t(e1):>14} {fmt_t(g1):>14} {fmt_t(e2):>14} {fmt_t(g2):>14}")

    ok = not bad and not missing
    print("\nPASS" if ok else "\nFAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
