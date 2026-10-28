import type { Dataset } from "./data.js";
import { comparePeriods, dataStart, defectAging, dora, insights, kpisFor, parsePeriod, type Period } from "./metrics.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const W = 560, PL = 44, PR = 12, PT = 14;

interface Series { name: string; cls: string; values: Array<number | null> }

/** One y-axis, nice ticks from zero. */
function scale(max: number, h: number, pb: number) {
  const raw = max <= 0 ? 1 : max;
  const step = [1, 2, 2.5, 5, 10].map((m) => m * 10 ** Math.floor(Math.log10(raw / 4))).find((s) => raw / s <= 5)!;
  const top = Math.ceil(raw / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return { top, ticks, y: (v: number) => PT + (1 - v / top) * (h - PT - pb) };
}

function lineChart(labels: string[], s: Series, unit: string, h = 200) {
  const pb = 28;
  const vals = s.values.map((v) => v ?? 0);
  const { ticks, y } = scale(Math.max(...vals), h, pb);
  const x = (i: number) => PL + (i * (W - PL - PR)) / Math.max(1, labels.length - 1);
  const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)] as const));
  const d = pts.filter(Boolean).map((p, i) => `${i ? "L" : "M"}${p![0].toFixed(1)},${p![1].toFixed(1)}`).join(" ");
  const band = (W - PL - PR) / labels.length;
  return `<svg viewBox="0 0 ${W} ${h}" class="chart" role="img" aria-label="${esc(s.name)} by month">
    ${ticks.map((t) => `<line class="grid" x1="${PL}" x2="${W - PR}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${PL - 8}" y="${y(t) + 4}" text-anchor="end">${t}${unit}</text>`).join("")}
    ${labels.map((l, i) => `<text class="tick" x="${x(i)}" y="${h - 8}" text-anchor="middle">${esc(l)}</text>`).join("")}
    <path class="line ${s.cls}" d="${d}"/>
    <line class="crosshair" y1="${PT}" y2="${h - pb}"/>
    ${pts.map((p) => (p ? `<circle class="dot ${s.cls}" cx="${p[0]}" cy="${p[1]}" r="4"/>` : "")).join("")}
    ${labels.map((l, i) => `<rect class="hit" x="${x(i) - band / 2}" y="${PT}" width="${band}" height="${h - PT - pb}" data-x="${x(i)}" data-tip="${esc(l)}&#10;${esc(s.name)}: ${s.values[i] ?? "–"}${esc(unit)}"/>`).join("")}
  </svg>`;
}

