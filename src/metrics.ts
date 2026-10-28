import type { Dataset, Defect, Deployment, Incident } from "./data.js";

const H = 3_600_000, D = 24 * H, MIN = 60_000;

// ----------------------------------------------------------------- helpers

const round = (n: number | null, d = 1) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const median = (xs: number[]) => quantile(xs, 0.5);
const pct = (n: number, d: number) => (d ? round((n / d) * 100) : null);
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const groupBy = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};

// ----------------------------------------------------------------- periods

export interface Period { from: number; to: number; label: string }

/**
 * Parses a period spec relative to the dataset's as-of date:
 * last_7_days | last_30_days | last_90_days | this_month | last_month | this_quarter |
 * last_quarter | year_to_date | all | "YYYY-MM" | "YYYY-MM-DD..YYYY-MM-DD"
 */
export function parsePeriod(spec: string | undefined, asOf: number, dataStart: number): Period {
  const s = (spec ?? "last_90_days").trim().toLowerCase();
  const end = asOf + 1;
  const a = new Date(asOf);
  const y = a.getUTCFullYear(), mo = a.getUTCMonth();
  const qStart = Math.floor(mo / 3) * 3;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^last_(\d+)_days?$/))) {
    const n = Number(m[1]);
    return { from: end - n * D, to: end, label: `last ${n} days (${day(end - n * D)} to ${day(asOf)})` };
  }
  if (s === "this_month") return { from: Date.UTC(y, mo, 1), to: end, label: `${a.toISOString().slice(0, 7)} (month to date)` };
  if (s === "last_month") return { from: Date.UTC(y, mo - 1, 1), to: Date.UTC(y, mo, 1), label: new Date(Date.UTC(y, mo - 1, 1)).toISOString().slice(0, 7) };
  if (s === "this_quarter") return { from: Date.UTC(y, qStart, 1), to: end, label: `Q${qStart / 3 + 1} ${y} (quarter to date)` };
  if (s === "last_quarter") {
    const f = Date.UTC(y, qStart - 3, 1), fy = new Date(f).getUTCFullYear(), fq = new Date(f).getUTCMonth() / 3 + 1;
    return { from: f, to: Date.UTC(y, qStart, 1), label: `Q${fq} ${fy}` };
  }
  if (s === "year_to_date") return { from: Date.UTC(y, 0, 1), to: end, label: `${y} year to date` };
  if (s === "all") return { from: dataStart, to: end, label: `all data (${day(dataStart)} to ${day(asOf)})` };
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) {
    const f = Date.UTC(+m[1], +m[2] - 1, 1);
    return { from: f, to: Date.UTC(+m[1], +m[2], 1), label: s };
  }
  if ((m = s.match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/))) {
    const f = Date.parse(m[1]), t = Date.parse(m[2]) + D;
    return { from: f, to: t, label: `${m[1]} to ${m[2]}` };
  }
  throw new Error(`Unrecognized period '${spec}'. Use last_30_days, last_90_days, this_month, last_month, this_quarter, last_quarter, year_to_date, all, YYYY-MM, or YYYY-MM-DD..YYYY-MM-DD.`);
}

/** The window of equal length immediately before `p`. */
export const previousPeriod = (p: Period): Period => {
  const len = p.to - p.from;
  return { from: p.from - len, to: p.from, label: `previous ${Math.round(len / D)} days (${day(p.from - len)} to ${day(p.from - 1)})` };
};

export const dataStart = (ds: Dataset) =>
  Math.min(...[ds.incidents[0]?.startedAt, ds.deployments[0]?.deployedAt, ds.defects[0]?.createdAt].filter((x): x is number => x != null));

const inP = (t: number, p: Period) => t >= p.from && t < p.to;
const filt = (ds: Dataset, p: Period, f: { service?: string; severity?: string }) => ({
  incidents: ds.incidents.filter((i) => inP(i.startedAt, p) && (!f.service || i.service === f.service) && (!f.severity || i.severity === f.severity.toUpperCase())),
  deployments: ds.deployments.filter((d) => inP(d.deployedAt, p) && (!f.service || d.service === f.service)),
  defects: ds.defects.filter((d) => inP(d.createdAt, p) && (!f.service || d.component === f.service)),
});

// ------------------------------------------------------------ incidents

