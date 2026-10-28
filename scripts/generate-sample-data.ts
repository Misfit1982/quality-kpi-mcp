/**
 * Generates six months of fully synthetic engineering data for a fictional
 * e-commerce company ("ShopLite"), in the CSV shapes you'd export from common tools:
 *
 *   sample-data/incidents.csv    ~ PagerDuty / Opsgenie / incident.io export
 *   sample-data/deployments.csv  ~ CI/CD deploy log (GitLab, GitHub Actions, Argo)
 *   sample-data/defects.csv      ~ Jira bug export
 *
 * Deterministic (seeded) with storylines planted so every tool has something to find:
 *   1. MTTR drops sharply after on-call runbooks roll out on 2026-08-01
 *   2. Customer-reported incidents fall after synthetic monitoring goes live (2026-08-01), so MTTD drops
 *   3. The payments service's change failure rate spikes in September (a risky schema migration)
 *   4. Defect escape rate is climbing in the checkout component (Aug -> Oct)
 *   5. A Critical checkout defect has been open for 40+ days, far past its 2-day SLA
 *   6. Lead time for changes improves steadily as PR batches get smaller
 *
 * Usage: npm run generate-data
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "sample-data");
const START = Date.UTC(2026, 4, 1); // 2026-05-01
const AS_OF = Date.UTC(2026, 9, 27, 17, 0); // 2026-10-27 17:00 UTC
const RUNBOOKS = Date.UTC(2026, 7, 1); // 2026-08-01
const H = 3_600_000, D = 24 * H, M = 60_000;

let seed = Number(process.env.SEED ?? 4250);
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
/** Log-normal-ish positive value around `median`. */
const around = (median: number, spread = 0.5) => median * Math.exp((rand() + rand() + rand() - 1.5) * spread * 1.6);
const iso = (t: number) => new Date(Math.round(t / M) * M).toISOString().replace(".000Z", "Z");
const monthIdx = (t: number) => new Date(t).getUTCMonth() - 4; // May = 0 ... Oct = 5
const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows: Record<string, unknown>[]) =>
  [Object.keys(rows[0]).join(","), ...rows.map((r) => Object.values(r).map(csvCell).join(","))].join("\n") + "\n";

const SERVICES = ["checkout", "payments", "catalog", "search", "accounts", "inventory"] as const;
const DEPLOY_RATE: Record<string, number> = { checkout: 0.9, payments: 0.7, catalog: 1.1, search: 0.8, accounts: 0.45, inventory: 0.6 };

// ------------------------------------------------------------------ deploys
interface Deploy { deploy_id: string; service: string; environment: string; deployed_at: string; first_commit_at: string; commit_count: number; status: string; _t: number; _failed: boolean }
const deploys: Deploy[] = [];
let dn = 4100;
for (let day = START; day < AS_OF; day += D) {
  const dow = new Date(day).getUTCDay();
  if (dow === 0 || dow === 6) continue;
  for (const svc of SERVICES) {
    let n = 0;
    let r = DEPLOY_RATE[svc] * (1 + monthIdx(day) * 0.06);
    while (r > 0) { if (rand() < Math.min(1, r)) n++; r -= 1; }
    for (let k = 0; k < n; k++) {
      const t = day + 15 * H + rand() * 8 * H; // 9am-5pm Mountain
      const lead = around(70 - monthIdx(day) * 10, 0.55) * H; // median ~70h in May -> ~20h in Oct
      let failP = 0.045;
      if (svc === "payments" && monthIdx(t) === 4) failP = 0.4; // September schema-migration trouble
      if (svc === "checkout" && monthIdx(t) >= 3) failP = 0.06;
      const failed = rand() < failP;
      deploys.push({
        deploy_id: `DEP-${dn++}`,
        service: svc,
        environment: "production",
        deployed_at: iso(t),
        first_commit_at: iso(t - lead),
        commit_count: Math.max(1, Math.round(around(6 - monthIdx(t) * 0.6, 0.5))),
        status: failed && rand() < 0.45 ? "rolled_back" : "success",
        _t: t,
        _failed: failed,
      });
    }
  }
}
deploys.sort((a, b) => a._t - b._t);
deploys.forEach((d, i) => (d.deploy_id = `DEP-${4100 + i}`));