function barChart(labels: string[], series: Series[], unit: string, h = 200) {
  const pb = 28;
  const all = series.flatMap((s) => s.values.map((v) => v ?? 0));
  const { ticks, y } = scale(Math.max(...all), h, pb);
  const band = (W - PL - PR) / labels.length;
  const gap = 2, inner = band * 0.7, bw = (inner - gap * (series.length - 1)) / series.length;
  const base = h - pb;
  const bar = (bx: number, v: number, cls: string) => {
    const top = y(v), hh = base - top;
    if (hh <= 0.5) return "";
    const r = Math.min(4, hh, bw / 2);
    return `<path class="bar ${cls}" d="M${bx},${base} V${top + r} q0,-${r} ${r},-${r} H${bx + bw - r} q${r},0 ${r},${r} V${base} Z"/>`;
  };
  return `<svg viewBox="0 0 ${W} ${h}" class="chart" role="img" aria-label="${esc(series.map((s) => s.name).join(" and "))} by ${labels.length > 6 ? "month" : "group"}">
    ${ticks.map((t) => `<line class="grid" x1="${PL}" x2="${W - PR}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${PL - 8}" y="${y(t) + 4}" text-anchor="end">${t}${unit}</text>`).join("")}
    ${labels.map((l, i) => {
      const x0 = PL + i * band + (band - inner) / 2;
      const tip = `${l}&#10;` + series.map((s) => `${s.name}: ${s.values[i] ?? "–"}${unit}`).join("&#10;");
      return `${series.map((s, k) => bar(x0 + k * (bw + gap), s.values[i] ?? 0, s.cls)).join("")}
        <text class="tick" x="${PL + i * band + band / 2}" y="${h - 8}" text-anchor="middle">${esc(l)}</text>
        <rect class="hit" x="${PL + i * band}" y="${PT}" width="${band}" height="${base - PT}" data-tip="${esc(tip)}"/>`;
    }).join("")}
  </svg>`;
}

const legend = (series: Series[]) =>
  series.length < 2 ? "" : `<div class="legend">${series.map((s) => `<span><i class="sw ${s.cls}"></i>${esc(s.name)}</span>`).join("")}</div>`;

export function renderDashboard(ds: Dataset, current: Period, baseline: Period): string {
  const start = dataStart(ds);
  const months: Period[] = [];
  for (let d = new Date(start), y = d.getUTCFullYear(), m = d.getUTCMonth(); Date.UTC(y, m, 1) <= ds.asOf; m++) {
    const f = Date.UTC(y, m, 1);
    months.push({ from: f, to: Math.min(Date.UTC(y, m + 1, 1), ds.asOf + 1), label: new Date(f).toISOString().slice(0, 7) });
  }
  const mk = months.map((m) => kpisFor(ds, m));
  const short = (p: Period) => new Date(p.from).toLocaleString("en-US", { month: "short", timeZone: "UTC" }) + (p.to - p.from < 27 * 864e5 ? "*" : "");
  const labels = months.map(short);
  const resolvedByMonth = months.map((m) => ds.defects.filter((d) => d.resolvedAt != null && d.resolvedAt >= m.from && d.resolvedAt < m.to).length);

  const cmp = comparePeriods(ds, current, baseline);
  const k = Object.fromEntries(cmp.kpis.map((r) => [r.key, r]));
  const d = dora(ds, current);
  const ins = insights(ds, current, baseline);
  const aging = defectAging(ds);

  const tile = (key: string, label: string, unit: string, note: string) => {
    const r = k[key];
    const cls = r.verdict === "improved" ? "good" : r.verdict === "worse" ? "bad" : "flat";
    const word = r.verdict === "improved" ? "Improved" : r.verdict === "worse" ? "Worse" : "Flat";
    const icon = r.verdict === "improved" ? "▲" : r.verdict === "worse" ? "▼" : "–";
    return `<div class="card tile"><div class="k">${esc(label)}</div><div class="v">${r.current ?? "–"}<small>${esc(unit)}</small></div>
      <div class="d"><span class="status ${cls}">${icon} ${word}</span> ${r.change_pct != null ? `${r.change_pct > 0 ? "+" : ""}${r.change_pct}%` : ""} vs. ${r.baseline ?? "–"}${esc(unit)}</div><div class="n">${esc(note)}</div></div>`;
  };
  const tierRow = (name: string, value: string, tier: string | null) =>
    `<tr><td>${esc(name)}</td><td>${esc(value)}</td><td><span class="tier t-${esc((tier ?? "").toLowerCase())}">${esc(tier ?? "–")}</span></td></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Engineering Quality Report</title>
