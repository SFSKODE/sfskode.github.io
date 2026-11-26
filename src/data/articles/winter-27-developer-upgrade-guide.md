---
title: "Winter '27 Developer Upgrade Guide: What Changed and How to Check Your Org"
description: "API 68.0, heap limits, CLI token changes, SOAP login, Web Console, LWC expressions and Agent Script updates, plus a tested scanner that finds risky code."
category: web-and-devops
tags: [Release, Winter 27, API 68, Upgrade, CLI]
publishedAt: 2026-11-26
updatedAt: 2026-11-26
cover: /images/covers/winter-27-developer-upgrade-guide.jpg
sources:
  - title: "The Salesforce Developer's Guide to the Winter '27 Release"
    url: "https://developer.salesforce.com/blogs/2026/10/developers-guide-to-the-winter-27-release"
  - title: "Salesforce API Versions by Release and Retirement Dates"
    url: "https://sfupdates.com/api-versions/"
  - title: "Salesforce Release Notes"
    url: "https://help.salesforce.com/s/products/platform"
---

Winter '27 started rolling out in October 2026 and ships **API version 68.0**. Most of it is invisible, but a handful of changes can break scripts or alter behaviour: the Salesforce CLI stops printing secrets, SOAP `login()` gets stricter, old API versions move toward retirement, and Apex heap limits go up. Other changes are opportunities: a generally available Web Console, complex expressions in LWC templates, and new Agent Script capabilities.

This article lists what changed for developers, says what to do about each item, and builds a scanner that finds the risky patterns in your own project. Treat it as a checklist you can run in a sandbox before you move to the new release. The general method is in [preparing for Salesforce releases](/articles/preparing-for-salesforce-releases/).

## The business scenario

Crestline Lending (a fictional lender) has a CI pipeline that logs in to a sandbox with `sf org display --json | jq .result.accessToken`, an old Java integration that logs in with SOAP, a repository where several classes are pinned to API 38.0, and a nightly job that assumes a 6 MB heap. The release lead wants a one-hour check that lists everything likely to break.

## Before you start: setup

### In Salesforce

1. Use a sandbox that is on Winter '27, or a scratch org created on the new release. Verify: `sf org display --target-org mysandbox` shows API version 68.0 (the output layout depends on your CLI version).
2. Find which integrations log in with SOAP. In Setup, Login History or the Event Log, filter for the SOAP API login type. Verify: you have a list of integration users.
3. Check which users need the **Use Any API Auth** permission. Starting December 1, 2026, users who authenticate with SOAP `login()` need it, in all orgs. Verify: a permission set containing it exists and is assigned to the integration users you cannot yet migrate.
4. List Apex classes and triggers by API version with a tooling query: `sf data query --use-tooling-api -q "SELECT Name, ApiVersion FROM ApexClass ORDER BY ApiVersion" --target-org mysandbox`. Verify: the lowest versions are shown.

### On your computer

5. Update the Salesforce CLI (`sf update`) and check `sf --version`. Use Node 22 or newer; the `sf api request` commands need it. Verify: `node --version` prints v22 or higher.
6. Clone the repository and copy the scanner from this article into `tools/`. Verify: `node --test tools/w27Scan.test.mjs` passes.

### In external systems

7. Find clients that call the API with a pinned old version in the URL (check API gateway logs for `/services/data/v` followed by a number). Verify: you have a list of integration owners.

## How it works

The release changes fall into three groups:

- **Will break if untouched:** scripts that read secrets from `org display` output, SOAP login users without the new permission after December 1, 2026, and any use of API versions that retire.
- **Behaviour you should re-check:** heap limits, Apex versions in the oldest range, and sandbox versus production timing.
- **New capabilities to adopt:** Web Console, template expressions and `lwc:external`, Agent Script additions, Multi-Framework support for Angular, MCP tools.

The scanner covers the first group and the heap assumption. It reads files line by line and applies small rules, each with a severity: `error` (will break or is retired), `warn` (needs action soon) and `info` (worth knowing).

## Basic example

Run the scanner over your repository. First the code, with its tests.

