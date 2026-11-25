"""Food price index for the ski model (Nathan's idea, 23 Nov 2026): resorts compared through standard items most
places sell, chained across countries by shared items, with a country level and each resort above or below it.

Input: food/menus.csv (the Sheet's Menus tab). Output: food/price_index.csv (one row per resort with menu data) and
food/country_index.csv (one row per country with menu data). Run: python3 food/price_index.py

Model, on log prices: item price + country level (separate for meals and drinks) + resort deviation, the resort
deviation shrunk toward its country (SHRINK). Food per day = M x meal level + D x drink level (levels vs USA = 1),
with M and D fitted to the resorts whose menus give a full basket (mountain lunch main + village dinner main + coffee,
the Food basket tab's rule). Prototype and results: project doc claude/ski-food-price-index-2026-11-23.md.
"""
import collections
import csv
import math
import re
import statistics
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SHRINK = 2.0
HOT_MAIN = re.compile(r"^(main-meat|main-fish|main-veg|pasta|pizza|burger|local-staple)$")
NO_KIDS=r'kid|child|enfant|kinder|お子様|キッズ|junior|mini'
ITEMS={
 'Espresso':      dict(cat='coffee', inc=r'espres|expres|ristretto|エスプレッソ', exc=r'doubl|doppi|macchi|grand|large|latte|cappu'),
 'Coffee (black)':dict(cat='coffee', inc=r'coffee|kaffee|caf[eé]|drip|americano|コーヒー|ブレンド|kahve', exc=r'latte|cappu|espres|expres|ristretto|crème|creme|milch|irish|mocha|au lait|melange|haferl|large|grande|doubl'),
 'Cappuccino/latte':dict(cat='coffee', inc=r'cappu|capuc|latte|ラテ|crème|creme|milchkaffee|au lait|melange', exc=r'matcha|chai|macchiato|ice'),
 'Beer (draught, size unknown)':dict(cat='beer', inc=r'.', exc=r'bottle|bouteille|flasche|can\b|pitcher|jug|1l|1 l|litre|liter|maß|mass|non.?alc|alkoholfrei|sans alcool|ノンアル|小|small|kleines|0,2|0\.2|20cl|25cl|0,25|0\.25|0,3|0\.3|33cl|30cl|pfiff'),
 'Coca-Cola':     dict(cat='soft-drink', inc=r'coca|coke|cola|コーラ', exc=r'1l|1 l|1,5|1\.5|pitcher|carafe|large|0,5|0\.5|50cl'),
 'Fries':         dict(cat='snack', inc=r'\bfries\b|frites|pommes|french fry|フライドポテト|ポテトフライ|\bchips\b', exc=r'loaded|sweet potato|truffle|cheese|chili|poutine|fish|burger|nugget|chicken|steak|saucisse|wurst|sausage|schnitzel|currywurst|\(l\)|large|から|&|and|with|avec|mit'),
 'Burger':        dict(cat='burger', inc=r'burger|バーガー', exc=NO_KIDS+r'|veg|vegan|végé|tofu|fish|chicken|poulet|huhn|beyond|impossible|double|xl|big|royal|truffle|wagyu'),
 'Pizza margherita':dict(cat='pizza', inc=r'margh|マルゲリータ', exc=NO_KIDS),
 'Spaghetti bolognese':dict(cat='pasta', inc=r'bolog|ボロネーゼ|ミートソース', exc=NO_KIDS),
 'Schnitzel':     dict(cat=None, inc=r'schnitzel|escalope.{0,20}(viennoise|milanaise|pan[ée]e)|cotoletta|milanese', exc=NO_KIDS+r'|piccata|saltimbocca|wienerli|pølse|cordon|chicken|poulet|huhn|pute|turkey|sandw|burger'),
 'Curry rice':    dict(cat=None, inc=r'カレー|curry', exc=NO_KIDS+r'|wurst|udon|うどん|soup|スープ|naan|pan|パン|thai|green|red|katsu|カツ|ハンバーグ|cheese|チーズ|large|大盛'),
 'Ramen':         dict(cat=None, inc=r'ラーメン|ramen', exc=NO_KIDS+r'|大盛|large'),
}
def match(r):
  name=r[6].lower(); out=[]
  for k,d in ITEMS.items():
    if d['cat'] and r[7]!=d['cat']: continue
    if k in ('Curry rice','Ramen') and r[2]!='Japan': continue
    if re.search(d['inc'],name,re.I) and not re.search(d['exc'],name,re.I): out.append(k)
  return out
MEAL = {"Burger", "Pizza margherita", "Spaghetti bolognese", "Schnitzel", "Curry rice", "Ramen", "Fries"}


def match(r):
    name = r["Dish"].lower()
    out = []
    for k, d in ITEMS.items():
        if d["cat"] and r["Category"] != d["cat"]:
            continue
        if k in ("Curry rice", "Ramen") and r["Country"] != "Japan":
            continue
        if re.search(d["inc"], name, re.I) and not re.search(d["exc"], name, re.I):
            out.append(k)
    return out