<style>
:root{color-scheme:light;--surface:#fcfcfb;--card:#fff;--border:#e6e5e0;--text:#0b0b0b;--text2:#52514e;--muted:#8a8984;--grid:#ecebe6;--s1:#2a78d6;--s2:#eb6834;--good:#0a7f0a;--bad:#c23232;--tip-bg:#0b0b0b;--tip-fg:#fcfcfb}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--surface:#1a1a19;--card:#222220;--border:#383835;--text:#f0efec;--text2:#c3c2b7;--muted:#8f8e86;--grid:#2e2e2b;--s1:#3987e5;--s2:#d95926;--good:#3fbf3f;--bad:#e66767;--tip-bg:#f0efec;--tip-fg:#1a1a19}}
:root[data-theme="dark"]{color-scheme:dark;--surface:#1a1a19;--card:#222220;--border:#383835;--text:#f0efec;--text2:#c3c2b7;--muted:#8f8e86;--grid:#2e2e2b;--s1:#3987e5;--s2:#d95926;--good:#3fbf3f;--bad:#e66767;--tip-bg:#f0efec;--tip-fg:#1a1a19}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1120px;margin:0 auto;padding:28px 16px 48px}h1{font-size:22px;margin:0}h2{font-size:15px;margin:0 0 10px}
.sub{color:var(--text2);margin:2px 0 20px}
.grid4{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px;margin-bottom:16px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(440px,100%),1fr));gap:16px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;min-width:0}
.tile .k{color:var(--text2);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.tile .v{font-size:30px;font-weight:650;margin-top:2px}.tile .v small{font-size:15px;font-weight:500;color:var(--text2);margin-left:3px}
.tile .d{font-size:12px;color:var(--text2)}.tile .n{font-size:12px;color:var(--muted);margin-top:4px}
.status{font-weight:600}.status.good{color:var(--good)}.status.bad{color:var(--bad)}.status.flat{color:var(--text2)}
.chart{width:100%;height:auto;display:block}.grid{stroke:var(--grid)}.tick{fill:var(--muted);font-size:11px}
.line{fill:none;stroke-width:2}.line.s1{stroke:var(--s1)}.dot{stroke:var(--card);stroke-width:2}.dot.s1{fill:var(--s1)}
.bar.s1{fill:var(--s1)}.bar.s2{fill:var(--s2)}.hit{fill:transparent;cursor:crosshair}.crosshair{stroke:var(--muted);stroke-dasharray:3 3;opacity:0}
.legend{display:flex;gap:16px;font-size:12px;color:var(--text2);margin:-4px 0 6px}.legend span{display:inline-flex;align-items:center;gap:6px}.sw{width:10px;height:10px;border-radius:2px;display:inline-block}.sw.s1{background:var(--s1)}.sw.s2{background:var(--s2)}
.note{font-size:12px;color:var(--muted);margin:6px 0 0}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--border);vertical-align:top}th{color:var(--text2);font-size:12px;font-weight:600}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.tier{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--border)}
.t-elite,.t-high{color:var(--good)}.t-medium{color:var(--text2)}.t-low{color:var(--bad)}
ul.ins{margin:0;padding:0;list-style:none}ul.ins li{padding:8px 0;border-bottom:1px solid var(--border)}ul.ins li:last-child{border:0}
ul.ins b{display:block}ul.ins span{color:var(--text2);font-size:13px}
.scroll{overflow-x:auto}code{font-family:ui-monospace,Menlo,monospace;font-size:12px}
#tip{position:fixed;pointer-events:none;background:var(--tip-bg);color:var(--tip-fg);padding:6px 10px;border-radius:6px;font-size:12px;white-space:pre;opacity:0;z-index:10}
footer{color:var(--muted);font-size:12px;margin-top:24px}
</style></head><body><main>
<h1>Engineering Quality Report</h1>
<p class="sub">${esc(current.label)} vs. ${esc(baseline.label)} · as of ${esc(new Date(ds.asOf).toISOString().slice(0, 10))} · generated by quality-kpi-mcp</p>

<div class="grid4">
  ${tile("mttr_hours", "MTTR", "h", `MTTA ${k.mtta_minutes.current ?? "–"} min · MTTD ${k.mttd_minutes.current ?? "–"} min`)}
  ${tile("change_failure_rate_pct", "Change failure rate", "%", `${d.change_failure_rate.failed_deploys} of ${d.change_failure_rate.deploys} deploys`)}
  ${tile("lead_time_hours", "Lead time for changes", "h", "Median, first commit to production")}
  ${tile("escape_rate_pct", "Defect escape rate", "%", "Share of defects found in production")}
</div>

<div class="grid2">
  <div class="card"><h2>Wins</h2><ul class="ins">${ins.filter((i) => i.kind === "win").map((i) => `<li><b><span class="status good">▲</span> ${esc(i.headline)}</b><span>${esc(i.detail)}</span></li>`).join("") || "<li>None stood out this period.</li>"}</ul></div>
  <div class="card"><h2>Risks</h2><ul class="ins">${ins.filter((i) => i.kind === "risk").map((i) => `<li><b><span class="status bad">▼</span> ${esc(i.headline)}</b><span>${esc(i.detail)}</span></li>`).join("") || "<li>No significant risks.</li>"}</ul></div>
</div>

<div class="grid2">
  <div class="card"><h2>MTTR by month (hours)</h2>${lineChart(labels, { name: "MTTR", cls: "s1", values: mk.map((x) => x.mttr_hours) }, "h")}</div>
  <div class="card"><h2>Change failure rate by month (%)</h2>${barChart(labels, [{ name: "Change failure rate", cls: "s1", values: mk.map((x) => x.change_failure_rate_pct) }], "%")}</div>
  <div class="card"><h2>Defects created vs. resolved</h2>${legend([{ name: "Created", cls: "s1", values: [] }, { name: "Resolved", cls: "s2", values: [] }])}${barChart(labels, [{ name: "Created", cls: "s1", values: mk.map((x) => x.defects_created) }, { name: "Resolved", cls: "s2", values: resolvedByMonth }], "")}</div>
  <div class="card"><h2>Open defects by age (as of today)</h2>${barChart(aging.age_buckets.map((b) => b.age.replace(" days", "d")), [{ name: "Open defects", cls: "s1", values: aging.age_buckets.map((b) => b.open) }], "")}<p class="note">${aging.open_defects} open · median age ${aging.median_age_days} days</p></div>