function incidentNumbers(xs: Incident[]) {
  const resolved = xs.filter((i) => i.resolvedAt != null);
  const restoreH = resolved.map((i) => (i.resolvedAt! - i.startedAt) / H);
  const ackMin = xs.filter((i) => i.acknowledgedAt != null).map((i) => (i.acknowledgedAt! - i.detectedAt) / MIN);
  const detectMin = xs.map((i) => (i.detectedAt - i.startedAt) / MIN);
  return {
    incidents: xs.length,
    unresolved: xs.length - resolved.length,
    mttr_hours: round(mean(restoreH)),
    median_restore_hours: round(median(restoreH)),
    p90_restore_hours: round(quantile(restoreH, 0.9)),
    mtta_minutes: round(mean(ackMin), 0),
    mttd_minutes: round(mean(detectMin), 0),
    customer_detected_pct: pct(xs.filter((i) => i.detectionSource === "customer_report").length, xs.length),
  };
}

export function mttr(ds: Dataset, period: Period, opts: { service?: string; severity?: string; groupBy?: "severity" | "service" | "month" | "root_cause" } = {}) {
  const { incidents } = filt(ds, period, opts);
  const out: Record<string, unknown> = {
    period: period.label,
    definitions: {
      mttr: "Mean time to restore: incident start to resolved",
      mtta: "Mean time to acknowledge: detected to first acknowledgement",
      mttd: "Mean time to detect: incident start to detected",
    },
    overall: incidentNumbers(incidents),
  };
  const key =
    opts.groupBy === "service" ? (i: Incident) => i.service
    : opts.groupBy === "month" ? (i: Incident) => day(i.startedAt).slice(0, 7)
    : opts.groupBy === "root_cause" ? (i: Incident) => i.rootCause
    : (i: Incident) => i.severity;
  out[`by_${opts.groupBy ?? "severity"}`] = [...groupBy(incidents, key).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, xs]) => ({ [opts.groupBy ?? "severity"]: k, ...incidentNumbers(xs) }));
  return out;
}

// ------------------------------------------------------------------ DORA

/**
 * Benchmark bands. Elite thresholds follow the DORA State of DevOps reports (deploy on demand,
 * lead time and recovery under a day / an hour, low single-digit failure rate); the High/Medium
 * bands are commonly used approximations. Edit here to match your organization's targets.
 */
export const DORA_BANDS = {
  deploys_per_week_per_service: { elite: 7, high: 1, medium: 0.25 }, // higher is better
  lead_time_hours: { elite: 24, high: 168, medium: 720 }, // lower is better
  change_failure_rate_pct: { elite: 5, high: 10, medium: 15 },
  time_to_restore_hours: { elite: 1, high: 24, medium: 168 },
};
type Tier = "Elite" | "High" | "Medium" | "Low";
const TIER_RANK: Record<Tier, number> = { Elite: 3, High: 2, Medium: 1, Low: 0 };
const tierLower = (v: number | null, b: { elite: number; high: number; medium: number }): Tier | null =>
  v == null ? null : v < b.elite ? "Elite" : v < b.high ? "High" : v < b.medium ? "Medium" : "Low";
const tierLowerEq = (v: number | null, b: { elite: number; high: number; medium: number }): Tier | null =>
  v == null ? null : v <= b.elite ? "Elite" : v <= b.high ? "High" : v <= b.medium ? "Medium" : "Low";
const tierHigher = (v: number | null, b: { elite: number; high: number; medium: number }): Tier | null =>
  v == null ? null : v >= b.elite ? "Elite" : v >= b.high ? "High" : v >= b.medium ? "Medium" : "Low";

/** A deployment counts as a change failure if it was rolled back or an incident names it as the cause. */
export function failedDeployIds(ds: Dataset) {
  const ids = new Set(ds.incidents.map((i) => i.causedByDeploy).filter((x): x is string => !!x));
  for (const d of ds.deployments) if (/roll|fail|revert/.test(d.status)) ids.add(d.id);
  return ids;
}

