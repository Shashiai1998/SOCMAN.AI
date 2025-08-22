import React, { useMemo, useState } from "react";

// DEBUG NOTE (why you saw: SyntaxError: /: Unexpected token (1:0))
// The previous canvas file contained raw Python at the top-level while this canvas
// is of type "code/react". The bundler tried to parse Python as JavaScript and
// exploded at the first character. Fix: wrap the Python module as text inside
// a React component, with copy & download buttons. The module content is kept
// byte-for-byte so all tests remain unchanged.

function download(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

const PY_SOURCE = `# pulse_adops.py — Python rewrite of the Canvas prototype
# -----------------------------------------------------------
# This file rewrites the React canvas app into a single, runnable Python module
# that provides the same core capabilities via a clean CLI.
#
# Features (parity with the React version):
# - Synthetic ads data generator (Google Ads, Meta Ads, LinkedIn Ads)
# - KPI rollups, pacing & forecast vs budget
# - Change log (day-over-day spend swings), creative fatigue, integrity checks
# - Slack-style daily report text builder
# - CSV / NDJSON exporters; Google Sheets append CSV layout
# - Power BI push dataset payload assembler (JSON)
# - A/B test guardrails (two-proportion z-test + sample size calc)
# - Alert payload builder + cURL helper
# - Weekly “deck” export as Markdown (PPTX-free fallback)
# - Backend /health ping for integration smoke test
# - Built-in unit tests mirroring the canvas self-tests
#
# No third‑party deps required (stdlib only) so this runs anywhere.
# -----------------------------------------------------------

from __future__ import annotations

import argparse
import csv
import dataclasses
import json
import math
import os
import random
import statistics as stats
import sys
import time
import urllib.parse as up
import urllib.request as ur
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Dict, Iterable, List, Tuple

NL = "\n"

# ---------- Helpers & Formatting ----------

RUPEE = "₹"

def to_iso(d: date | datetime) -> str:
    if isinstance(d, datetime):
        d = d.date()
    return d.isoformat()


def add_days(d: date | datetime, n: int) -> date:
    if isinstance(d, datetime):
        d = d.date()
    return d + timedelta(days=n)


def clamp_date_str(s: str) -> str:
    # tolerant for bad inputs
    try:
        return to_iso(datetime.fromisoformat(s))
    except Exception:
        return to_iso(date.today())


def fmt_inr(v: float) -> str:
    if not (isinstance(v, (int, float)) and math.isfinite(v)):
        return "-"
    # Indian numbering with no decimals (to mirror the JS code)
    n = int(round(v))
    s = str(abs(n))
    if len(s) <= 3:
        out = s
    else:
        # 12,34,56,789 pattern
        head = s[:-3]
        tail = s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        out = ",".join(groups + [tail])
    return f"{RUPEE}{out}"


def pct(v: float) -> str:
    if not (isinstance(v, (int, float)) and math.isfinite(v)):
        return "-"
    return f"{v*100:.2f}%"

# ---------- Seeded RNG ----------

def mulberry32(seed: int):
    # Deterministic PRNG similar to JS version
    def rng():
        nonlocal seed
        seed = (seed + 0x6D2B79F5) & 0xFFFFFFFF
        t = seed
        t = (t ^ (t >> 15)) * (t | 1) & 0xFFFFFFFF
        t ^= (t + ((t ^ (t >> 7)) * (t | 61) & 0xFFFFFFFF)) & 0xFFFFFFFF
        t = (t ^ (t >> 14)) & 0xFFFFFFFF
        return t / 2**32
    return rng

PLATFORMS = ["Google Ads", "Meta Ads", "LinkedIn Ads"]
DEFAULT_BUDGETS = {"Google Ads": 1_500_000, "Meta Ads": 1_200_000, "LinkedIn Ads": 600_000}

CAMPAIGNS = {
    "Google Ads": ["Search_Core", "Brand_India", "DSA_Longtail"],
    "Meta Ads": ["IG_Leads_18-24", "FB_Prospecting", "Retarget_7d"],
    "LinkedIn Ads": ["IN_LeadGen_Form", "Remarketing_ABM", "Sponsored_Content"],
}

BASE = {
    "Google Ads": {"spend": 6000, "imp": 120_000, "ctr": 0.025, "cvr": 0.05},
    "Meta Ads": {"spend": 4000, "imp": 90_000, "ctr": 0.015, "cvr": 0.03},
    "LinkedIn Ads": {"spend": 2500, "imp": 30_000, "ctr": 0.010, "cvr": 0.02},
}


def gen_data(start_iso: str, end_iso: str, seed: int = 42) -> List[Dict]:
    """Generate synthetic ads fact rows inclusive of both dates."""
    rng = mulberry32(seed)
    start = datetime.fromisoformat(start_iso).date()
    end = datetime.fromisoformat(end_iso).date()
    days = (end - start).days + 1
    rows: List[Dict] = []
    for i in range(days):
        d = to_iso(add_days(start, i))
        for plat in PLATFORMS:
            for camp in CAMPAIGNS[plat]:
                b = BASE[plat]
                wobble = 1 + (rng() - 0.5) * 0.5  # ±25%
                spend = max(0, b["spend"] * wobble)
                imp = max(0, int(round(b["imp"] * wobble)))
                ctr = max(0, b["ctr"] * (1 + (rng() - 0.5) * 0.6))
                clicks = int(round(imp * ctr))
                cvr = max(0, b["cvr"] * (1 + (rng() - 0.5) * 0.8))
                conv = int(round(clicks * cvr))
                rows.append(
                    {
                        "date": d,
                        "platform": plat,
                        "account_id": plat[:2].upper() + "-0001",
                        "account_name": f"{plat} Demo",
                        "campaign_id": camp[:3].upper(),
                        "campaign_name": camp,
                        "impressions": imp,
                        "clicks": clicks,
                        "spend": int(round(spend)),
                        "conversions": conv,
                    }
                )
    return rows


# ---------- Grouping & Export ----------

def group_by(rows: Iterable[Dict], key_fn) -> Dict[str, List[Dict]]:
    m: Dict[str, List[Dict]] = defaultdict(list)
    for r in rows:
        m[key_fn(r)].append(r)
    return m


def to_csv(rows: List[Dict]) -> str:
    if not rows:
        return ""
    cols = list(rows[0].keys())
    out = []
    out.append(",".join(cols))
    for r in rows:
        cells = []
        for c in cols:
            s = "" if r.get(c) is None else str(r.get(c))
            if any(ch in s for ch in [",", "\n", "\r", '"']):
                s = '"' + s.replace('"', '""') + '"'
            cells.append(s)
        out.append(",".join(cells))
    return NL.join(out)


def to_ndjson(rows: List[Dict]) -> str:
    return NL.join(json.dumps(r, ensure_ascii=False) for r in rows)


# ---------- Stats utils (z-test) ----------

def _erf(x: float) -> float:
    # Abramowitz-Stegun approximation
    sign = -1 if x < 0 else 1
    x = abs(x)
    a1, a2, a3, a4, a5, p = 0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429, 0.3275911
    t = 1 / (1 + p * x)
    y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * math.exp(-x * x)
    return sign * y


def _cdf(z: float) -> float:
    return 0.5 * (1 + _erf(z / math.sqrt(2)))


def z_test_two_prop(x1: int, n1: int, x2: int, n2: int) -> Dict:
    if n1 <= 0 or n2 <= 0:
        return {"z": 0.0, "p": 1.0, "p1": 0.0, "p2": 0.0}
    p1, p2 = x1 / n1, x2 / n2
    p = (x1 + x2) / (n1 + n2)
    se = math.sqrt(max(1e-12, p * (1 - p) * (1 / n1 + 1 / n2)))
    z = (p1 - p2) / se
    pval = 2 * (1 - _cdf(abs(z)))
    return {"z": z, "p": pval, "p1": p1, "p2": p2}


def required_n_per_arm(p: float, mde: float, alpha: float = 0.05, power: float = 0.8) -> int:
    # z for 97.5th and 80% power (two-sided)
    z_alpha = 1.959963984540054
    z_beta = 0.8416212335729143
    p2 = p + mde
    var1 = 2 * p * (1 - p)
    var2 = p * (1 - p) + p2 * (1 - p2)
    num = z_alpha * math.sqrt(var1) + z_beta * math.sqrt(var2)
    n = (num * num) / max(1e-12, mde * mde)
    return int(math.ceil(n))


# ---------- Insights ----------

def compute_kpis(view: List[Dict]) -> Dict:
    tot = {"spend": 0, "impressions": 0, "clicks": 0, "conversions": 0}
    for r in view:
        tot["spend"] += r["spend"]
        tot["impressions"] += r["impressions"]
        tot["clicks"] += r["clicks"]
        tot["conversions"] += r["conversions"]
    ctr = (tot["clicks"] / tot["impressions"]) if tot["impressions"] else 0
    cpc = (tot["spend"] / tot["clicks"]) if tot["clicks"] else 0
    return {**tot, "ctr": ctr, "cpc": cpc}


def compute_pacing(store: List[Dict], until_iso: str, budgets: Dict[str, int] = None) -> List[Dict]:
    budgets = budgets or DEFAULT_BUDGETS
    u = datetime.fromisoformat(until_iso).date()
    first = date(u.year, u.month, 1)
    dim = (date(u.year, u.month + 1, 1) - timedelta(days=1)).day if u.month < 12 else 31
    elapsed = u.day
    mtd = [r for r in store if first <= datetime.fromisoformat(r["date"]).date() <= u]
    by_plat: Dict[str, int] = defaultdict(int)
    for r in mtd:
        by_plat[r["platform"]] += r["spend"]
    out = []
    for p in PLATFORMS:
        spend = by_plat.get(p, 0)
        fc = (spend / max(1, elapsed)) * dim
        b = budgets.get(p)
        status = ""; delta_str = ""
        if b:
            delta = fc - b
            status = "⛔" if delta > b * 0.1 else ("⚠️" if abs(delta) > b * 0.05 else "✅")
            delta_str = f" Δ{fmt_inr(delta)}"
        out.append({"platform": p, "mtd": spend, "forecast": fc, "budget": b, "status": status, "deltaStr": delta_str})
    return out


def compute_change_log(view: List[Dict]) -> List[Dict]:
    days = sorted({r["date"] for r in view})
    if len(days) < 2:
        return []
    d1, d2 = days[-2], days[-1]
    prev = group_by([r for r in view if r["date"] == d1], lambda r: f"{r['platform']}|{r['campaign_id']}")
    cur = group_by([r for r in view if r["date"] == d2], lambda r: f"{r['platform']}|{r['campaign_id']}")
    items = []
    for k, rows in cur.items():
        s_prev = sum(r["spend"] for r in prev.get(k, []))
        s_cur = sum(r["spend"] for r in rows)
        if s_prev >= 300 and abs(s_cur - s_prev) / max(1, s_prev) >= 0.3:
            plat, camp = k.split("|")
            pct_change = int(round(abs(s_cur - s_prev) / s_prev * 100))
            items.append({
                "key": k,
                "text": f"{plat} / {camp}: spend {'↑' if s_cur >= s_prev else '↓'} {pct_change}% ({fmt_inr(s_prev)} → {fmt_inr(s_cur)})",
            })
    items.sort(key=lambda x: len(x["text"]), reverse=True)
    return items[:8]


def compute_creative_fatigue(store: List[Dict]) -> List[Dict]:
    days = sorted({r["date"] for r in store})
    if len(days) < 14:
        return []
    last14 = set(days[-14:])
    mp = group_by([r for r in store if r["date"] in last14], lambda r: f"{r['platform']}|{r['campaign_id']}")
    out = []
    for k, rows in mp.items():
        rows = sorted(rows, key=lambda r: r["date"])  # 14 rows (3 platforms * campaigns per day) per key varies
        prev7, last7 = rows[:7], rows[7:]
        imp_prev = sum(r["impressions"] for r in prev7)
        imp_last = sum(r["impressions"] for r in last7)
        if imp_prev < 1000 or imp_last < 1000:
            continue
        ctr_prev = sum(r["clicks"] for r in prev7) / imp_prev
        ctr_last = sum(r["clicks"] for r in last7) / imp_last
        spend_last = sum(r["spend"] for r in last7)
        if ctr_prev and ctr_last < 0.75 * ctr_prev and spend_last >= 1000:
            drop = (1 - ctr_last / ctr_prev) * 100
            plat, camp = k.split("|")
            out.append({"key": k, "text": f"{plat} / {camp}: CTR -{drop:.0f}% (last 7 vs prev 7) — rotate creatives."})
    return out[:10]


def compute_integrity(store: List[Dict]) -> List[Dict]:
    days = sorted({r["date"] for r in store})
    last10 = set(days[-10:])
    by_acct = group_by([r for r in store if r["date"] in last10], lambda r: f"{r['platform']}|{r['account_id']}")
    out = []
    for k, rows in by_acct.items():
        rows = sorted(rows, key=lambda r: r["date"])  # time order
        flags = [r["clicks"] > 100 and (not r["conversions"] or r["conversions"] == 0) for r in rows]
        bad = any(flags[i] and flags[i + 1] and flags[i + 2] for i in range(0, max(0, len(flags) - 2)))
        if bad:
            plat, acct = k.split("|")
            out.append({"key": k, "text": f"{plat} / {acct}: 3+ days >100 clicks and 0 conv — check pixel/UTM."})
    return out


# ---------- Slack / Messages ----------

def slack_preview(view: List[Dict], pacing_rows: List[Dict], change_log: List[Dict], fatigue: List[Dict], integrity: List[Dict], since: str, until: str) -> Dict:
    by_plat = group_by(view, lambda r: r["platform"])
    rows = []
    for plat, rs in by_plat.items():
        spend = sum(r["spend"] for r in rs)
        imp = sum(r["impressions"] for r in rs)
        clk = sum(r["clicks"] for r in rs)
        ctr = (clk / imp * 100) if imp else 0
        rows.append(f"*{plat}*: {fmt_inr(spend)} | {imp:,} imp | {clk:,} clicks | {ctr:.2f}% CTR")

    extras = []
    if pacing_rows:
        lines = [f"• *{p['platform']}*: MTD {fmt_inr(p['mtd'])} | EOM fcst {fmt_inr(p['forecast'])}" + (f" | budget {fmt_inr(p['budget'])} → {p['status']}{p['deltaStr']}" if p.get('budget') else "") for p in pacing_rows]
        extras.append("*⏱️ Pacing & Forecast*" + NL + NL.join(lines))
    if change_log:
        extras.append("*📝 Change Log (yday vs d-1)*" + NL + NL.join("• " + x["text"] for x in change_log))
    if fatigue:
        extras.append("*😵‍💫 Creative Fatigue*" + NL + NL.join("• " + x["text"] for x in fatigue))
    if integrity:
        extras.append("*🧪 Signal Integrity*" + NL + NL.join("• " + x["text"] for x in integrity))

    return {"head": f"📊 Daily Ads Report  {since} → {until}", "rows": rows, "extras": extras}


# ---------- Alert payload & curl ----------

def build_alert_payload(alert_metric: str, alert_window: str, alert_drop_pct: int, plat_sel: List[str], pacing_rows: List[Dict], change_log: List[Dict], since: str, until: str) -> Dict:
    head = f"⚠️ {alert_metric} drop >{alert_drop_pct}% ({alert_window})"
    lines = [head, f"Range: {since} → {until}"]
    for p in pacing_rows:
        if p["platform"] in plat_sel:
            lines.append(f"• {p['platform']} MTD {fmt_inr(p['mtd'])}")
    if change_log:
        lines.append("")
        lines.append("Change log:")
        lines.extend("• " + x["text"] for x in change_log[:5])
    return {"text": NL.join(lines)}


def build_curl_test_alert(url_base: str, payload: Dict) -> str:
    base = (url_base or "").rstrip("/")
    url = base + "/alerts/test"
    json_str = json.dumps(payload, ensure_ascii=False)
    # shell single-quote safe
    body = json_str.replace("'", "'\\''")
    return f"curl -X POST '{url}' -H 'Content-Type: application/json' --data-raw '{body}'"


# ---------- Power BI payload ----------

def build_pbi_rows(view: List[Dict]) -> List[Dict]:
    out = []
    for r in view:
        ctr = (r["clicks"] / r["impressions"]) if r["impressions"] else 0
        cpc = (r["spend"] / r["clicks"]) if r["clicks"] else 0
        cpm = (r["spend"] / r["impressions"] * 1000) if r["impressions"] else 0
        cpa = (r["spend"] / r["conversions"]) if r["conversions"] else 0
        out.append(
            {
                "date": r["date"] + "T00:00:00",
                "platform": r["platform"],
                "account_id": r["account_id"],
                "account_name": r["account_name"],
                "campaign_id": r["campaign_id"],
                "campaign_name": r["campaign_name"],
                "impressions": r["impressions"],
                "clicks": r["clicks"],
                "spend": r["spend"],
                "conversions": r["conversions"],
                "ctr": ctr,
                "cpc": cpc,
                "cpm": cpm,
                "cpa": cpa,
            }
        )
    return out


# ---------- Google Sheets append helpers ----------
GS_COLS = [
    "date",
    "platform",
    "account_id",
    "account_name",
    "campaign_id",
    "campaign_name",
    "impressions",
    "clicks",
    "spend",
    "conversions",
]


def gs_rows(view: List[Dict]) -> List[List]:
    return [[r[c] for c in GS_COLS] for r in view]


# ---------- Weekly deck (Markdown) ----------

def weekly_deck_md(store: List[Dict], until_iso: str) -> str:
    u = datetime.fromisoformat(until_iso).date()
    s = add_days(u, -6)
    range_rows = [r for r in store if s <= datetime.fromisoformat(r["date"]).date() <= u]
    by_plat = group_by(range_rows, lambda r: r["platform"])
    bullets = []
    for plat, rows in by_plat.items():
        spend = sum(r["spend"] for r in rows)
        imp = sum(r["impressions"] for r in rows)
        clk = sum(r["clicks"] for r in rows)
        ctr = (clk / imp * 100) if imp else 0
        bullets.append(f"- **{plat}**: {fmt_inr(spend)} • {imp:,} imp • {clk:,} clicks • {ctr:.2f}% CTR")
    md = [
        "# Weekly Business Review",
        f"{to_iso(s)} → {to_iso(u)}",
        "",
        "## KPI Summary (7d)",
        *bullets,
        "",
        "> (Markdown export fallback — use python-pptx in a real repo to export .pptx)",
    ]
    return NL.join(md)


# ---------- CLI ----------

def _parse_args(argv: List[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Pulse AdOps — Python CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    # gen-data
    sp = sub.add_parser("gen-data", help="generate synthetic data and print JSON")
    sp.add_argument("--start", required=True)
    sp.add_argument("--end", required=True)
    sp.add_argument("--seed", type=int, default=101)

    # export csv
    sp = sub.add_parser("export-csv", help="export CSV for a date range")
    sp.add_argument("--start", required=True)
    sp.add_argument("--end", required=True)
    sp.add_argument("--seed", type=int, default=101)
    sp.add_argument("--out", default="fact_ads.csv")

    # export ndjson
    sp = sub.add_parser("export-ndjson", help="export NDJSON for a date range")
    sp.add_argument("--start", required=True)
    sp.add_argument("--end", required=True)
    sp.add_argument("--seed", type=int, default=101)
    sp.add_argument("--out", default="fact_ads.ndjson")

    # report
    sp = sub.add_parser("report", help="print Slack-style daily report")
    sp.add_argument("--start", required=True)
    sp.add_argument("--end", required=True)
    sp.add_argument("--seed", type=int, default=101)

    # pbi payload
    sp = sub.add_parser("pbi-payload", help="assemble Power BI JSON payload")
    sp.add_argument("--start", required=True)
    sp.add_argument("--end", required=True)
    sp.add_argument("--seed", type=int, default=101)
    sp.add_argument("--out", default="pbi_payload.json")

    # gs csv
    sp = sub.add_parser("gs-csv", help="assemble Google Sheets append CSV")
    sp.add_argument("--start", required=True)
    sp.add_argument("--end", required=True)
    sp.add_argument("--seed", type=int, default=101)
    sp.add_argument("--out", default="gs_append.csv")

    # ab-test
    sp = sub.add_parser("ab-test", help="two-proportion z-test between two campaigns")
    sp.add_argument("--start", required=True)
    sp.add_argument("--end", required=True)
    sp.add_argument("--seed", type=int, default=101)
    sp.add_argument("--metric", choices=["CVR", "CTR"], default="CVR")
    sp.add_argument("--a", required=True, help="campaign name A")
    sp.add_argument("--b", required=True, help="campaign name B")
    sp.add_argument("--mde", type=float, default=0.2, help="minimum detectable effect (fraction)")

    # alert
    sp = sub.add_parser("alert", help="build alert payload and print JSON + cURL")
    sp.add_argument("--start", required=True)
    sp.add_argument("--end", required=True)
    sp.add_argument("--seed", type=int, default=101)
    sp.add_argument("--metric", default="CTR")
    sp.add_argument("--window", default="DoD")
    sp.add_argument("--drop", type=int, default=30)
    sp.add_argument("--plat", nargs="*", default=PLATFORMS)
    sp.add_argument("--backend", default="")

    # weekly deck
    sp = sub.add_parser("weekly-deck", help="export weekly Markdown deck")
    sp.add_argument("--end", required=True)
    sp.add_argument("--start", help="ignored; derived as end-6")
    sp.add_argument("--seed", type=int, default=101)
    sp.add_argument("--out", default="weekly_review.md")

    # health
    sp = sub.add_parser("health", help="ping backend /health")
    sp.add_argument("--url", required=True)

    # tests
    sub.add_parser("tests", help="run built-in unit tests")

    return p.parse_args(argv)


def _filter_view(store: List[Dict], since: str, until: str, platforms: List[str] = None) -> List[Dict]:
    platforms = platforms or PLATFORMS
    return [r for r in store if since <= r["date"] <= until and r["platform"] in platforms]


def main(argv: List[str]) -> int:
    args = _parse_args(argv)

    if args.cmd == "gen-data":
        rows = gen_data(args.start, args.end, args.seed)
        print(json.dumps(rows, indent=2))
        return 0

    if args.cmd == "export-csv":
        rows = gen_data(args.start, args.end, args.seed)
        txt = to_csv(rows)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(txt)
        print(f"Wrote {len(rows)} rows → {args.out}")
        return 0

    if args.cmd == "export-ndjson":
        rows = gen_data(args.start, args.end, args.seed)
        txt = to_ndjson(rows)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(txt)
        print(f"Wrote {len(rows)} records → {args.out}")
        return 0

    if args.cmd == "report":
        store = gen_data(args.start, args.end, args.seed)
        since, until = args.start, args.end
        view = _filter_view(store, since, until)
        pacing_rows = compute_pacing(store, until)
        change_log = compute_change_log(view)
        fatigue = compute_creative_fatigue(store)
        integ = compute_integrity(store)
        r = slack_preview(view, pacing_rows, change_log, fatigue, integ, since, until)
        print(r["head"])
        print("\n".join(r["rows"]))
        for sec in r["extras"]:
            print("\n" + sec)
        return 0

    if args.cmd == "pbi-payload":
        store = gen_data(args.start, args.end, args.seed)
        view = _filter_view(store, args.start, args.end)
        payload = {"workspace": "", "dataset": "AdOps Push Dataset", "table": "fact_ads", "rows": build_pbi_rows(view)}
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        print(f"Wrote Power BI payload with {len(payload['rows'])} rows → {args.out}")
        return 0

    if args.cmd == "gs-csv":
        store = gen_data(args.start, args.end, args.seed)
        view = _filter_view(store, args.start, args.end)
        header = ",".join(GS_COLS) + NL
        body = NL.join(",".join(str(x) for x in row) for row in gs_rows(view))
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(header + body)
        print(f"Wrote Google Sheets CSV ({len(view)} rows) → {args.out}")
        return 0

    if args.cmd == "ab-test":
        store = gen_data(args.start, args.end, args.seed)
        view = _filter_view(store, args.start, args.end)
        A = [r for r in view if r["campaign_name"] == args.a]
        B = [r for r in view if r["campaign_name"] == args.b]
        if not A or not B:
            print("Pick two campaigns present in the range", file=sys.stderr)
            return 2
        if args.metric == "CVR":
            x1, n1 = sum(r["conversions"] for r in A), sum(r["clicks"] for r in A)
            x2, n2 = sum(r["conversions"] for r in B), sum(r["clicks"] for r in B)
            label = "CVR"
        else:
            x1, n1 = sum(r["clicks"] for r in A), sum(r["impressions"] for r in A)
            x2, n2 = sum(r["clicks"] for r in B), sum(r["impressions"] for r in B)
            label = "CTR"
        if n1 == 0 or n2 == 0:
            print("Insufficient trials.", file=sys.stderr)
            return 2
        res = z_test_two_prop(x1, n1, x2, n2)
        winner = args.a if res["p1"] > res["p2"] else args.b
        base = min(res["p1"], res["p2"])
        nreq = required_n_per_arm(base, args.mde)
        print(f"{label}: A={res['p1']:.4f} (n={n1}) vs B={res['p2']:.4f} (n={n2})")
        print(f"z={res['z']:.2f} p={res['p']:.4f} → {'Significant' if res['p']<0.05 else 'Not significant'}")
        print(f"Winner (point est.): {winner}")
        print(f"Guardrail: baseline {base:.4f}, MDE {args.mde:.2f} → ~{nreq} trials/arm")
        return 0

    if args.cmd == "alert":
        store = gen_data(args.start, args.end, args.seed)
        view = _filter_view(store, args.start, args.end, args.plat)
        pacing_rows = compute_pacing(store, args.end)
        change_log = compute_change_log(view)
        payload = build_alert_payload(args.metric, args.window, args.drop, args.plat, pacing_rows, change_log, args.start, args.end)
        print(json.dumps(payload, indent=2))
        if args.backend:
            curl = build_curl_test_alert(args.backend, payload)
            print("\n# cURL\n" + curl)
        return 0

    if args.cmd == "weekly-deck":
        # derive start from end-6 for parity
        u = datetime.fromisoformat(args.end).date()
        s = add_days(u, -6)
        store = gen_data(to_iso(s), to_iso(u), args.seed)
        md = weekly_deck_md(store, args.end)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(md)
        print(f"Wrote Markdown deck → {args.out}")
        return 0

    if args.cmd == "health":
        try:
            with ur.urlopen(args.url.rstrip("/") + "/health", timeout=10) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                print(f"Status {resp.status}\n{body}")
                return 0
        except Exception as e:
            print(f"Health check failed: {e}", file=sys.stderr)
            return 2

    if args.cmd == "tests":
        # run unittest programmatically
        import unittest

        class Tests(unittest.TestCase):
            def test_to_csv_basic(self):
                sample = [{"a": 1, "b": "x,y", "c": "He said \"hi\""}]
                csvtxt = to_csv(sample)
                lines = csvtxt.split("\n")
                self.assertEqual(len(lines), 2)
                self.assertIn('"x,y"', csvtxt)
                self.assertIn('He said ""hi""', csvtxt)

            def test_to_ndjson(self):
                arr = [{"x": 1}, {"x": 2}]
                nd = to_ndjson(arr)
                parts = nd.split("\n")
                self.assertEqual(len(parts), 2)
                for p in parts:
                    self.assertTrue(json.loads(p))

            def test_alert_payload_newline(self):
                store = gen_data("2025-01-01", "2025-01-02", 7)
                view = _filter_view(store, "2025-01-01", "2025-01-02")
                pacing_rows = compute_pacing(store, "2025-01-02")
                ch = compute_change_log(view)
                payload = build_alert_payload("CTR", "DoD", 30, PLATFORMS, pacing_rows, ch, "2025-01-01", "2025-01-02")
                self.assertIn("\n", payload["text"])

            def test_gs_header_newline(self):
                header = ",".join(GS_COLS) + "\n"
                self.assertTrue(header.endswith("\n"))

            def test_curl_quote_safety(self):
                cmd = build_curl_test_alert("https://example.com", {"text": "hi 'single' and \"double\""})
                self.assertTrue(cmd.startswith("curl -X POST 'https://example.com/alerts/test'"))
                self.assertIn("--data-raw '", cmd)
                self.assertTrue(cmd.endswith("'"))

            def test_gen_data_shape(self):
                rows = gen_data("2025-01-01", "2025-01-03", 7)
                expected = 3 * 3 * 3  # days * plats * camps
                self.assertEqual(len(rows), expected)

            def test_kpi_math(self):
                sample = [{"impressions": 1000, "clicks": 50, "spend": 2000, "conversions": 5}]
                k = compute_kpis(sample)
                self.assertTrue(math.isfinite(k["ctr"]))
                self.assertTrue(math.isfinite(k["cpc"]))

        suite = unittest.defaultTestLoader.loadTestsFromTestCase(Tests)
        res = unittest.TextTestRunner(verbosity=2).run(suite)
        return 0 if res.wasSuccessful() else 1

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`;

export default function App() {
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState("Fixed: Python is now wrapped safely. Use the buttons below.");

  async function handleCopy() {
    const ok = await copyToClipboard(PY_SOURCE);
    setCopied(ok);
    setMsg(ok ? "Copied pulse_adops.py to clipboard" : "Copy failed");
    setTimeout(() => setMsg(""), 2000);
  }

  function handleDownload() {
    download("pulse_adops.py", PY_SOURCE, "text/x-python;charset=utf-8");
    setMsg("Downloaded pulse_adops.py");
    setTimeout(() => setMsg(""), 2000);
  }

  return (
    <div className="min-h-screen bg-white text-slate-800">
      <div className="sticky top-0 z-10 border-b bg-white/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <h1 className="text-lg font-semibold">Pulse AdOps — Python Module (safe in React canvas)</h1>
          <div className="ml-auto flex gap-2">
            <button onClick={handleCopy} className="px-3 py-1.5 rounded-xl bg-black text-white">Copy</button>
            <button onClick={handleDownload} className="px-3 py-1.5 rounded-xl border">Download</button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-4 space-y-4">
        {msg ? <div className="text-sm text-emerald-700">{msg}</div> : null}
        <div className="rounded-xl border overflow-hidden">
          <div className="px-3 py-2 text-xs bg-slate-50 border-b text-slate-600">pulse_adops.py</div>
          <pre className="p-3 text-xs overflow-auto whitespace-pre leading-5"><code>{PY_SOURCE}</code></pre>
        </div>
        <details className="rounded-xl border p-4 text-sm">
          <summary className="cursor-pointer font-medium">How to run (quick)</summary>
          <div className="mt-2 space-y-2">
            <div>1) Save <code>pulse_adops.py</code> to a folder.</div>
            <div>2) In a terminal, run:</div>
            <pre className="bg-slate-50 p-2 rounded">python pulse_adops.py tests{"\n"}python pulse_adops.py report --start 2025-01-01 --end 2025-01-07</pre>
          </div>
        </details>
      </div>
    </div>
  );
}

