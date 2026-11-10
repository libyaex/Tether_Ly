import { useState } from "react";
import { Async, Banner, Card, Stat } from "./ui";
import { api } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { lyd, usdt } from "../lib/format";

type Period = "7d" | "30d" | "month";
interface DayPoint { day: string; buy_volume_lyd: string; sell_volume_lyd: string; fees_lyd: string }

const H = 3_600_000, DAY = 24 * H, TRIPOLI = 2 * H; // Libya is UTC+2 year-round (no DST)
const dayStart = (t: number) => Math.floor((t + TRIPOLI) / DAY) * DAY - TRIPOLI;

function range(period: Period) {
  const today = dayStart(Date.now());
  let from = today - 6 * DAY;
  if (period === "30d") from = today - 29 * DAY;
  if (period === "month") {
    const d = new Date(today + TRIPOLI);
    from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TRIPOLI;
  }
  return { from: new Date(from).toISOString(), to: new Date(today + DAY).toISOString() };
}

/** Real figures only: every number comes from the ledger / order tables through the `api` gateway (reports.read). */
export function FinancialAnalytics() {
  const [period, setPeriod] = useState<Period>("7d");
  const [hover, setHover] = useState<number | null>(null);
  const q = useAsync(async () => {
    const r = range(period);
    const [report, series] = await Promise.all([api<any>("report.range", r), api<DayPoint[]>("report.series", r)]);
    return { report, series };
  }, [period]);

  const tabs: [Period, string][] = [["7d", "آخر 7 أيام"], ["30d", "آخر 30 يومًا"], ["month", "هذا الشهر"]];
  return (
    <Card title="الأداء المالي" sub="أرقام فعلية من الطلبات المكتملة ودفتر الأستاذ. التوقيت: طرابلس.">
      <div className="row" style={{ gap: "0.35rem", marginBottom: "1rem" }}>
        {tabs.map(([k, label]) => (
          <button key={k} className={`btn sm ${period === k ? "accent" : "ghost"}`} onClick={() => setPeriod(k)}>{label}</button>
        ))}
      </div>
      <Async state={q} lines={4}>
        {({ report: r, series }) => {
          const max = Math.max(1, ...series.map((d) => Math.max(Number(d.buy_volume_lyd), Number(d.sell_volume_lyd))));
          const step = Math.ceil(series.length / 8);
          return (
            <>
              {r.reconciliation_mismatches > 0 && (
                <Banner tone="bad" icon="alert">يوجد {r.reconciliation_mismatches} محفظة لا يطابق رصيدها الدفتر. راجع صفحة صحة النظام قبل الاعتماد على هذه الأرقام.</Banner>
              )}
              <div className="grid3" style={{ marginBottom: "1rem" }}>
                <Stat hero k="إيراد الرسوم (من الدفتر)" v={lyd(r.fee_revenue_lyd)} />
                <Stat k="حجم الشراء المكتمل" v={lyd(r.buy.completed_volume_lyd)} />
                <Stat k="حجم البيع المكتمل" v={lyd(r.sell.completed_volume_lyd)} />
                <Stat k="USDT المُباع للعملاء" v={usdt(r.buy.completed_usdt)} />
                <Stat k="USDT المستلم من العملاء" v={usdt(r.sell.completed_usdt)} />
                <Stat k="طلبات مكتملة (شراء / بيع)" v={`${r.buy.completed} / ${r.sell.completed}`} />
              </div>

              <div className="row between" style={{ marginBottom: "0.5rem" }}>
                <strong className="small">حجم التداول اليومي المكتمل (دينار)</strong>
                <span className="row small" style={{ gap: "0.85rem" }}>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#0d9488", borderRadius: 2 }} /> شراء</span>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#3b82f6", borderRadius: 2 }} /> بيع</span>
                </span>
              </div>
              <div style={{ height: 170, display: "flex", alignItems: "flex-end", gap: series.length > 14 ? 3 : 10 }}>
                {series.map((d, i) => (
                  <div key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                    style={{ flex: 1, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", position: "relative" }}>
                    {hover === i && (
                      <div style={{ position: "absolute", bottom: "100%", background: "#1e293b", color: "#fff", fontSize: "0.7rem", padding: "4px 8px", borderRadius: 4, whiteSpace: "nowrap", zIndex: 10 }}>
                        <div>شراء: {lyd(d.buy_volume_lyd)}</div>
                        <div>بيع: {lyd(d.sell_volume_lyd)}</div>
                        <div>رسوم: {lyd(d.fees_lyd)}</div>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 2, alignItems: "flex-end", width: "100%", justifyContent: "center", height: 140 }}>
                      <div style={{ width: "40%", height: `${Math.round((Number(d.buy_volume_lyd) / max) * 140)}px`, background: "#0d9488", borderRadius: "3px 3px 0 0" }} />
                      <div style={{ width: "40%", height: `${Math.round((Number(d.sell_volume_lyd) / max) * 140)}px`, background: "#3b82f6", borderRadius: "3px 3px 0 0" }} />
                    </div>
                    <div className="muted" style={{ fontSize: "0.65rem", marginTop: 4, minHeight: 14 }}>{i % step === 0 ? d.day.slice(5).replace("-", "/") : ""}</div>
                  </div>
                ))}
              </div>

              <dl className="kv small" style={{ marginTop: "1rem" }}>
                <dt>رسوم الشراء المكتملة</dt><dd>{lyd(r.buy.fees_lyd)}</dd>
                <dt>رسوم البيع المكتملة</dt><dd>{lyd(r.sell.fees_lyd)}</dd>
                <dt>رسوم مزوّد الدفع المُبلَّغ عنها (DPay)</dt><dd>{lyd(r.deposits.provider_fees_reported)}</dd>
              </dl>
              <p className="small muted">{r.net_profit_note}</p>
            </>
          );
        }}
      </Async>
    </Card>
  );
}
