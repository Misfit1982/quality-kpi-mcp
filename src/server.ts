#!/usr/bin/env node
/**
 * quality-kpi-mcp: an MCP server that answers engineering leadership's quality questions
 * from the exports teams already have (incidents, deployments, Jira bugs):
 *   "What's our MTTR this quarter and is it improving?"
 *   "How do we rank on DORA metrics?"
 *   "Which service is causing the most failed deploys?"
 *   "Write the monthly quality update for the exec team."
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadDataset } from "./data.js";
import {
  changeFailures, comparePeriods, dataStart, defectAging, defectMetrics, dora,
  executiveSummary, mttr, parsePeriod, previousPeriod, trend, TREND_METRICS,
} from "./metrics.js";
import { renderDashboard } from "./dashboard.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(process.env.KPI_DATA_DIR ?? join(ROOT, "sample-data"));
const OUTPUT_DIR = resolve(process.env.KPI_OUTPUT_DIR ?? join(ROOT, "output"));

/** Re-read on every call so fresh exports show up without restarting. */
const data = () => loadDataset(DATA_DIR);
const period = (spec?: string) => {
  const ds = data();
  return { ds, p: parsePeriod(spec, ds.asOf, dataStart(ds)) };
};

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
function safe<A>(fn: (a: A) => ReturnType<typeof json>) {
  return async (a: A) => {
    try { return fn(a); }
    catch (e) { return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true }; }
  };
}

const PERIOD = z.string().optional().describe(
  "Time window: last_30_days, last_90_days (default), this_month, last_month, this_quarter, last_quarter, year_to_date, all, YYYY-MM, or YYYY-MM-DD..YYYY-MM-DD",
);
const SERVICE = z.string().optional().describe("Limit to one service/component, e.g. 'checkout'");
const RO = { readOnlyHint: true, openWorldHint: false } as const;

const server = new McpServer({ name: "quality-kpi-mcp", version: "1.0.0" });

server.registerTool("list_data_sources",
  { title: "List data sources", description: "What data is loaded: row counts, date range, services/components, and the as-of date used for all calculations.", annotations: RO },
  safe(() => {
    const ds = data();
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    return json({
      data_dir: ds.dir, as_of: day(ds.asOf), data_starts: day(dataStart(ds)), warnings: ds.warnings,
      incidents: ds.incidents.length, production_deployments: ds.deployments.length, defects: ds.defects.length,
      services: [...new Set([...ds.deployments.map((d) => d.service), ...ds.incidents.map((i) => i.service)])].sort(),
      defect_components: [...new Set(ds.defects.map((d) => d.component))].sort(),
    });
  }));

server.registerTool("get_mttr",
  {
    title: "MTTR, MTTA, MTTD",
    description: "Incident response metrics for a period: mean time to restore (MTTR), acknowledge (MTTA) and detect (MTTD), with median, p90 and customer-detected share. Group by severity (default), service, month or root cause.",
    inputSchema: { period: PERIOD, service: SERVICE, severity: z.string().optional().describe("SEV1..SEV4"), group_by: z.enum(["severity", "service", "month", "root_cause"]).optional() },
    annotations: RO,
  },
  safe(({ period: s, service, severity, group_by }) => { const { ds, p } = period(s); return json(mttr(ds, p, { service, severity, groupBy: group_by })); }));

server.registerTool("get_dora_metrics",
  {
    title: "DORA metrics",
    description: "The four DORA keys (deployment frequency, lead time for changes, change failure rate, time to restore) with an Elite/High/Medium/Low tier for each and overall.",
    inputSchema: { period: PERIOD, service: SERVICE },
    annotations: RO,
  },
  safe(({ period: s, service }) => { const { ds, p } = period(s); return json(dora(ds, p, { service })); }));

server.registerTool("get_change_failure_breakdown",
  { title: "Change failures by service", description: "Which services' deployments cause incidents or rollbacks, with rates, root causes and hotspots (services failing at 2x the overall rate).", inputSchema: { period: PERIOD }, annotations: RO },
  safe(({ period: s }) => { const { ds, p } = period(s); return json(changeFailures(ds, p)); }));

