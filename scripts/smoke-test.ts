/**
 * End-to-end smoke test: launches the built server over stdio with the official MCP
 * client (the same way Claude Desktop / Claude Code / Cursor do), calls every tool and
 * asserts that the storylines planted in the sample data are found.
 *
 * Usage: npm run build && npm run smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(root, "dist", "server.js")], stderr: "ignore" }));

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.ok(!res.isError, `${name} returned an error: ${res.content[0]?.text}`);
  const t = res.content[0].text;
  try { return JSON.parse(t); } catch { return t; }
};
let passed = 0;
const check = async (label: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ✓ ${label}`); };

console.log("quality-kpi-mcp smoke test");
const { tools } = await client.listTools();
await check(`exposes ${tools.length} tools`, async () => assert.equal(tools.length, 10));

await check("list_data_sources loads all three exports", async () => {
  const d = await call("list_data_sources");
  assert.deepEqual(d.warnings, []);
  assert.ok(d.incidents > 50 && d.production_deployments > 500 && d.defects > 400);
  assert.equal(d.as_of, "2026-10-27");
});

await check("get_mttr shows SEV2/SEV3 restore time halved after runbooks (Aug 1)", async () => {
  const before = await call("get_mttr", { period: "2026-05-01..2026-07-31" });
  const after = await call("get_mttr", { period: "2026-08-01..2026-10-27" });
  const sev = (r: any, s: string) => r.by_severity.find((x: any) => x.severity === s)?.mttr_hours;
  assert.ok(sev(after, "SEV2") < sev(before, "SEV2") / 2, "SEV2 MTTR should at least halve");
  assert.ok(sev(after, "SEV3") < sev(before, "SEV3") / 2, "SEV3 MTTR should at least halve");
  assert.ok(after.overall.mttr_hours < before.overall.mttr_hours / 2, "overall MTTR should at least halve");
});

await check("get_mttr shows customers find fewer incidents first (MTTD drop)", async () => {
  const before = await call("get_mttr", { period: "2026-05-01..2026-07-31" });
  const after = await call("get_mttr", { period: "2026-08-01..2026-10-27" });
  assert.ok(after.overall.customer_detected_pct < before.overall.customer_detected_pct * 0.6, "customer-detected share should drop 40%+");
  assert.ok(after.overall.mttd_minutes < before.overall.mttd_minutes * 0.6, "MTTD should drop 40%+");
});

await check("get_dora_metrics returns four keys with tiers", async () => {
  const d = await call("get_dora_metrics");
  for (const k of ["deployment_frequency", "lead_time_for_changes", "change_failure_rate", "time_to_restore"]) assert.ok(d[k].tier, `${k} tier`);
  assert.ok(["Elite", "High", "Medium", "Low"].includes(d.overall_tier));
});

await check("get_change_failure_breakdown flags payments as the September hotspot", async () => {
  const c = await call("get_change_failure_breakdown", { period: "2026-09" });
  assert.equal(c.by_service[0].service, "payments");
  assert.match(c.by_service[0].flag, /HOTSPOT/);
  assert.equal(c.by_service[0].top_root_causes[0].cause, "schema_migration");
});

await check("get_kpi_trend shows lead time improving month over month", async () => {
  const t = await call("get_kpi_trend", { metric: "lead_time_hours" });
  assert.ok(t.series[t.series.length - 1].value < t.series[0].value / 2);
});

await check("get_defect_metrics shows checkout escape rate climbing", async () => {
  const early = await call("get_defect_metrics", { period: "2026-05-01..2026-07-31", component: "checkout" });
  const late = await call("get_defect_metrics", { period: "2026-09-01..2026-10-27", component: "checkout" });
  assert.ok(late.escape_rate_pct > early.escape_rate_pct * 2);
});

await check("get_defect_aging finds the Critical gift-card defect past SLA", async () => {
  const a = await call("get_defect_aging", { priority: "Critical" });
  const b = a.sla_breaches.find((x: any) => /gift card/.test(x.summary));
  assert.ok(b && b.age_days > 40 && b.component === "checkout");
});

await check("compare_periods reports MTTR improved and CFR worse", async () => {
  const c = await call("compare_periods");
  const k = Object.fromEntries(c.kpis.map((r: any) => [r.key, r]));
  assert.equal(k.mttr_hours.verdict, "improved");
  assert.equal(k.change_failure_rate_pct.verdict, "worse");
});

await check("generate_executive_summary has scorecard, wins and risks", async () => {
  const md = await call("generate_executive_summary");
  assert.match(md, /^# Engineering Quality Report/);
  assert.match(md, /## Scorecard/);
  assert.match(md, /payments is a change-failure hotspot/);
  assert.match(md, /Defect escape rate is climbing in checkout/);
});

await check("export_leadership_dashboard writes HTML", async () => {
  assert.match(await call("export_leadership_dashboard"), /quality-dashboard\.html$/);
});

await check("bad period returns a clean tool error", async () => {
  const r = (await client.callTool({ name: "get_mttr", arguments: { period: "next_tuesday" } })) as any;
  assert.equal(r.isError, true);
});

await check("monthly_quality_review prompt is registered", async () => {
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((p) => p.name === "monthly_quality_review"));
});

await client.close();
console.log(`\nAll ${passed} checks passed.`);