function doraNumbers(ds: Dataset, deployments: Deployment[], incidents: Incident[], period: Period) {
  const failed = failedDeployIds(ds);
  const weeks = Math.max(1, (period.to - period.from) / (7 * D));
  const services = Math.max(1, new Set(deployments.map((d) => d.service)).size);
  const leadH = deployments.filter((d) => d.firstCommitAt != null).map((d) => (d.deployedAt - d.firstCommitAt!) / H);
  const failures = deployments.filter((d) => failed.has(d.id));
  const changeIncidents = incidents.filter((i) => i.causedByDeploy && i.resolvedAt != null);
  const restoreH = changeIncidents.map((i) => (i.resolvedAt! - i.startedAt) / H);

  const deployFreq = round(deployments.length / weeks / services, 2);
  const lead = round(median(leadH));
  const cfr = pct(failures.length, deployments.length);
  const restore = round(median(restoreH));
  return {
    deployment_frequency: { deploys: deployments.length, services, per_week_per_service: deployFreq, tier: tierHigher(deployFreq, DORA_BANDS.deploys_per_week_per_service) },
    lead_time_for_changes: { median_hours: lead, p90_hours: round(quantile(leadH, 0.9)), tier: tierLower(lead, DORA_BANDS.lead_time_hours) },
    change_failure_rate: { failed_deploys: failures.length, deploys: deployments.length, pct: cfr, tier: tierLowerEq(cfr, DORA_BANDS.change_failure_rate_pct) },
    time_to_restore: { median_hours: restore, incidents: changeIncidents.length, tier: tierLower(restore, DORA_BANDS.time_to_restore_hours) },
  };
}

export function dora(ds: Dataset, period: Period, opts: { service?: string } = {}) {
  const { deployments, incidents } = filt(ds, period, opts);
  const n = doraNumbers(ds, deployments, incidents, period);
  const tiers = [n.deployment_frequency.tier, n.lead_time_for_changes.tier, n.change_failure_rate.tier, n.time_to_restore.tier].filter((t): t is Tier => !!t);
  const weakest = tiers.length ? tiers.reduce((a, b) => (TIER_RANK[a] <= TIER_RANK[b] ? a : b)) : null;
  return {
    period: period.label,
    service: opts.service ?? "all services",
    ...n,
    overall_tier: weakest,
    overall_tier_rule: "Weakest of the four keys: delivery performance is limited by its slowest link.",
    benchmark_bands: DORA_BANDS,
  };
}

export function changeFailures(ds: Dataset, period: Period) {
  const failed = failedDeployIds(ds);
  const { deployments, incidents } = filt(ds, period, {});
  const overall = pct(deployments.filter((d) => failed.has(d.id)).length, deployments.length);
  const byService = [...groupBy(deployments, (d) => d.service).entries()].map(([service, ds_]) => {
    const fails = ds_.filter((d) => failed.has(d.id));
    const caused = incidents.filter((i) => i.service === service && i.causedByDeploy);
    const causes = [...groupBy(caused, (i) => i.rootCause).entries()].map(([c, xs]) => ({ cause: c, incidents: xs.length })).sort((a, b) => b.incidents - a.incidents);
    const rate = pct(fails.length, ds_.length) ?? 0;
    return {
      service,
      deploys: ds_.length,
      failed_deploys: fails.length,
      rolled_back: ds_.filter((d) => /roll/.test(d.status)).length,
      change_failure_rate_pct: rate,
      incidents_caused: caused.length,
      top_root_causes: causes.slice(0, 3),
      flag: overall != null && ds_.length >= 5 && rate >= 2 * overall ? "HOTSPOT: more than 2x the overall change failure rate" : undefined,
    };
  });
  return { period: period.label, overall_change_failure_rate_pct: overall, by_service: byService.sort((a, b) => b.change_failure_rate_pct - a.change_failure_rate_pct) };
}

// --------------------------------------------------------------- defects

/** Days a defect may stay open before it breaches SLA. Edit to match your policy. */
export const DEFECT_SLA_DAYS: Record<string, number> = { Critical: 2, High: 7, Medium: 30, Low: 90 };
const isOpen = (d: Defect, at: number) => d.createdAt <= at && (d.resolvedAt == null || d.resolvedAt > at);