def load(path=HERE / "menus.csv"):
    rows = list(csv.DictReader(open(path, encoding="utf-8")))
    obs, names, country, basket = collections.defaultdict(list), {}, {}, collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        try:
            p = float(r["Price US$"])
        except (TypeError, ValueError):
            continue
        if p <= 0:
            continue
        rid = r["#"]
        names[rid], country[rid] = r["Resort"], r["Country"].split("/")[0].strip()
        for k in match(r):
            obs[(rid, k)].append(p)
        if HOT_MAIN.match(r["Category"] or ""):
            basket[rid]["lunch" if r["Type"] == "mountain" else "dinner"].append(p)
        elif r["Category"] == "coffee":
            basket[rid]["coffee"].append(p)
    full = {rid: statistics.median(b["lunch"]) + statistics.median(b["dinner"]) + statistics.median(b["coffee"])
            for rid, b in basket.items() if b["lunch"] and b["dinner"] and b["coffee"]}
    return {k: statistics.median(v) for k, v in obs.items()}, names, country, full


def fit(cell, country, shrink=SHRINK):
    R = sorted({k[0] for k in cell}, key=int)
    I = sorted({k[1] for k in cell})
    C = sorted({country[r] for r in R})
    grp = lambda i: "meal" if i in MEAL else "drink"
    cols = [("i", i) for i in I] + [("c", x, g) for x in C for g in ("meal", "drink")] + [("r", r) for r in R]
    ci = {k: n for n, k in enumerate(cols)}
    A, y = [], []
    for (r, i), p in cell.items():
        row = np.zeros(len(cols))
        row[ci[("i", i)]] = row[ci[("c", country[r], grp(i))]] = row[ci[("r", r)]] = 1
        A.append(row); y.append(math.log(p))
    for r in R:
        row = np.zeros(len(cols)); row[ci[("r", r)]] = math.sqrt(shrink); A.append(row); y.append(0)
    for x in C:  # weak pull of a country's drink level toward its meal level
        row = np.zeros(len(cols)); row[ci[("c", x, "meal")]] = 0.3; row[ci[("c", x, "drink")]] = -0.3; A.append(row); y.append(0)
    for g in ("meal", "drink"):
        row = np.zeros(len(cols))
        for x in C:
            row[ci[("c", x, g)]] = 1 / len(C)
        A.append(row * 10); y.append(0)
    b, *_ = np.linalg.lstsq(np.array(A), np.array(y), rcond=None)
    return {k: b[n] for k, n in ci.items()}, grp


def main():
    cell, names, country, full = load()
    ic = collections.Counter(k[1] for k in cell)
    cell = {k: v for k, v in cell.items() if ic[k[1]] >= 3}
    b, grp = fit(cell, country)
    base = "USA"
    um, ud = b[("c", base, "meal")], b[("c", base, "drink")]
    R = sorted({k[0] for k in cell}, key=int)
    lv = lambda r, g: math.exp(b[("c", country[r], g)] + b[("r", r)] - (um if g == "meal" else ud))
    rs = [r for r in full if r in R]
    X = np.array([[lv(r, "meal"), lv(r, "drink")] for r in rs]); yv = np.array([full[r] for r in rs])
    (M, D), *_ = np.linalg.lstsq(X, yv, rcond=None)
    miss = float(np.median(abs(X @ np.array([M, D]) / yv - 1)))
    n_items = collections.Counter(k[0] for k in cell)
    with open(HERE / "price_index.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["#", "Resort", "Country", "Standard items", "Meal level (USA = 1)", "Drink level (USA = 1)",
                    "Resort vs country", "Food per day US$ (index)", "Food per day US$ (menu basket)"])
        for r in R:
            w.writerow([r, names[r], country[r], n_items[r], round(lv(r, "meal"), 3), round(lv(r, "drink"), 3),
                        f"{math.exp(b[('r', r)]) - 1:+.0%}", round(M * lv(r, "meal") + D * lv(r, "drink"), 2),
                        round(full[r], 2) if r in full else ""])
    nres = collections.Counter(country[r] for r in R)
    with open(HERE / "country_index.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["Country", "Meal level (USA = 1)", "Drink level (USA = 1)", "Food per day US$ (country level)",
                    "Resorts with menu data"])
        for x in sorted(nres, key=lambda x: -b[("c", x, "meal")]):
            m, d = math.exp(b[("c", x, "meal")] - um), math.exp(b[("c", x, "drink")] - ud)
            w.writerow([x, round(m, 3), round(d, 3), round(M * m + D * d, 2), nres[x]])
    print(f"{len(R)} resorts, {len(cell)} price points, {len(nres)} countries. Food per day = US${M:.1f} x meal level "
          f"+ US${D:.1f} x drink level; median miss against {len(rs)} full menu baskets {miss:.0%}.")


if __name__ == "__main__":
    main()