```javascript
// Scan project files for things that matter when moving to Winter '27 (API 68.0).

export const CURRENT_API = 68;

const RULES = [];
function rule(id, severity, test) {
  RULES.push({ id, severity, test });
}

// Metadata and project API versions.
rule('api-version-retiring', 'error', (line) => {
  const m = /(?:sourceApiVersion"\s*:\s*"|<apiVersion>)(\d+)\.0/.exec(line);
  if (m && Number(m[1]) >= 31 && Number(m[1]) <= 40) {
    return `API ${m[1]}.0 is deprecated in Summer '27 and retired in Summer '28. Move to ${CURRENT_API}.0.`;
  }
  return null;
});
rule('api-version-gone', 'error', (line) => {
  const m = /(?:sourceApiVersion"\s*:\s*"|<apiVersion>)(\d+)\.0/.exec(line);
  if (m && Number(m[1]) <= 30) {
    return `API ${m[1]}.0 is already retired. Calls and deployments against it fail.`;
  }
  return null;
});
rule('api-version-behind', 'info', (line) => {
  const m = /(?:sourceApiVersion"\s*:\s*"|<apiVersion>)(\d+)\.0/.exec(line);
  if (m && Number(m[1]) >= 41 && Number(m[1]) < CURRENT_API) {
    return `API ${m[1]}.0 is supported but behind the current ${CURRENT_API}.0. Raise it when you have tests.`;
  }
  return null;
});
rule('apex-version-too-old', 'warn', (line) => {
  const m = /<apiVersion>(\d+)\.0/.exec(line);
  if (m && Number(m[1]) >= 9 && Number(m[1]) <= 19) {
    return `Apex at API ${m[1]}.0 gets a compiler warning in Winter '27. Use 20.0 or later.`;
  }
  return null;
});

// REST and SOAP URLs.
rule('url-old-version', 'error', (line) => {
  const m = /\/services\/data\/v(\d+)\.0/.exec(line);
  if (m && Number(m[1]) >= 31 && Number(m[1]) <= 40) {
    return `REST URL pinned to v${m[1]}.0, which retires in Summer '28.`;
  }
  return null;
});
rule('url-version-pinned', 'info', (line) => {
  const m = /\/services\/data\/v(\d+)\.0/.exec(line);
  if (m && Number(m[1]) >= 41 && Number(m[1]) < CURRENT_API) {
    return `REST URL pinned to v${m[1]}.0. Consider a shared constant, or the \`latest\` alias where it fits.`;
  }
  return null;
});
rule('soap-login', 'warn', (line) =>
  /\/services\/Soap\/[uc]\/|\.login\(|login\(\s*username/i.test(line) && /soap|login/i.test(line)
    ? 'SOAP login() needs the Use Any API Auth permission from Dec 1 2026 and retires for API 31-64 in Summer \'27. Move to OAuth with an external client app.'
    : null);

// CLI behaviour changes.
rule('cli-token-from-display', 'error', (line) =>
  /(org display|force:org:display)/.test(line) && /(accessToken|jq|--json|grep|awk)/.test(line)
    ? 'Access tokens are no longer printed by `org display` (they show as [REDACTED]). Use `sf org auth show-access-token`.'
    : null);
rule('cli-auth-url-from-display', 'error', (line) =>
  /(org display|force:org:display)/.test(line) && /(--verbose|sfdxAuthUrl|Sfdx Auth Url)/i.test(line)
    ? 'SFDX auth URLs are no longer shown by `org display`. Use `sf org auth show-sfdx-auth-url`.'
    : null);
rule('cli-show-secrets-flag', 'warn', (line) =>
  /SF_TEMP_SHOW_SECRETS/.test(line)
    ? 'The SF_TEMP_SHOW_SECRETS workaround ended on October 28, 2026. Remove it.'
    : null);
rule('cli-legacy-sfdx', 'info', (line) =>
  /\bsfdx\s+force:/.test(line) ? 'Legacy `sfdx force:` commands. Use the `sf` equivalents.' : null);

// Heap assumptions baked into code or docs.
rule('heap-assumption', 'info', (line) =>
  /\b(6000000|12000000)\b|\b(6|12)\s?MB\b.*heap|heap.*\b(6|12)\s?MB\b/i.test(line)
    ? 'Heap limits changed in Winter \'27 (sync 10 MB, async 25 MB). Re-check any hard-coded assumption.'
    : null);

export function scanFile(path, text) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const r of RULES) {
      const message = r.test(line);
      if (message) {
        findings.push({ file: path, line: index + 1, severity: r.severity, rule: r.id, message });
      }
    }
  });
  return findings;
}

const ORDER = { error: 0, warn: 1, info: 2 };

export function scanProject(files) {
  const all = Object.entries(files).flatMap(([path, text]) => scanFile(path, text));
  return all.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
}

export function summarize(findings) {
  const counts = { error: 0, warn: 0, info: 0 };
  findings.forEach(f => { counts[f.severity] += 1; });
  return counts;
}