export function defectMetrics(ds: Dataset, period: Period, opts: { component?: string } = {}) {
  const { defects } = filt(ds, period, { service: opts.component });
  const escaped = defects.filter((d) => d.foundIn === "production");
  const resolvedInP = ds.defects.filter((d) => d.resolvedAt != null && inP(d.resolvedAt, period) && (!opts.component || d.component === opts.component));
  const byComponent = [...groupBy(defects, (d) => d.component).entries()]
    .map(([component, xs]) => ({
      component,
      defects: xs.length,
      escaped_to_production: xs.filter((d) => d.foundIn === "production").length,
      escape_rate_pct: pct(xs.filter((d) => d.foundIn === "production").length, xs.length),
      critical_high: xs.filter((d) => d.priority === "Critical" || d.priority === "High").length,
    }))
    .sort((a, b) => (b.escape_rate_pct ?? 0) - (a.escape_rate_pct ?? 0));
  const byPriority = ["Critical", "High", "Medium", "Low"].map((p) => {
    const xs = resolvedInP.filter((d) => d.priority === p);
    return {
      priority: p,
      created: defects.filter((d) => d.priority === p).length,
      resolved: xs.length,
      mean_days_to_resolve: round(mean(xs.map((d) => (d.resolvedAt! - d.createdAt) / D))),
      sla_days: DEFECT_SLA_DAYS[p],
      resolved_within_sla_pct: pct(xs.filter((d) => (d.resolvedAt! - d.createdAt) / D <= DEFECT_SLA_DAYS[p]).length, xs.length),
    };
  });
  return {
    period: period.label,
    component: opts.component ?? "all components",
    created: defects.length,
    resolved: resolvedInP.length,
    net_backlog_change: defects.length - resolvedInP.length,
    escape_rate_pct: pct(escaped.length, defects.length),
    escape_rate_definition: "Share of defects first found in production (vs. QA or staging)",
    reopen_rate_pct: pct(defects.filter((d) => d.reopenedCount > 0).length, defects.length),
    by_component: byComponent,
    by_priority: byPriority,
  };
}

export function defectAging(ds: Dataset, opts: { component?: string; priority?: string } = {}) {
  const at = ds.asOf;
  const open = ds.defects.filter((d) => isOpen(d, at) && (!opts.component || d.component === opts.component) && (!opts.priority || d.priority.toLowerCase() === opts.priority.toLowerCase()));
  const ageOf = (d: Defect) => (at - d.createdAt) / D;
  const buckets = [
    ["0-7 days", 0, 7], ["8-30 days", 7, 30], ["31-60 days", 30, 60], ["61-90 days", 60, 90], ["90+ days", 90, Infinity],
  ] as const;
  const breaches = open
    .filter((d) => ageOf(d) > DEFECT_SLA_DAYS[d.priority])
    .map((d) => ({
      key: d.key, summary: d.summary, priority: d.priority, component: d.component, status: d.status, found_in: d.foundIn,
      age_days: round(ageOf(d)), sla_days: DEFECT_SLA_DAYS[d.priority], days_over_sla: round(ageOf(d) - DEFECT_SLA_DAYS[d.priority]),
    }))
    .sort((a, b) => ["Critical", "High", "Medium", "Low"].indexOf(a.priority) - ["Critical", "High", "Medium", "Low"].indexOf(b.priority) || (b.days_over_sla ?? 0) - (a.days_over_sla ?? 0));
  return {
    as_of: day(at),
    open_defects: open.length,
    by_priority: ["Critical", "High", "Medium", "Low"].map((p) => ({ priority: p, open: open.filter((d) => d.priority === p).length, over_sla: breaches.filter((b) => b.priority === p).length })),
    age_buckets: buckets.map(([label, lo, hi]) => ({ age: label, open: open.filter((d) => ageOf(d) >= lo && ageOf(d) < hi).length })),
    median_age_days: round(median(open.map(ageOf))),
    sla_policy_days: DEFECT_SLA_DAYS,
    sla_breaches: breaches,
  };
}

// ----------------------------------------------------------------- trends

export const TREND_METRICS = [
  "mttr_hours", "mtta_minutes", "mttd_minutes", "incidents", "customer_detected_pct",
  "deploys_per_week_per_service", "lead_time_hours", "change_failure_rate_pct",
  "defects_created", "escape_rate_pct", "open_defects_end_of_month",
] as const;
export type TrendMetric = (typeof TREND_METRICS)[number];

function monthsBetween(from: number, to: number) {
  const out: Period[] = [];
  const s = new Date(from);
  for (let y = s.getUTCFullYear(), m = s.getUTCMonth(); Date.UTC(y, m, 1) < to; m++) {
    const f = Date.UTC(y, m, 1), t = Date.UTC(y, m + 1, 1);
    out.push({ from: f, to: Math.min(t, to), label: new Date(f).toISOString().slice(0, 7) });
  }
  return out;
}

