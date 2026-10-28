import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Incident {
  id: string;
  title: string;
  severity: string; // SEV1..SEV4 (P1..P4 are normalized)
  service: string;
  startedAt: number;
  detectedAt: number;
  acknowledgedAt?: number;
  resolvedAt?: number;
  detectionSource: string;
  causedByDeploy?: string;
  rootCause: string;
}

export interface Deployment {
  id: string;
  service: string;
  environment: string;
  deployedAt: number;
  firstCommitAt?: number;
  commitCount?: number;
  status: string; // success | rolled_back | failed
}

export interface Defect {
  key: string;
  summary: string;
  priority: string; // Critical | High | Medium | Low
  component: string;
  foundIn: string; // qa | staging | production
  status: string;
  createdAt: number;
  resolvedAt?: number;
  reopenedCount: number;
  sprint?: string;
}

export interface Dataset {
  dir: string;
  incidents: Incident[];
  deployments: Deployment[];
  defects: Defect[];
  /** "Now" for every calculation: KPI_AS_OF, or the latest timestamp in the data. */
  asOf: number;
  warnings: string[];
}

// ------------------------------------------------------------------ CSV

/** RFC 4180 CSV parser: quoted fields, escaped quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQuotes = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map(norm);
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const norm = (k: string) => k.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** First non-empty value among several possible column names (so real tool exports work as-is). */
const col = (r: Record<string, string>, ...names: string[]) => {
  for (const n of names) if (r[n]) return r[n];
  return "";
};
const time = (v: string) => {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
};

function normalizeSeverity(v: string): string {
  const m = v.match(/(\d)/);
  if (m) return `SEV${m[1]}`;
  const map: Record<string, string> = { critical: "SEV1", high: "SEV2", medium: "SEV3", low: "SEV4" };
  return map[v.toLowerCase()] ?? (v.toUpperCase() || "SEV3");
}
function normalizePriority(v: string): string {
  const s = v.toLowerCase();
  if (/(highest|blocker|critical|p0|p1)/.test(s)) return "Critical";
  if (/(high|major|p2)/.test(s)) return "High";
  if (/(low|minor|trivial|lowest|p4|p5)/.test(s)) return "Low";
  return "Medium";
}
function normalizeEnv(v: string): string {
  const s = v.toLowerCase();
  if (/(prod|live|customer)/.test(s)) return "production";
  if (/(stag|uat|pre)/.test(s)) return "staging";
  return s || "qa";
}

// ------------------------------------------------------------------ loaders

function read(dir: string, file: string, warnings: string[]) {
  const path = join(dir, file);
  if (!existsSync(path)) {
    warnings.push(`${file} not found in ${dir}; metrics that need it will be empty.`);
    return [];
  }
  return parseCsv(readFileSync(path, "utf8"));
}

export function loadDataset(dir: string): Dataset {
  const warnings: string[] = [];

  const incidents: Incident[] = [];
  for (const r of read(dir, "incidents.csv", warnings)) {
    const started = time(col(r, "started_at", "start_time", "created_at", "created_on", "triggered_at"));
    if (started === undefined) continue;
    incidents.push({
      id: col(r, "incident_id", "id", "incident_number", "key"),
      title: col(r, "title", "summary", "description"),
      severity: normalizeSeverity(col(r, "severity", "priority", "urgency")),
      service: col(r, "service", "service_name", "component") || "unknown",
      startedAt: started,
      detectedAt: time(col(r, "detected_at", "triggered_at", "created_at")) ?? started,
      acknowledgedAt: time(col(r, "acknowledged_at", "first_ack_at", "acked_at")),
      resolvedAt: time(col(r, "resolved_at", "resolved_on", "closed_at", "mitigated_at")),
      detectionSource: col(r, "detection_source", "source") || "unknown",
      causedByDeploy: col(r, "caused_by_deploy", "change_id", "deploy_id") || undefined,
      rootCause: col(r, "root_cause_category", "root_cause", "cause") || "unknown",
    });
  }

  const deployments: Deployment[] = [];
  for (const r of read(dir, "deployments.csv", warnings)) {
    const t = time(col(r, "deployed_at", "finished_at", "created_at", "timestamp"));
    if (t === undefined) continue;
    deployments.push({
      id: col(r, "deploy_id", "id", "deployment_id"),
      service: col(r, "service", "project", "app", "application") || "unknown",
      environment: normalizeEnv(col(r, "environment", "env") || "production"),
      deployedAt: t,
      firstCommitAt: time(col(r, "first_commit_at", "commit_time", "first_commit_date")),
      commitCount: Number(col(r, "commit_count", "commits")) || undefined,
      status: (col(r, "status", "result") || "success").toLowerCase(),
    });
  }

  const defects: Defect[] = [];
  for (const r of read(dir, "defects.csv", warnings)) {
    const created = time(col(r, "created", "created_at", "created_date"));
    if (created === undefined) continue;
    defects.push({
      key: col(r, "key", "issue_key", "id"),
      summary: col(r, "summary", "title"),
      priority: normalizePriority(col(r, "priority", "severity")),
      component: col(r, "component", "components", "component_s") || "unassigned",
      foundIn: normalizeEnv(col(r, "found_in", "environment", "found_in_environment", "custom_field_found_in")),
      status: col(r, "status") || "Open",
      createdAt: created,
      resolvedAt: time(col(r, "resolved", "resolved_at", "resolution_date")),
      reopenedCount: Number(col(r, "reopened_count", "reopens")) || 0,
      sprint: col(r, "sprint") || undefined,
    });
  }

  const latest = Math.max(
    0,
    ...incidents.flatMap((i) => [i.startedAt, i.resolvedAt ?? 0]),
    ...deployments.map((d) => d.deployedAt),
    ...defects.flatMap((d) => [d.createdAt, d.resolvedAt ?? 0]),
  );
  const asOf = time(process.env.KPI_AS_OF ?? "") ?? latest;

  return {
    dir,
    incidents: incidents.sort((a, b) => a.startedAt - b.startedAt),
    deployments: deployments.filter((d) => d.environment === "production").sort((a, b) => a.deployedAt - b.deployedAt),
    defects: defects.sort((a, b) => a.createdAt - b.createdAt),
    asOf,
    warnings,
  };
}
