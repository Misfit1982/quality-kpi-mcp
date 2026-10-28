# Engineering Quality Report
**Period:** last 90 days (2026-07-29 to 2026-10-27) · **Compared with:** previous 90 days (2026-04-30 to 2026-07-29) · **As of:** 2026-10-27

## Bottom line
Delivery performance is **High** by DORA benchmarks (all four keys are High). 3 improvements and 4 risks need attention.

## Scorecard
| KPI | Previous | Current | Change |
|---|---|---|---|
| MTTR (hours) | 12.8 | **4.7** | -63.3% ▲ improved |
| MTTD (minutes) | 78 | **44** | -43.6% ▲ improved |
| Customer-detected incidents (%) | 42.5 | **20** | -52.9% ▲ improved |
| Change failure rate (%) | 5.9 | **7.5** | +27.1% ▼ worse |
| Lead time for changes (hours, median) | 61.6 | **30.8** | -50% ▲ improved |
| Deploys / week / service | 3.95 | **4.67** | +18.2% ▲ improved |
| Defect escape rate (%) | 7.6 | **11.4** | +50% ▼ worse |
| Open Critical/High defects (end of period) | 7 | **7** | 0% – flat |

## DORA metrics
| Key | Value | Tier |
|---|---|---|
| Deployment frequency | 4.67 deploys/week/service | High |
| Lead time for changes | 30.8 h median | High |
| Change failure rate | 7.5% | High |
| Time to restore (change failures) | 3.2 h median | High |

## Wins
- **Incidents are resolved 63.3% faster.** MTTR 12.8h → 4.7h (-63.3%).
- **Fewer incidents are found by customers first.** Customer-detected share 42.5% → 20% (-52.9%); MTTD 78 min → 44 min (-43.6%).
- **Changes reach production faster.** Median lead time 61.6h → 30.8h (-50%).

## Risks
- **More deployments are causing incidents.** Change failure rate 5.9% → 7.5% (+27.1%).
- **payments is a change-failure hotspot.** 20.4% of 54 deploys failed (overall 7.5%); top cause: schema_migration.
- **Defect escape rate is climbing in checkout.** 37.5% of checkout defects were found in production in 2026-10, up from 21.6% over the prior three months.
- **1 Critical defect past SLA.** SHOP-2413 "Orders with gift cards charged full amount" (checkout) open 43.3 days vs. 2-day SLA.

## Recommended asks
1. Require a tested rollback plan for schema and config changes; review last period's failed deploys in the next retro.
2. Pause risky changes on payments until rollback and migration testing are in place.
3. Add regression coverage for checkout before the next release; review what testing missed on recent production defects.
4. Assign a named owner and a fix date for each Critical defect past SLA this week.
5. Keep the on-call and runbook practices that drove the MTTR gain; share them with other teams.