export function kpisFor(ds: Dataset, p: Period, opts: { service?: string } = {}) {
  const { incidents, deployments, defects } = filt(ds, p, opts);
  const inc = incidentNumbers(incidents);
  const dn = doraNumbers(ds, deployments, incidents, p);
  const at = Math.min(p.to - 1, ds.asOf);
  return {
    mttr_hours: inc.mttr_hours,
    mtta_minutes: inc.mtta_minutes,
    mttd_minutes: inc.mttd_minutes,
    incidents: inc.incidents,
    customer_detected_pct: inc.customer_detected_pct,
    deploys_per_week_per_service: dn.deployment_frequency.per_week_per_service,
    lead_time_hours: dn.lead_time_for_changes.median_hours,
    change_failure_rate_pct: dn.change_failure_rate.pct,
    defects_created: defects.length,
    escape_rate_pct: pct(defects.filter((d) => d.foundIn === "production").length, defects.length),
    open_defects_end_of_month: ds.defects.filter((d) => isOpen(d, at) && (!opts.service || d.component === opts.service)).length,
    open_critical_high: ds.defects.filter((d) => isOpen(d, at) && (d.priority === "Critical" || d.priority === "High") && (!opts.service || d.component === opts.service)).length,
  };
}

export function trend(ds: Dataset, metric: TrendMetric, period: Period, opts: { service?: string } = {}) {
  const months = monthsBetween(period.from, period.to);
  const series = months.map((m) => ({ month: m.label, partial: m.to - m.from < 27 * D || undefined, value: kpisFor(ds, m, opts)[metric] }));
  const vals = series.map((s) => s.value).filter((v): v is number => v != null);
  const first = vals[0], last = vals[vals.length - 1];
  return {
    metric,
    lower_is_better: LOWER_IS_BETTER.has(metric),
    service: opts.service ?? "all services",
    series,
    change_first_to_last_pct: first ? round(((last - first) / first) * 100) : null,
  };
}

// ---------------------------------------------------------------- compare

const LOWER_IS_BETTER = new Set<string>(["mttr_hours", "mtta_minutes", "mttd_minutes", "incidents", "customer_detected_pct", "lead_time_hours", "change_failure_rate_pct", "escape_rate_pct", "open_defects_end_of_month", "open_critical_high", "defects_created"]);
const KPI_LABELS: Record<string, string> = {
  mttr_hours: "MTTR (hours)", mtta_minutes: "MTTA (minutes)", mttd_minutes: "MTTD (minutes)", incidents: "Incidents",
  customer_detected_pct: "Customer-detected incidents (%)", deploys_per_week_per_service: "Deploys / week / service",
  lead_time_hours: "Lead time for changes (hours, median)", change_failure_rate_pct: "Change failure rate (%)",
  defects_created: "Defects created", escape_rate_pct: "Defect escape rate (%)",
  open_defects_end_of_month: "Open defects (end of period)", open_critical_high: "Open Critical/High defects (end of period)",
};

export function comparePeriods(ds: Dataset, current: Period, baseline: Period, opts: { service?: string } = {}) {
  const a = kpisFor(ds, baseline, opts), b = kpisFor(ds, current, opts);
  const rows = (Object.keys(b) as Array<keyof typeof b>).map((k) => {
    const prev = a[k], cur = b[k];
    const change = prev != null && cur != null && prev !== 0 ? round(((cur - prev) / prev) * 100) : null;
    const lower = LOWER_IS_BETTER.has(k);
    const verdict = change == null || Math.abs(change) < 5 ? "flat" : (change < 0) === lower ? "improved" : "worse";
    return { kpi: KPI_LABELS[k] ?? k, key: k, baseline: prev, current: cur, change_pct: change, verdict };
  });
  return { current: current.label, baseline: baseline.label, service: opts.service ?? "all services", kpis: rows };
}

// -------------------------------------------------------------- insights

export interface Insight { kind: "win" | "risk"; headline: string; detail: string }