// ---------------------------------------------------------------- incidents
interface Incident { incident_id: string; title: string; severity: string; service: string; started_at: string; detected_at: string; acknowledged_at: string; resolved_at: string; detection_source: string; caused_by_deploy: string; root_cause_category: string; _t: number }
const incidents: Incident[] = [];
const TITLES: Record<string, string[]> = {
  checkout: ["Checkout returns 500 on submit", "Cart totals not updating", "Checkout latency p95 > 4s", "Promo codes rejected at checkout"],
  payments: ["Card authorizations failing", "Payment webhook backlog", "Duplicate charges on retry", "Refund job stuck"],
  catalog: ["Product images not loading", "Price sync delayed", "Category pages timing out"],
  search: ["Search returns empty results", "Autocomplete degraded", "Search index lagging"],
  accounts: ["Login failures spike", "Password reset emails delayed", "Session tokens expiring early"],
  inventory: ["Stock counts out of sync", "Inventory service unavailable", "Low-stock alerts not firing"],
};
const RESTORE_MEDIAN_H: Record<string, [number, number]> = { SEV1: [4.5, 1.1], SEV2: [7, 2.2], SEV3: [12, 4.5], SEV4: [20, 11] };
let inc = 880;
function addIncident(t: number, svc: string, sev: string, deploy?: Deploy, cause?: string) {
  const after = t >= RUNBOOKS;
  const customer = rand() < (after ? 0.12 : 0.42);
  const detectMin = customer ? around(150, 0.5) : around(9, 0.5);
  const ackMin = sev === "SEV1" || sev === "SEV2" ? around(after ? 6 : 14, 0.5) : around(after ? 25 : 45, 0.5);
  const [pre, post] = RESTORE_MEDIAN_H[sev];
  const restore = around(after ? post : pre, 0.45) * H;
  const detected = t + detectMin * M;
  incidents.push({
    incident_id: `INC-${inc++}`,
    title: pick(TITLES[svc]),
    severity: sev,
    service: svc,
    started_at: iso(t),
    detected_at: iso(detected),
    acknowledged_at: iso(detected + ackMin * M),
    resolved_at: iso(t + Math.max(restore, (detectMin + ackMin + 5) * M)),
    detection_source: customer ? "customer_report" : pick(["monitoring", "monitoring", "synthetic_check", "qa"]),
    caused_by_deploy: deploy?.deploy_id ?? "",
    root_cause_category: cause ?? (deploy ? pick(["code_change", "code_change", "config_change", "schema_migration"]) : pick(["infrastructure", "third_party", "capacity", "data_issue"])),
    _t: t,
  });
}
// Change-failure incidents: every failed deploy causes one
for (const d of deploys.filter((x) => x._failed)) {
  const sev = rand() < 0.12 ? "SEV1" : rand() < 0.45 ? "SEV2" : "SEV3";
  const cause = d.service === "payments" && monthIdx(d._t) === 4 ? "schema_migration" : undefined;
  addIncident(d._t + around(40, 0.6) * M, d.service, sev, d, cause);
}
// Background incidents not caused by a deploy
for (let day = START; day < AS_OF - D; day += D) {
  if (rand() < 0.2) {
    const sev = pick(["SEV2", "SEV3", "SEV3", "SEV4", "SEV4"]);
    addIncident(day + rand() * D, pick(SERVICES), sev);
  }
}
incidents.sort((a, b) => a._t - b._t);
incidents.forEach((x, i) => (x.incident_id = `INC-${880 + i}`));