server.registerTool("get_defect_metrics",
  { title: "Defect metrics", description: "Defects created and resolved, escape rate (share found in production), reopen rate, escape rate by component, and resolution time and SLA compliance by priority.", inputSchema: { period: PERIOD, component: SERVICE }, annotations: RO },
  safe(({ period: s, component }) => { const { ds, p } = period(s); return json(defectMetrics(ds, p, { component })); }));

server.registerTool("get_defect_aging",
  { title: "Defect aging & SLA breaches", description: "Open defects right now: age buckets, open count by priority, and every defect past its SLA (Critical 2d, High 7d, Medium 30d, Low 90d), worst first.", inputSchema: { component: SERVICE, priority: z.enum(["Critical", "High", "Medium", "Low"]).optional() }, annotations: RO },
  safe(({ component, priority }) => json(defectAging(data(), { component, priority }))));

server.registerTool("get_kpi_trend",
  { title: "KPI trend by month", description: `Month-by-month series for one KPI. Metrics: ${TREND_METRICS.join(", ")}.`, inputSchema: { metric: z.enum(TREND_METRICS), period: z.string().optional().describe("Window to cover (default: all)"), service: SERVICE }, annotations: RO },
  safe(({ metric, period: s, service }) => { const { ds, p } = period(s ?? "all"); return json(trend(ds, metric, p, { service })); }));

server.registerTool("compare_periods",
  {
    title: "Compare two periods",
    description: "Every KPI side by side for two periods with % change and improved/worse/flat. Defaults to the chosen period vs. the equal-length period before it, e.g. this quarter vs. last.",
    inputSchema: { period: PERIOD, baseline: z.string().optional().describe("Baseline window (default: the equal-length period immediately before)"), service: SERVICE },
    annotations: RO,
  },
  safe(({ period: s, baseline, service }) => {
    const { ds, p } = period(s);
    const b = baseline ? parsePeriod(baseline, ds.asOf, dataStart(ds)) : previousPeriod(p);
    return json(comparePeriods(ds, p, b, { service }));
  }));

server.registerTool("generate_executive_summary",
  {
    title: "Executive summary",
    description: "A one-page markdown quality report for leadership: bottom line, KPI scorecard vs. the previous period, DORA tiers, wins, risks, and recommended asks. Ready for email, Slack or Confluence.",
    inputSchema: { period: PERIOD, baseline: z.string().optional() },
    annotations: RO,
  },
  safe(({ period: s, baseline }) => {
    const { ds, p } = period(s);
    return text(executiveSummary(ds, p, baseline ? parsePeriod(baseline, ds.asOf, dataStart(ds)) : previousPeriod(p)));
  }));

server.registerTool("export_leadership_dashboard",
  {
    title: "Export leadership dashboard",
    description: "Write a self-contained HTML dashboard (KPI tiles, wins and risks, MTTR / change failure / defect trends, DORA tiers, SLA breaches) to the output folder and return its path.",
    inputSchema: { period: PERIOD, filename: z.string().regex(/^[\w.-]+\.html$/).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  safe(({ period: s, filename }) => {
    const { ds, p } = period(s);
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const path = join(OUTPUT_DIR, filename ?? "quality-dashboard.html");
    writeFileSync(path, renderDashboard(ds, p, previousPeriod(p)));
    return text(`Dashboard written to ${path}`);
  }));

server.registerPrompt("monthly_quality_review",
  { title: "Monthly quality review", description: "Prepare the monthly engineering quality update for leadership." },
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          "Prepare this month's engineering quality review for the leadership team. Use generate_executive_summary for last_30_days, " +
          "then get_change_failure_breakdown and get_defect_aging to add detail behind the top risks, and get_kpi_trend for mttr_hours to show the direction. " +
          "Give me: a 3-sentence summary a VP can read in 20 seconds, the scorecard, the top 3 risks with an owner-ready ask for each, and one win worth celebrating. " +
          "Finish by exporting the leadership dashboard.",
      },
    }],
  }));

await server.connect(new StdioServerTransport());
console.error(`[quality-kpi-mcp] ready · data: ${DATA_DIR}`);