export function exitCode(findings, failOn = 'error') {
  const limit = ORDER[failOn];
  return findings.some(f => ORDER[f.severity] <= limit) ? 1 : 0;
}
```

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitCode, scanFile, scanProject, summarize } from './w27Scan.mjs';

const rules = findings => findings.map(f => f.rule);

test('retiring API versions are errors in project and metadata files', () => {
  const a = scanFile('sfdx-project.json', '  "sourceApiVersion": "38.0"');
  assert.deepEqual(rules(a), ['api-version-retiring']);
  const b = scanFile('Foo.cls-meta.xml', '<apiVersion>35.0</apiVersion>');
  assert.equal(b[0].severity, 'error');
});

test('already retired versions are errors with a different rule', () => {
  assert.deepEqual(rules(scanFile('x.xml', '<apiVersion>25.0</apiVersion>')), ['api-version-gone']);
});

test('a supported but older version is informational', () => {
  const f = scanFile('x.xml', '<apiVersion>64.0</apiVersion>');
  assert.deepEqual(rules(f), ['api-version-behind']);
  assert.equal(f[0].severity, 'info');
});

test('the current version produces no finding', () => {
  assert.deepEqual(scanFile('x.xml', '<apiVersion>68.0</apiVersion>'), []);
});

test('very old Apex versions get the compiler warning', () => {
  const found = rules(scanFile('Old.cls-meta.xml', '<apiVersion>15.0</apiVersion>'));
  assert.ok(found.includes('apex-version-too-old'));
  assert.ok(found.includes('api-version-gone'));
});

test('REST URLs pinned to old versions are flagged by age', () => {
  assert.deepEqual(rules(scanFile('a.sh', 'curl $I/services/data/v36.0/query')), ['url-old-version']);
  assert.deepEqual(rules(scanFile('a.sh', 'curl $I/services/data/v62.0/query')), ['url-version-pinned']);
  assert.deepEqual(scanFile('a.sh', 'curl $I/services/data/v68.0/query'), []);
});

test('scripts that read the token from org display are errors', () => {
  const f = scanFile('ci.sh', 'TOKEN=$(sf org display --json | jq -r .result.accessToken)');
  assert.deepEqual(rules(f), ['cli-token-from-display']);
});

test('scripts that read the auth url from org display are errors', () => {
  const f = scanFile('ci.sh', 'sf org display --verbose --target-org ci | grep "Sfdx Auth Url"');
  assert.ok(rules(f).includes('cli-auth-url-from-display'));
});

test('the temporary secrets flag and legacy commands are reported', () => {
  assert.deepEqual(rules(scanFile('env', 'export SF_TEMP_SHOW_SECRETS=true')), ['cli-show-secrets-flag']);
  assert.deepEqual(rules(scanFile('a.sh', 'sfdx force:org:list')), ['cli-legacy-sfdx']);
});

test('SOAP login usage is warned about', () => {
  const f = scanFile('Login.java', 'POST https://login.salesforce.com/services/Soap/u/60.0 login');
  assert.ok(rules(f).includes('soap-login'));
});

test('results are sorted with errors first and summarised', () => {
  const findings = scanProject({
    'b.xml': '<apiVersion>64.0</apiVersion>',
    'a.sh': 'sfdx force:org:list\ncurl $I/services/data/v36.0/limits'
  });
  assert.equal(findings[0].severity, 'error');
  assert.deepEqual(summarize(findings), { error: 1, warn: 0, info: 2 });
});

test('exit code is non-zero only when the chosen level is reached', () => {
  const findings = scanFile('x.xml', '<apiVersion>64.0</apiVersion>');
  assert.equal(exitCode(findings, 'error'), 0);
  assert.equal(exitCode(findings, 'info'), 1);
});
```

Run `node --test tools/w27Scan.test.mjs`. Expected: 12 tests pass.

The runner collects files and prints a report. It exits with a non-zero code when an `error` is found, so it works as a CI gate.

```javascript
// tools/scan-project.mjs  (node tools/scan-project.mjs [folder])
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { exitCode, scanProject, summarize } from './w27Scan.mjs';

const root = process.argv[2] ?? '.';
const SKIP = new Set(['node_modules', '.git', '.sfdx', '.sf', 'dist']);
const KINDS = new Set(['.json', '.xml', '.sh', '.yml', '.yaml', '.js', '.mjs', '.ts', '.cls', '.md', '.java', '.env']);

function walk(dir, out = {}) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (KINDS.has(extname(name)) || name.endsWith('.cls-meta.xml')) {
      out[full] = readFileSync(full, 'utf8');
    }
  }
  return out;
}

const findings = scanProject(walk(root));
for (const f of findings) {
  console.log(`${f.severity.toUpperCase().padEnd(5)} ${f.file}:${f.line}  ${f.message}`);
}
console.log('Summary:', summarize(findings));
process.exit(exitCode(findings, 'error'));
```

