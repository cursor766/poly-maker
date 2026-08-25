#!/usr/bin/env python3
"""Live Map1: detect Poly moves and check if Predict.fun still lags (eatable)."""

from __future__ import annotations

import json
import re
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path("/home/lcx/poly-maker/data/poly-lead-predict-eat.ndjson")
STATUS = Path("/home/lcx/poly-maker/data/poly-lead-predict-eat.status.json")

AG = "39341488970663087578602003057453141275085799658997294709369855456419202433397"
PF_URL = "https://predict.fun/zh-cn/market/val-ag1-te-2026-08-07"
UA = {"User-Agent": "Mozilla/5.0", "Accept": "*/*"}

JUMP = 0.015
EDGE = 0.02
INTERVAL = 1.5
DURATION = 900
POLY_SLUG = "val-ag1-te-2026-08-07-game1"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_poly() -> dict:
    """Use events API nested market (fresher than /markets?slug=)."""
    req = urllib.request.Request(
        "https://gamma-api.polymarket.com/events?slug=val-ag1-te-2026-08-07",
        headers={
            **UA,
            "Accept": "application/json",
            "Cache-Control": "no-cache",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        ev = json.loads(r.read())
    if isinstance(ev, list):
        ev = ev[0]
    m = None
    for x in ev.get("markets", []):
        if x.get("slug") == POLY_SLUG:
            m = x
            break
    if not m:
        raise RuntimeError("map1 market not found in event")
    prices = json.loads(m["outcomePrices"])
    ag = float(prices[0])
    bb = float(m["bestBid"]) if m.get("bestBid") is not None else None
    ba = float(m["bestAsk"]) if m.get("bestAsk") is not None else None
    lt = float(m["lastTradePrice"]) if m.get("lastTradePrice") is not None else None

    if bb is not None and ba is not None and (ba - bb) <= 0.05:
        mid = (bb + ba) / 2
        src = "events_bbo"
    else:
        mid = ag
        src = "events_outcome"

    return {
        "bb": bb,
        "ba": ba,
        "lt": lt,
        "ag": ag,
        "mid": mid,
        "src": src,
    }


def get_pf() -> dict:
    req = urllib.request.Request(
        PF_URL,
        headers={**UA, "Cache-Control": "no-cache", "Pragma": "no-cache"},
    )
    with urllib.request.urlopen(req, timeout=12) as r:
        html = r.read().decode("utf-8", "ignore")

    # Prefer Offer schema for Map 1 (more reliable than chancePercentage scrape)
    offer = None
    om = re.search(
        r'"@type":"Offer","name":"Map 1 Winner","price":"([0-9.]+)"', html
    )
    if not om:
        om = re.search(
            r'"name":"Map 1 Winner","price":"([0-9.]+)"', html
        )
    if om:
        offer = float(om.group(1))

    chance = None
    # Bound the search to this market id block (~800 chars after id)
    m = re.search(
        r'"id":"1201882".{0,900}?"chancePercentage":(\d+|null)', html
    )
    if m and m.group(1) != "null":
        chance = int(m.group(1)) / 100.0

    ag = offer if offer is not None else chance
    return {"ag": ag, "offer": offer, "chance": chance}


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("")
    prev_poly = None
    prev_pf = None
    events: list[dict] = []
    n = 0
    print("start", now(), flush=True)
    t0 = time.time()
    while time.time() - t0 < DURATION:
        ts = now()
        poly: dict = {}
        pf: dict = {}
        err = None
        try:
            poly = get_poly()
        except Exception as e:
            err = f"poly:{e}"
        try:
            pf = get_pf()
        except Exception as e:
            err = (err + ";" if err else "") + f"pf:{e}"

        row: dict = {"ts": ts, "poly": poly, "pf": pf}
        if err:
            row["err"] = err

        # Jump detection: Poly moved first?
        if (
            prev_poly
            and poly.get("mid") is not None
            and prev_poly.get("mid") is not None
            and pf.get("ag") is not None
        ):
            dpoly = poly["mid"] - prev_poly["mid"]
            if abs(dpoly) >= JUMP:
                pf_ag = pf["ag"]
                dpf = 0.0
                if prev_pf and prev_pf.get("ag") is not None:
                    dpf = pf_ag - prev_pf["ag"]
                # edge vs current PF: if poly rose, want PF still cheap
                edge = (
                    (poly["mid"] - pf_ag) if dpoly > 0 else (pf_ag - poly["mid"])
                )
                pf_lagged = abs(dpf) < abs(dpoly) * 0.4
                if edge >= EDGE and pf_lagged:
                    verdict = {
                        "type": "EATABLE",
                        "dir": "BUY_AG_ON_PF" if dpoly > 0 else "SELL_AG_ON_PF",
                        "dpoly": round(dpoly, 4),
                        "dpf": round(dpf, 4),
                        "poly_mid": poly["mid"],
                        "pf_ag": pf_ag,
                        "edge": round(edge, 4),
                        "edge_after_2pct_fee": round(
                            edge - 0.02 * (pf_ag or 0.5), 4
                        ),
                    }
                elif edge >= EDGE:
                    verdict = {
                        "type": "EDGE_BUT_PF_MOVED",
                        "dpoly": round(dpoly, 4),
                        "dpf": round(dpf, 4),
                        "poly_mid": poly["mid"],
                        "pf_ag": pf_ag,
                        "edge": round(edge, 4),
                    }
                else:
                    verdict = {
                        "type": "POLY_JUMP_NO_EDGE",
                        "dpoly": round(dpoly, 4),
                        "dpf": round(dpf, 4),
                        "poly_mid": poly["mid"],
                        "pf_ag": pf_ag,
                        "edge": round(edge, 4),
                    }
                events.append({**verdict, "ts": ts})
                row["event"] = verdict
                print("EVENT", json.dumps(verdict, ensure_ascii=False), flush=True)

        if poly.get("mid") is not None and pf.get("ag") is not None:
            gap = round(poly["mid"] - pf["ag"], 4)
            row["gap"] = gap
            if abs(gap) >= EDGE:
                standing = {
                    "type": "STANDING_EDGE",
                    "dir": "BUY_AG_ON_PF" if gap > 0 else "SELL_AG_ON_PF",
                    "poly_mid": poly["mid"],
                    "pf_ag": pf["ag"],
                    "edge": abs(gap),
                    "gap": gap,
                    "edge_after_2pct_fee": round(
                        abs(gap) - 0.02 * (pf["ag"] or 0.5), 4
                    ),
                }
                row["standing"] = standing
                last = events[-1] if events else None
                if (
                    not last
                    or last.get("type") != "STANDING_EDGE"
                    or last.get("dir") != standing["dir"]
                    or abs(last.get("edge", 0) - standing["edge"]) >= 0.015
                ):
                    events.append({**standing, "ts": ts})
                    print(
                        "EVENT",
                        json.dumps(standing, ensure_ascii=False),
                        flush=True,
                    )

        with OUT.open("a") as f:
            f.write(json.dumps(row) + "\n")
        n += 1
        STATUS.write_text(
            json.dumps(
                {
                    "ts": ts,
                    "poly_mid": poly.get("mid"),
                    "poly_lt": poly.get("lt"),
                    "poly_ag": poly.get("ag"),
                    "poly_ba": poly.get("ba"),
                    "poly_bb": poly.get("bb"),
                    "poly_src": poly.get("src"),
                    "pf_ag": pf.get("ag"),
                    "gap": row.get("gap"),
                    "standing": row.get("standing"),
                    "events": events[-20:],
                    "n": n,
                    "err": err,
                },
                indent=2,
            )
        )
        if n % 5 == 1:
            print(
                f"hb n={n} poly={poly.get('mid')} lt={poly.get('lt')} "
                f"src={poly.get('src')} pf={pf.get('ag')} gap={row.get('gap')} "
                f"err={err}",
                flush=True,
            )
        if poly.get("mid") is not None:
            prev_poly = poly
        if pf.get("ag") is not None:
            prev_pf = pf
        time.sleep(INTERVAL)

    print("done", now(), "events", len(events), flush=True)


if __name__ == "__main__":
    main()