// ------------------------------------------------------------------ defects
interface Defect { key: string; summary: string; priority: string; component: string; found_in: string; status: string; created: string; resolved: string; reopened_count: number; sprint: string; _t: number }
const defects: Defect[] = [];
const SUMMARIES: Record<string, string[]> = {
  checkout: ["Tax not recalculated after address change", "Coupon applied twice on refresh", "Guest checkout loses cart on back button", "Shipping estimate missing for PO boxes", "Order confirmation shows wrong total"],
  payments: ["Saved card not shown for returning user", "3DS challenge loops on Safari", "Refund amount rounds incorrectly", "Payment error message unclear"],
  catalog: ["Variant images mismatched", "Sale badge shown after sale ends", "Sorting by price ignores currency"],
  search: ["Typo tolerance too aggressive", "Filters reset on pagination", "Out-of-stock items ranked first"],
  accounts: ["Profile save fails with emoji in name", "MFA code accepted after expiry", "Email change not confirmed"],
  inventory: ["Reserved stock not released on cancel", "Bulk import skips last row", "Warehouse code case-sensitive"],
};
const RESOLVE_DAYS: Record<string, number> = { Critical: 1.2, High: 4.5, Medium: 14, Low: 35 };
let dk = 2100;
const sprintOf = (t: number) => `Sprint ${40 + Math.floor((t - START) / (14 * D))}`;
for (let day = START; day < AS_OF; day += D) {
  const dow = new Date(day).getUTCDay();
  if (dow === 0 || dow === 6) continue;
  const n = Math.round(around(3.2, 0.3));
  for (let k = 0; k < n; k++) {
    const t = day + 15 * H + rand() * 8 * H;
    const comp = pick(SERVICES);
    const priority = pick(["Critical", "High", "High", "Medium", "Medium", "Medium", "Low", "Low"]);
    let escapeP = 0.09;
    if (comp === "checkout") escapeP = [0.1, 0.1, 0.12, 0.22, 0.32, 0.4][monthIdx(t)];
    const found = rand() < escapeP ? "production" : rand() < 0.75 ? "qa" : "staging";
    const resolveDays = Math.min(around(RESOLVE_DAYS[priority], 0.55), priority === "Critical" ? 2.5 : Infinity);
    const resolvedT = t + resolveDays * D;
    const open = resolvedT > AS_OF || (priority !== "Critical" && priority !== "High" && rand() < 0.03);
    defects.push({
      key: `SHOP-${dk++}`,
      summary: pick(SUMMARIES[comp]),
      priority,
      component: comp,
      found_in: found,
      status: open ? pick(["Open", "In Progress", "In Review"]) : "Done",
      created: iso(t),
      resolved: open ? "" : iso(resolvedT),
      reopened_count: rand() < 0.08 ? 1 + (rand() < 0.2 ? 1 : 0) : 0,
      sprint: sprintOf(t),
      _t: t,
    });
  }
}
// Storyline 5: a Critical checkout defect that has been open since mid-September
defects.push({
  key: `SHOP-${dk++}`,
  summary: "Orders with gift cards charged full amount",
  priority: "Critical",
  component: "checkout",
  found_in: "production",
  status: "In Progress",
  created: iso(Date.UTC(2026, 8, 14, 16, 20)),
  resolved: "",
  reopened_count: 1,
  sprint: sprintOf(Date.UTC(2026, 8, 14)),
  _t: Date.UTC(2026, 8, 14, 16, 20),
});
defects.sort((a, b) => a._t - b._t);
defects.forEach((x, i) => (x.key = `SHOP-${2100 + i}`));

const strip = <T extends object>(rows: T[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_"))));
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "deployments.csv"), toCsv(strip(deploys)));
writeFileSync(join(OUT, "incidents.csv"), toCsv(strip(incidents)));
writeFileSync(join(OUT, "defects.csv"), toCsv(strip(defects)));
writeFileSync(join(OUT, "README.md"), `# Sample data

Fully synthetic data for a fictional company, ShopLite. Window: 2026-05-01 to ${iso(AS_OF).slice(0, 10)}.

| File | Rows | Shaped like |
|---|---|---|
| deployments.csv | ${deploys.length} | CI/CD deploy log |
| incidents.csv | ${incidents.length} | PagerDuty / Opsgenie incident export |
| defects.csv | ${defects.length} | Jira bug export |

Regenerate with \`npm run generate-data\`.
`);
console.log(`Wrote ${deploys.length} deploys, ${incidents.length} incidents, ${defects.length} defects to ${OUT}`);