</div>
<p class="note">* Partial month.</p>

<div class="grid2" style="margin-top:16px">
  <div class="card"><h2>DORA metrics · overall <span class="tier t-${esc((d.overall_tier ?? "").toLowerCase())}">${esc(d.overall_tier)}</span></h2>
  <table><thead><tr><th>Key</th><th>Value</th><th>Tier</th></tr></thead><tbody>
  ${tierRow("Deployment frequency", `${d.deployment_frequency.per_week_per_service} / week / service`, d.deployment_frequency.tier)}
  ${tierRow("Lead time for changes", `${d.lead_time_for_changes.median_hours} h median`, d.lead_time_for_changes.tier)}
  ${tierRow("Change failure rate", `${d.change_failure_rate.pct}%`, d.change_failure_rate.tier)}
  ${tierRow("Time to restore", `${d.time_to_restore.median_hours} h median`, d.time_to_restore.tier)}
  </tbody></table><p class="note">Overall tier = weakest key. Benchmarks based on DORA State of DevOps bands.</p></div>
  <div class="card scroll"><h2>Defects past SLA</h2>
  <table><thead><tr><th>Key</th><th>Priority</th><th>Component</th><th class="num">Age (d)</th><th class="num">SLA (d)</th></tr></thead><tbody>
  ${aging.sla_breaches.slice(0, 8).map((b) => `<tr><td><code>${esc(b.key)}</code><br><span class="note">${esc(b.summary)}</span></td><td>${esc(b.priority)}</td><td>${esc(b.component)}</td><td class="num">${b.age_days}</td><td class="num">${b.sla_days}</td></tr>`).join("") || `<tr><td colspan="5">None</td></tr>`}
  </tbody></table>${aging.sla_breaches.length > 8 ? `<p class="note">+${aging.sla_breaches.length - 8} more</p>` : ""}</div>
</div>

<div class="card scroll" style="margin-top:16px"><h2>Monthly KPIs</h2>
<table><thead><tr><th>Month</th><th class="num">Incidents</th><th class="num">MTTR (h)</th><th class="num">MTTD (min)</th><th class="num">Deploys/wk/svc</th><th class="num">Lead time (h)</th><th class="num">CFR (%)</th><th class="num">Defects</th><th class="num">Escape (%)</th></tr></thead><tbody>
${months.map((m, i) => `<tr><td>${esc(m.label)}${labels[i].endsWith("*") ? "*" : ""}</td><td class="num">${mk[i].incidents}</td><td class="num">${mk[i].mttr_hours ?? "–"}</td><td class="num">${mk[i].mttd_minutes ?? "–"}</td><td class="num">${mk[i].deploys_per_week_per_service ?? "–"}</td><td class="num">${mk[i].lead_time_hours ?? "–"}</td><td class="num">${mk[i].change_failure_rate_pct ?? "–"}</td><td class="num">${mk[i].defects_created}</td><td class="num">${mk[i].escape_rate_pct ?? "–"}</td></tr>`).join("")}
</tbody></table></div>

<footer>Synthetic demo data for a fictional company. Built with quality-kpi-mcp.</footer>
</main><div id="tip" role="tooltip"></div>
<script>
const tip=document.getElementById("tip");
document.querySelectorAll(".hit").forEach(h=>{const ch=h.ownerSVGElement.querySelector(".crosshair");
h.addEventListener("mousemove",e=>{tip.textContent=h.dataset.tip.replace(/&#10;/g,"\\n");tip.style.opacity=1;tip.style.left=Math.min(e.clientX+14,innerWidth-200)+"px";tip.style.top=(e.clientY+14)+"px";if(ch&&h.dataset.x){ch.setAttribute("x1",h.dataset.x);ch.setAttribute("x2",h.dataset.x);ch.style.opacity=1}});
h.addEventListener("mouseleave",()=>{tip.style.opacity=0;if(ch)ch.style.opacity=0})});
</script></body></html>`;
}

export { parsePeriod };
