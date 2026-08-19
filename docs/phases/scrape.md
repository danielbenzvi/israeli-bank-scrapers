# SCRAPE

Per-account transaction walk. Emits the typed inputs that [BALANCE-RESOLVE](balance-resolve.md) consumes.

| | |
|---|---|
| **Always-on?** | Yes (`ifAnyScraper`) |
| **Owner slot** | `scrape: Option<{ accounts, accountIdentities, balanceFetchTemplate }>` |
| **Source** | [`ScrapePhase.ts`](https://github.com/sergienko4/israeli-bank-scrapers/blob/{{BRANCH}}/src/Scrapers/Pipeline/Phases/Scrape/ScrapePhase.ts) + [`ScrapePhaseActions.ts`](https://github.com/sergienko4/israeli-bank-scrapers/blob/{{BRANCH}}/src/Scrapers/Pipeline/Mediator/Scrape/ScrapePhaseActions.ts) |

## Sub-step contract

| Hook | What it does |
|---|---|
| `.pre` | Forensic priming (run [PopupInterceptor](../architecture/pipeline.md#interceptors-cross-cutting-no-data)); DIRECT discovery (read `accountDiscovery.ids`, freeze the network pool, seal). |
| `.action` | Sealed action: frozen matrix loop — for each `accountId`, run the bank's `IFetchStrategy` against the frozen txn endpoint + harvest, parse transactions. |
| `.post` | **v6 emission** — build `accountIdentities` (per-card triples) + `balanceFetchTemplate` from the captured pool; audit forensic per-account txn counts; consult the empty-gate heuristic. |
| `.final` | Stamp account count into diagnostics. |

## What v6 changed

Before v6, `.post` also computed `perAccountResponses` — a partial pool with attribution heuristics — that BALANCE-RESOLVE consumed. v6 removed that path (~370 LOC) and replaced it with two typed fields:

| Field | Built from | Consumed by |
|---|---|---|
| `accountIdentities: ReadonlyMap<cardDisplayId, IAccountIdentity>` | `accountDiscovery.records` via `buildAccountIdentities` | `BALANCE-RESOLVE.pre` |
| `balanceFetchTemplate: IBalanceFetchTemplate` | Captured pool via `discoverBalanceFetchTemplate` (tries POST-with-bodyKey → GET-with-queryKey → GET-with-path-tail → bulk fallback) | `BALANCE-RESOLVE.pre` |

See [Architecture → BALANCE-RESOLVE](../architecture/balance-resolve.md) for the rationale.

## Empty-gate heuristic (v4 Issue 2)

`executeValidateResults` distinguishes a real scrape miss from a legitimate empty result:

| Condition | Action |
|---|---|
| 0 accounts in `scrape.accounts` | `Procedure fail` "no accounts produced" |
| Accounts produced, all with `txns.length === 0`, AND `network.countSuccessfulResponses() > 0` | succeed (legitimate empty month) |
| Accounts produced, all empty, AND `countSuccessfulResponses() === 0` | `Procedure fail` "scrape miss" |

Test coverage: [`EmptyGateHeuristic.test.ts`](https://github.com/sergienko4/israeli-bank-scrapers/blob/{{BRANCH}}/src/Tests/Unit/Pipeline/Mediator/Scrape/EmptyGateHeuristic.test.ts).

## Provider annotation fields

`.action` parses each raw row through the shared auto-mapper, which resolves
canonical `ITransaction` fields by looking up a cross-bank alias dictionary
rather than branching per bank. Alongside the date/amount/description core,
providers ship descriptive fields — a free-text note, their own category, and
the currency the account was actually billed in.

Those three are grouped in `PROVIDER_ANNOTATION_FIELDS`
([`ScrapeProviderFields.ts`](https://github.com/sergienko4/israeli-bank-scrapers/blob/{{BRANCH}}/src/Scrapers/Pipeline/Registry/WK/ScrapeProviderFields.ts)),
spread into the WK transaction dictionary. Reach for it when an institution
sends an annotation the mapper currently drops: adding the provider's key to
the matching list is a one-line change, and no mapper code needs to know which
bank sent it. Each alias is annotated with the captured-row count that
justifies it, and the module records why the remaining institutions need none.

Aliases must be evidence-backed. A key that resolves for the wrong provider
publishes a misleading value on every one of its rows — `paymentCurrency` is
documented there as the worked example.

Test coverage: [`ProviderFieldCoverage.test.ts`](https://github.com/sergienko4/israeli-bank-scrapers/blob/{{BRANCH}}/src/Tests/Unit/Pipeline/Infrastructure/ProviderFieldCoverage.test.ts).

## Forensic audit observability

`.post` invokes [`logForensicAudit`](../observability/forensic-audit.md) which emits the per-account `--- Account <masked> | <N> txns ---` line. Same hook runs in [API-DIRECT-SCRAPE.post](api-direct-scrape.md) so every scrape path produces the same diagnostic.