/** Rule-based findings a leader would want called out. */
export function insights(ds: Dataset, current: Period, baseline: Period): Insight[] {
  const out: Insight[] = [];
  const cmp = comparePeriods(ds, current, baseline);
  const k = Object.fromEntries(cmp.kpis.map((r) => [r.key, r]));
  const fmt = (r: any, unit = "") => `${r.baseline}${unit} → ${r.current}${unit} (${r.change_pct! > 0 ? "+" : ""}${r.change_pct}%)`;

  if (k.mttr_hours?.verdict === "improved" && k.mttr_hours.change_pct! <= -25)
    out.push({ kind: "win", headline: `Incidents are resolved ${Math.abs(k.mttr_hours.change_pct!)}% faster`, detail: `MTTR ${fmt(k.mttr_hours, "h")}.` });
  if (k.mttr_hours?.verdict === "worse" && k.mttr_hours.change_pct! >= 20)
    out.push({ kind: "risk", headline: "Incident recovery is slowing", detail: `MTTR ${fmt(k.mttr_hours, "h")}.` });
  if (k.customer_detected_pct?.verdict === "improved" && k.customer_detected_pct.change_pct! <= -25)
    out.push({ kind: "win", headline: "Fewer incidents are found by customers first", detail: `Customer-detected share ${fmt(k.customer_detected_pct, "%")}; MTTD ${fmt(k.mttd_minutes, " min")}.` });
  if (k.lead_time_hours?.verdict === "improved" && k.lead_time_hours.change_pct! <= -20)
    out.push({ kind: "win", headline: "Changes reach production faster", detail: `Median lead time ${fmt(k.lead_time_hours, "h")}.` });
  if (k.change_failure_rate_pct?.verdict === "worse" && k.change_failure_rate_pct.change_pct! >= 20)
    out.push({ kind: "risk", headline: "More deployments are causing incidents", detail: `Change failure rate ${fmt(k.change_failure_rate_pct, "%")}.` });

  for (const s of changeFailures(ds, current).by_service.filter((x) => x.flag))
    out.push({
      kind: "risk",
      headline: `${s.service} is a change-failure hotspot`,
      detail: `${s.change_failure_rate_pct}% of ${s.deploys} deploys failed (overall ${changeFailures(ds, current).overall_change_failure_rate_pct}%); top cause: ${s.top_root_causes[0]?.cause ?? "unknown"}.`,
    });

  // Component escape rate rising: last full month vs. the three months before it
  const months = monthsBetween(dataStart(ds), ds.asOf + 1).filter((m) => m.to - m.from >= 20 * D);
  if (months.length >= 4) {
    const last = months[months.length - 1], prior = months.slice(-4, -1);
    const priorP: Period = { from: prior[0].from, to: prior[prior.length - 1].to, label: "prior" };
    for (const comp of new Set(ds.defects.map((d) => d.component))) {
      const now = defectMetrics(ds, last, { component: comp }), before = defectMetrics(ds, priorP, { component: comp });
      if ((now.escape_rate_pct ?? 0) >= 20 && now.created >= 8 && (now.escape_rate_pct ?? 0) >= 1.5 * (before.escape_rate_pct ?? 0))
        out.push({ kind: "risk", headline: `Defect escape rate is climbing in ${comp}`, detail: `${now.escape_rate_pct}% of ${comp} defects were found in production in ${last.label}, up from ${before.escape_rate_pct}% over the prior three months.` });
    }
  }

  const aging = defectAging(ds);
  const crit = aging.sla_breaches.filter((b) => b.priority === "Critical");
  if (crit.length)
    out.push({ kind: "risk", headline: `${crit.length} Critical defect${crit.length > 1 ? "s" : ""} past SLA`, detail: crit.map((c) => `${c.key} "${c.summary}" (${c.component}) open ${c.age_days} days vs. ${c.sla_days}-day SLA`).join("; ") + "." });
  const highs = aging.sla_breaches.filter((b) => b.priority === "High").length;
  if (highs >= 3) out.push({ kind: "risk", headline: `${highs} High-priority defects past their 7-day SLA`, detail: "Review owners and blockers in the next triage." });
  return out;
}

// ------------------------------------------------------------- summary