## Advanced end-to-end example

### 1. Fix the CLI scripts

The old pattern read the token out of `org display`. In Winter '27 the CLI no longer prints access tokens, SFDX auth URLs or passwords by default; scripts that read them get `[REDACTED]`, which later shows up as a confusing `401`. Use the dedicated commands instead.

```bash
#!/usr/bin/env bash
# ci/get-token.sh: obtain a token for a CI step without parsing org display output
set -euo pipefail
ALIAS="${1:-ci-sandbox}"

# Old (breaks): TOKEN=$(sf org display --target-org "$ALIAS" --json | jq -r .result.accessToken)
TOKEN="$(sf org auth show-access-token --target-org "$ALIAS" --json | jq -r '.result.accessToken // empty')"
if [ -z "$TOKEN" ]; then
  echo "No access token returned for $ALIAS. Check the command and its flags with: sf org auth show-access-token --help" >&2
  exit 1
fi
echo "::add-mask::$TOKEN"
echo "$TOKEN"
```

Check the exact command names and JSON shape with `--help` for your CLI version before you rely on them. For storing a login for CI, use `sf org auth show-sfdx-auth-url` on a trusted machine once, then store the value as a secret. The temporary workaround that re-enabled secrets in `org display` ended on October 28, 2026, so remove any `SF_TEMP_SHOW_SECRETS` setting.

### 2. Move off SOAP login

SOAP `login()` in API versions 31.0 through 64.0 retires in Summer '27, and from December 1, 2026 every user authenticating through `login()` needs the Use Any API Auth permission. The durable fix is OAuth with an external client app (see [OAuth flows and external client apps](/articles/oauth-flows-and-external-client-apps/)). For a server-to-server integration that means the client credentials flow:

```javascript
// Replace SOAP login with an OAuth client credentials request (Node 22)
export async function getToken({ domain, clientId, clientSecret }) {
  const res = await fetch(`${domain}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status}`);
  }
  const body = await res.json();
  return { accessToken: body.access_token, instanceUrl: body.instance_url };
}
```

### 3. Raise API versions deliberately

API versions 31.0 through 40.0 are deprecated in Summer '27 and retired in Summer '28; versions 21.0 through 30.0 are already retired. Raise versions in steps: set `sourceApiVersion` to 68.0, deploy to a sandbox, run all tests, then raise individual class versions. Higher API versions can change behaviour (for example, sharing and access defaults changed at API 67.0 for new Apex), so test before you commit.

```json
{
  "packageDirectories": [{ "path": "force-app", "default": true }],
  "namespace": "",
  "sourceApiVersion": "68.0"
}
```

REST calls can also use the alias `latest` in place of a version number. It is convenient for exploration and scripts, but pin a number in production code so a release cannot change your results unexpectedly.

### 4. Re-check heap-sensitive code

Apex heap limits increased: synchronous from 6 MB to 10 MB, asynchronous from 12 MB to 25 MB. The change is automatic. Sandboxes have an option to keep the Summer '26 limit until production upgrades, so you can still see failures that production would not have. More headroom is not a reason to hold big lists in memory; keep using SOQL for-loops and chunking. Update comments and documents that quote the old numbers, and any code that hard-codes them:

```apex
public with sharing class HeapGuard {
    // Use the platform value, never a hard-coded size.
    public static Boolean nearLimit(Decimal fraction) {
        return Limits.getHeapSize() > Limits.getLimitHeapSize() * fraction;
    }
}
```

```apex
@IsTest
private class HeapGuardTest {
    @IsTest
    static void smallTransactionIsNotNearTheLimit() {
        System.assertEquals(false, HeapGuard.nearLimit(0.9));
    }

    @IsTest
    static void everythingIsNearAZeroFraction() {
        System.assertEquals(true, HeapGuard.nearLimit(0.0));
    }
}
```

### 5. Wire the scanner into CI

```yaml
name: release-readiness
on:
  pull_request:
  schedule:
    - cron: '0 6 * * 1'
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: node --test tools/w27Scan.test.mjs
      - run: node tools/scan-project.mjs .
```

### 6. New capabilities worth a pilot

