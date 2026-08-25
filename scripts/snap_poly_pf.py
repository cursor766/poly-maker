#!/usr/bin/env python3
import json, re, time, urllib.request

UA = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json",
    "Cache-Control": "no-cache",
}
PF = "https://predict.fun/zh-cn/market/val-ag1-te-2026-08-07"


def poly_events():
    req = urllib.request.Request(
        "https://gamma-api.polymarket.com/events?slug=val-ag1-te-2026-08-07",
        headers=UA,
    )
    ev = json.loads(urllib.request.urlopen(req, timeout=10).read())
    if isinstance(ev, list):
        ev = ev[0]
    for m in ev["markets"]:
        if m.get("slug") == "val-ag1-te-2026-08-07-game1":
            p = json.loads(m["outcomePrices"])
            bb = m.get("bestBid")
            ba = m.get("bestAsk")
            lt = m.get("lastTradePrice")
            if bb is not None and ba is not None and float(ba) - float(bb) <= 0.05:
                mid = (float(bb) + float(ba)) / 2
            elif lt is not None:
                mid = float(lt)
            else:
                mid = float(p[0])
            return {
                "ag": float(p[0]),
                "bb": bb,
                "ba": ba,
                "lt": lt,
                "mid": mid,
            }
    return None


def pf():
    req = urllib.request.Request(
        PF, headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"}
    )
    html = urllib.request.urlopen(req, timeout=12).read().decode("utf-8", "ignore")
    om = re.search(
        r'"@type":"Offer","name":"Map 1 Winner","price":"([0-9.]+)"', html
    )
    return float(om.group(1)) if om else None


def main():
    prev = None
    for i in range(15):
        p = poly_events()
        f = pf()
        gap = round(p["mid"] - f, 4) if p and f is not None else None
        dp = round(p["mid"] - prev["mid"], 4) if prev and p else None
        print(
            f"{i} poly_mid={p['mid']:.3f} ag={p['ag']:.3f} "
            f"bb={p['bb']} ba={p['ba']} lt={p['lt']} pf={f} gap={gap} dpoly={dp}",
            flush=True,
        )
        prev = p
        time.sleep(1.5)


if __name__ == "__main__":
    main()