export function executiveSummary(ds: Dataset, current: Period, baseline: Period): string {
  const cmp = comparePeriods(ds, current, baseline);
  const d = dora(ds, current);
  const ins = insights(ds, current, baseline);
  const wins = ins.filter((i) => i.kind === "win"), risks = ins.filter((i) => i.kind === "risk");
  const arrow = (v: string) => (v === "improved" ? "▲ improved" : v === "worse" ? "▼ worse" : "– flat");
  const pick = ["mttr_hours", "mttd_minutes", "customer_detected_pct", "change_failure_rate_pct", "lead_time_hours", "deploys_per_week_per_service", "escape_rate_pct", "open_critical_high"];
  const L: string[] = [];
  L.push(`# Engineering Quality Report`);
  L.push(`**Period:** ${current.label} · **Compared with:** ${baseline.label} · **As of:** ${day(ds.asOf)}`);
  L.push("");
  L.push("## Bottom line");
  const keyTiers = Object.entries({ "deployment frequency": d.deployment_frequency.tier, "lead time": d.lead_time_for_changes.tier, "change failure rate": d.change_failure_rate.tier, "time to restore": d.time_to_restore.tier })
    .filter(([, t]) => t) as Array<[string, Tier]>;
  const lowest = Math.min(...keyTiers.map(([, t]) => TIER_RANK[t]));
  const weakest = keyTiers.filter(([, t]) => TIER_RANK[t] === lowest).map(([n]) => n);
  const tierNote = weakest.length === keyTiers.length ? `all four keys are ${d.overall_tier}` : `held back by ${weakest.join(" and ")}`;
  L.push(`Delivery performance is **${d.overall_tier}** by DORA benchmarks (${tierNote}). ${wins.length} improvement${wins.length === 1 ? "" : "s"} and ${risks.length} risk${risks.length === 1 ? "" : "s"} need attention.`);
  L.push("");
  L.push("## Scorecard");
  L.push("| KPI | Previous | Current | Change |");
  L.push("|---|---|---|---|");
  for (const key of pick) {
    const r = cmp.kpis.find((x) => x.key === key)!;
    L.push(`| ${r.kpi} | ${r.baseline ?? "–"} | **${r.current ?? "–"}** | ${r.change_pct != null ? `${r.change_pct > 0 ? "+" : ""}${r.change_pct}% ` : ""}${arrow(r.verdict)} |`);
  }
  L.push("");
  L.push("## DORA metrics");
  L.push("| Key | Value | Tier |");
  L.push("|---|---|---|");
  L.push(`| Deployment frequency | ${d.deployment_frequency.per_week_per_service} deploys/week/service | ${d.deployment_frequency.tier} |`);
  L.push(`| Lead time for changes | ${d.lead_time_for_changes.median_hours} h median | ${d.lead_time_for_changes.tier} |`);
  L.push(`| Change failure rate | ${d.change_failure_rate.pct}% | ${d.change_failure_rate.tier} |`);
  L.push(`| Time to restore (change failures) | ${d.time_to_restore.median_hours} h median | ${d.time_to_restore.tier} |`);
  L.push("");
  L.push("## Wins");
  L.push(wins.length ? wins.map((w) => `- **${w.headline}.** ${w.detail}`).join("\n") : "- None stood out this period.");
  L.push("");
  L.push("## Risks");
  L.push(risks.length ? risks.map((r) => `- **${r.headline}.** ${r.detail}`).join("\n") : "- No significant risks detected.");
  L.push("");
  L.push("## Recommended asks");
  const asks: string[] = [];
  for (const r of risks) {
    if (r.headline.includes("hotspot")) asks.push(`Pause risky changes on ${r.headline.split(" ")[0]} until rollback and migration testing are in place.`);
    else if (r.headline.includes("escape rate")) asks.push(`Add regression coverage for ${r.headline.split(" in ").pop()} before the next release; review what testing missed on recent production defects.`);
    else if (r.headline.includes("Critical defect")) asks.push("Assign a named owner and a fix date for each Critical defect past SLA this week.");
    else if (r.headline.includes("High-priority")) asks.push("Run a focused triage on High defects past SLA.");
    else if (r.headline.includes("deployments are causing")) asks.push("Require a tested rollback plan for schema and config changes; review last period's failed deploys in the next retro.");
    else asks.push(`Investigate: ${r.headline.toLowerCase()}.`);
  }
  if (wins.some((w) => w.headline.includes("faster"))) asks.push("Keep the on-call and runbook practices that drove the MTTR gain; share them with other teams.");
  L.push(asks.length ? asks.map((a, i) => `${i + 1}. ${a}`).join("\n") : "1. Hold steady; no escalations needed.");
  return L.join("\n");
}
