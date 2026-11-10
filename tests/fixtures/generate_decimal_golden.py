"""Generates decimal-golden.json: expected buy/sell calculations from Python's Decimal (an implementation independent
of src/lib/decimal.ts). Rules mirror the database: USDT truncated to 6 dp, gross/fee rounded half-up to 2 dp.
Run:  python3 tests/fixtures/generate_decimal_golden.py"""
import json, random
from decimal import Decimal, ROUND_HALF_UP, ROUND_DOWN, getcontext
getcontext().prec = 60
random.seed(2026)
q = lambda x, p, m: x.quantize(Decimal(1).scaleb(-p), rounding=m)
cases = []
for _ in range(600):
    price = Decimal(random.randint(10000, 200000)) / 10000
    pct = Decimal(random.randint(0, 50000)) / 10000
    lyd = Decimal(random.randint(1, 5_000_000)) / 100
    usdt_in = Decimal(random.randint(1, 500_000_000_000)) / Decimal(10**6)
    usdt = q(lyd / price, 6, ROUND_DOWN)
    if usdt > 0:
        g = q(usdt * price, 2, ROUND_HALF_UP); f = q(g * pct / 100, 2, ROUND_HALF_UP)
        cases.append(dict(kind="buy_lyd", price=str(price), pct=str(pct), lyd=str(lyd), exp=dict(usdt=str(usdt), gross=str(g), fee=str(f), total=str(g + f))))
    g2 = q(usdt_in * price, 2, ROUND_HALF_UP); f2 = q(g2 * pct / 100, 2, ROUND_HALF_UP)
    cases.append(dict(kind="buy_usdt", price=str(price), pct=str(pct), usdt=str(usdt_in), exp=dict(usdt=str(q(usdt_in, 6, ROUND_DOWN)), gross=str(g2), fee=str(f2), total=str(g2 + f2))))
    cases.append(dict(kind="sell", price=str(price), pct=str(pct), usdt=str(usdt_in), exp=dict(gross=str(g2), fee=str(f2), net=str(g2 - f2))))
json.dump(cases, open("tests/fixtures/decimal-golden.json", "w"), separators=(",", ":"))
print(len(cases), "cases")
