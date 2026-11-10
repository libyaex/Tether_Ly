import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calcBuy, calcSell, cleanAmount, validAmount } from "../src/lib/decimal.ts";

const golden = JSON.parse(readFileSync(new URL("./fixtures/decimal-golden.json", import.meta.url), "utf8"));

test(`price/fee maths matches the independent Decimal reference on ${golden.length} vectors`, () => {
  const bad = [];
  for (const c of golden) {
    const got = c.kind === "buy_lyd" ? calcBuy(c.price, c.pct, { lyd: c.lyd }) : c.kind === "buy_usdt" ? calcBuy(c.price, c.pct, { usdt: c.usdt }) : calcSell(c.price, c.pct, c.usdt);
    if (!got || Object.keys(c.exp).some((k) => got[k] !== c.exp[k])) bad.push({ c, got });
  }
  assert.equal(bad.length, 0, JSON.stringify(bad.slice(0, 3)));
});

test("known example: 100 LYD at 10.45 with 1% fee", () => {
  assert.deepEqual(calcBuy("10.4500", "1.0000", { lyd: "100" }), { usdt: "9.569377", gross: "100.00", fee: "1.00", total: "101.00" });
});

test("invalid input never produces a number", () => {
  for (const bad of ["", "abc", "1e5", "-5", "5.", ".5", "0", "٥٠"]) assert.equal(calcBuy("10.4500", "1.0000", { lyd: bad }), null, JSON.stringify(bad));
  assert.equal(calcSell("10.4500", "1.0000", "abc"), null);
});

test("validAmount enforces the allowed number of decimals", () => {
  assert.equal(validAmount("10.99", 2), true);
  assert.equal(validAmount("10.999", 2), false);
  assert.equal(validAmount("1000000000000.00", 2), false);   // more than 12 integer digits
});

test("cleanAmount accepts Arabic-Indic/Persian digits and never treats commas as decimals", () => {
  assert.equal(cleanAmount("٢٥٠٫٥٠"), "250.50");
  assert.equal(cleanAmount("۱۲۳"), "123");
  assert.equal(cleanAmount("1,000"), "1000");
  assert.equal(cleanAmount("12abc.5"), "12.5");
  assert.equal(cleanAmount("-5"), "5");
});