- **Web Console (generally available):** an in-browser IDE for Apex, LWC, anonymous Apex, SOQL, tests and logs. The Developer Console is hidden by default and can be re-enabled. See [Web Console and debug logs](/articles/web-console-and-apex-debug-logs/).
- **LWC:** complex template expressions and `lwc:external` are generally available. See [LWC complex template expressions](/articles/lwc-complex-template-expressions-and-lwc-external/).
- **Apex:** `@IntegrationTest` (Developer Preview, scratch orgs only), `FORMULA()` in SOQL (Beta), explicit namespace query options, an Apex Symbol API (Beta) and cursors for Data 360 objects (Beta). Do not build production code on preview or beta features. See [Apex cursors](/articles/apex-cursors-large-result-processing/).
- **CLI:** `sf template generate apex class` supports Batchable and Queueable templates, `sf apex run` takes debug-level options, and `sf api request rest` and `sf api request graphql` are generally available.
- **Agentforce and Agent Script:** new functions such as `lower()` and `upper()`, `else if`, top-level escalation, per-connection formatting, file uploads and Multi-Agent Orchestration are described in the release notes. See [Agent Script: the complete guide](/articles/agent-script-complete-guide/).
- **Multi-Framework:** Angular is supported alongside React, and microfrontends are in Beta. See [Choosing between LWC, multi-framework and microfrontends](/articles/choosing-lwc-multiframework-microfrontends/).

## What happens behind the scenes

1. Salesforce upgrades sandboxes first, then production in waves. The same code can therefore run on different releases in different orgs for a few weeks, which is why a scanner in CI helps.
2. When an integration calls `/services/data/v68.0/...`, the platform serves that version's behaviour. A pinned older version keeps older behaviour until the version retires, when calls to it fail.
3. When a CLI script runs `org display`, the CLI now masks secrets in its output. Scripts that parse the output see the redacted marker, build an invalid `Authorization` header, and the API answers `401`.
4. For SOAP `login()`, the platform checks the user's permissions at login. After December 1, 2026 a user without Use Any API Auth cannot log in this way.
5. Heap limits are read from the platform at runtime, so `Limits.getLimitHeapSize()` already reports the new values once the org upgrades.
6. The scanner never contacts Salesforce. It reads text files, which keeps it fast and safe to run on every pull request.

## Test it and verify

1. Run `node --test tools/w27Scan.test.mjs`. Expected: 12 pass.
2. Run `node tools/scan-project.mjs .` in your repository. Expected: a list of findings, and exit code 1 if any `error` exists.
3. Fix each `error`, rerun, and confirm exit code 0.
4. Run all Apex tests in a Winter '27 sandbox: `sf apex run test --test-level RunLocalTests --result-format human --wait 30`. Expected: no new failures.
5. In a sandbox, run your CI login script. Expected: a valid token and a successful API call, not a `401`.
6. Check the integration users that use SOAP login and assign the Use Any API Auth permission as a stopgap until they move to OAuth.

## Common mistakes and fixes

- **Symptom: CI fails with `401` after a CLI update.** Cause: the script read a redacted token from `org display`. Fix: use `sf org auth show-access-token`.
- **Symptom: the SFDX auth URL secret is `[REDACTED]`.** Cause: the same masking. Fix: use `sf org auth show-sfdx-auth-url` once, on a trusted machine.
- **Symptom: a legacy integration cannot log in after December 1, 2026.** Cause: the user lacks Use Any API Auth. Fix: grant it temporarily and plan a move to OAuth.
- **Symptom: calls to an old API version fail.** Cause: the version is retired (21.0 to 30.0 already are). Fix: move to a supported version.
- **Symptom: behaviour changes after raising the API version.** Cause: versioned behaviour changes. Fix: raise gradually and run tests.
- **Symptom: sandbox shows a heap error that production does not.** Cause: the sandbox keeps the old heap limit by option. Fix: check the sandbox heap setting, and test in both.
- **Symptom: a preview feature stops working.** Cause: Developer Preview and Beta features are not for production. Fix: keep them out of release branches.

## Key takeaways

- Winter '27 is API 68.0. Update `sourceApiVersion` and test before raising class versions.
- Fix CLI scripts that read secrets from `org display`; use the `sf org auth show-...` commands.
- Plan the move away from SOAP `login()`, and grant Use Any API Auth only as a stopgap.
- API 31.0 to 40.0 are deprecated in Summer '27 and retired in Summer '28.
- Heap limits rose to 10 MB (synchronous) and 25 MB (asynchronous); do not hard-code them.
- Put a scanner in CI so the next release is a checklist, not a surprise.

## Where to go next

- [Preparing for Salesforce releases](/articles/preparing-for-salesforce-releases/)
- [GitHub Actions for Salesforce CI](/articles/github-actions-salesforce-ci/)
- [OAuth flows and external client apps](/articles/oauth-flows-and-external-client-apps/)
- [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/)
- [Salesforce DX, scratch orgs and packages](/articles/salesforce-dx-scratch-orgs-and-packages/)
