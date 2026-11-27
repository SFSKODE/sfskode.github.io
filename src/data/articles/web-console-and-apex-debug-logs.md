---
title: "Web Console and Debug Logs: Find Apex Problems Fast in Winter '27"
description: "Use the new Web Console, trace flags, debug levels and the CLI to read Apex logs, spot queries in loops and limit pressure, with a tested log analyzer."
category: salesforce-development
tags: [Debugging, Web Console, Debug Logs, Apex, Tooling]
publishedAt: 2026-11-26
updatedAt: 2026-11-26
cover: /images/covers/web-console-and-apex-debug-logs.jpg
sources:
  - title: "Announcing General Availability of Web Console (Salesforce Developers Blog)"
    url: "https://developer.salesforce.com/blogs/2026/09/announcing-general-availability-web-console-your-modern-in-browser-ide"
  - title: "The Salesforce Developer's Guide to the Winter '27 Release"
    url: "https://developer.salesforce.com/blogs/2026/10/developers-guide-to-the-winter-27-release"
  - title: "Web Console: Frequently Asked Questions (Salesforce Developers)"
    url: "https://developer.salesforce.com/docs/platform/webconsole/guide/faq.html"
---

When Apex misbehaves, the fastest teacher is the debug log: a line-by-line record of what the platform did, including every query, every DML statement, every exception and how close you came to each limit. The tools for getting and reading logs have changed in recent releases. The **Web Console** is now generally available as a browser-based IDE, and the **Developer Console** is hidden from Setup by default in Winter '27.

This article shows how to produce a useful log, read it, and automate the reading. It builds a small log analyzer you can run on any log, and walks through finding a classic problem, a query inside a loop. For the limits you are reading against, see the [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/).

## The business scenario

Crestline Lending (a fictional lender) has a trigger that "sometimes" fails on large imports with `Too many SOQL queries: 101`. Nobody can reproduce it by hand with one record. The team needs to capture a log for the failing import, find the line that runs the query repeatedly, fix it, and prove the fix with numbers.

## Before you start: setup

### In Salesforce

1. Use a sandbox or Developer Edition org. Production Apex is read-only in the Web Console, so practice somewhere you can edit.
2. Open Setup and search for Web Console (under Development at the time of writing). Confirm it is enabled. Salesforce's announcement says it is enabled by default for admins, and only an admin can turn it on or off for the org (users cannot do it for themselves). Third-party Winter '27 write-ups report that other users also need the **Web Console User** permission together with **View All Data**, and that the menu entry simply does not appear without them, so if a developer cannot see it, check both permissions first. Because View All Data bypasses sharing, grant it deliberately. Verify: the Web Console opens from the Setup gear menu.
3. If you still want the old tool, the same page has an option to enable the Developer Console again. Verify: the Developer Console appears in the gear menu after you enable it.
4. Make sure your user can view logs and set trace flags (the "View All Data" or "Manage Users" style permissions vary; an admin can grant a permission set with the debug-log permissions your org uses).
5. Create the sample classes in this article in a Developer sandbox. Verify: `sf project deploy start` completes.

### On your computer

6. Install the Salesforce CLI and authenticate: `sf org login web --alias dev`. Verify: `sf org list` shows `dev`.
7. Install Node 22 or newer so you can run the analyzer. Verify: `node --version`.

## How it works

A debug log is controlled by two things:

- A **trace flag** says *who* is being logged (a user, a class, a trigger or a flow) and for how long.
- A **debug level** says *how much* is recorded, by category (Apex code, database, workflow, validation, callouts, system and others) and level (NONE up to FINEST).

Each log line looks like `10:00:00.0 (2000000)|SOQL_EXECUTE_BEGIN|[12]|...`: a clock time, a nanosecond counter in parentheses, an event name, and details such as the source line in brackets. The limit summary near the end (`CUMULATIVE_LIMIT_USAGE`) lists values such as `Number of SOQL queries: 91 out of 100`.

Logs have size limits and old logs are removed, so use narrow levels: start with Apex code at DEBUG and database at INFO, and raise a category only when you need more.

## Basic example

Capture and read your first log.

1. In the Web Console, open the command palette and run the command to create a trace flag for the current user (the command is named like "SFDX: Create Trace Flag for Current User"). Choose a short duration.
2. Create and run an anonymous Apex script that you want to examine:

```apex
List<Account> accounts = [SELECT Id, Name FROM Account LIMIT 5];
for (Account a : accounts) {
    System.debug('Account: ' + a.Name);
}
System.debug('Queries used: ' + Limits.getQueries() + ' of ' + Limits.getLimitQueries());
```

3. Open the log (the "Get Apex Debug Logs" command in the Web Console, or `sf apex get log --number 1` in a terminal). Salesforce's Web Console FAQ also lists a Debug Logs Viewer, so you can read logs without leaving the browser. Look for the `USER_DEBUG` lines and the final limit summary.

From the CLI the same flow is scriptable:

```bash
# Run an anonymous script and print its log (check `sf apex run --help` for the flags in your CLI version)
sf apex run --file scripts/probe.apex --target-org dev

# Fetch the most recent log and save it
sf apex get log --number 1 --target-org dev > last.log
wc -l last.log
```

Newer CLI versions also accept debug-level options on `sf apex run`; run the help command to see the exact flag names your version supports.

## Advanced end-to-end example

### 1. The problem: a query inside a loop

```apex
public with sharing class LoanTriggerHandler {
    public static void setOwnerRegion(List<Loan__c> loans) {
        for (Loan__c loan : loans) {
            // One query per record: the 101st record in a batch fails.
            Account borrower = [SELECT Id, BillingState FROM Account WHERE Id = :loan.Borrower__c];
            loan.Region__c = borrower.BillingState;
        }
    }
}
```

With a log, the pattern is plain: the same source line, `[6]` here, appears in `SOQL_EXECUTE_BEGIN` once per record.

### 2. The analyzer

This Node module turns a log into a summary. It parses event lines, collects queries with their time and rows, DML, exceptions and user debug output, reads the limit table, and reports repeated queries and limits above 70%.

```javascript
// Summarise an Apex debug log: SOQL, DML, exceptions, user debug lines and limit usage.

const EVENT = /^\d{1,2}:\d{2}:\d{2}\.\d+ \((\d+)\)\|([A-Z_]+)(?:\|(.*))?$/;

export function parseLine(line) {
  const m = EVENT.exec(line);
  if (!m) {
    return null;
  }
  return { nanos: Number(m[1]), type: m[2], rest: m[3] ?? '' };
}

export function parseLimitLine(line) {
  const m = /^\s*(Number of [A-Za-z ]+|Maximum [A-Za-z ]+|Maximum CPU time|Maximum heap size):\s*(\d+) out of (\d+)/.exec(line);
  return m ? { name: m[1].trim(), used: Number(m[2]), max: Number(m[3]) } : null;
}

export function analyze(logText) {
  const out = {
    soql: [], dml: [], exceptions: [], debug: [], fatal: null, limits: [], longest: null
  };
  let inLimits = false;
  let open = null;

  for (const raw of logText.split('\n')) {
    const ev = parseLine(raw);
    if (!ev) {
      const lim = inLimits ? parseLimitLine(raw) : null;
      if (lim) {
        out.limits.push(lim);
      }
      continue;
    }
    inLimits = ev.type === 'CUMULATIVE_LIMIT_USAGE' || ev.type === 'LIMIT_USAGE_FOR_NS';
    const parts = ev.rest.split('|');
    switch (ev.type) {
      case 'SOQL_EXECUTE_BEGIN':
        open = { line: parts[0], query: parts.slice(2).join('|'), start: ev.nanos };
        break;
      case 'SOQL_EXECUTE_END':
        if (open) {
          out.soql.push({ ...open, rows: Number(/Rows:(\d+)/.exec(parts[1] ?? '')?.[1] ?? 0),
                          ms: (ev.nanos - open.start) / 1e6 });
          open = null;
        }
        break;
      case 'DML_BEGIN':
        out.dml.push({ line: parts[0], op: (parts[1] ?? '').replace('Op:', ''),
                       type: (parts[2] ?? '').replace('Type:', ''),
                       rows: Number(/Rows:(\d+)/.exec(parts[3] ?? '')?.[1] ?? 0) });
        break;
      case 'EXCEPTION_THROWN':
        out.exceptions.push({ line: parts[0], message: parts.slice(1).join('|') });
        break;
      case 'FATAL_ERROR':
        out.fatal = ev.rest;
        break;
      case 'USER_DEBUG':
        out.debug.push({ line: parts[0], level: parts[1], message: parts.slice(2).join('|') });
        break;
      default:
        break;
    }
  }
  out.longest = out.soql.reduce((a, b) => (!a || b.ms > a.ms ? b : a), null);
  return out;
}

// Anything above this share of its limit deserves attention.
export function limitWarnings(limits, threshold = 0.7) {
  return limits
    .filter(l => l.max > 0 && l.used / l.max >= threshold)
    .map(l => `${l.name}: ${l.used} of ${l.max} (${Math.round((100 * l.used) / l.max)}%)`);
}

// A query inside a loop shows up as the same line number executed many times.
export function repeatedQueries(soql, minCount = 5) {
  const counts = new Map();
  for (const q of soql) {
    counts.set(q.line, (counts.get(q.line) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= minCount).map(([line, n]) => ({ line, count: n }));
}

export function report(logText) {
  const a = analyze(logText);
  const lines = [];
  lines.push(`SOQL queries: ${a.soql.length}, DML statements: ${a.dml.length}`);
  repeatedQueries(a.soql).forEach(r => lines.push(`Possible query in a loop at ${r.line} (${r.count} times)`));
  limitWarnings(a.limits).forEach(w => lines.push(`Limit warning: ${w}`));
  a.exceptions.forEach(e => lines.push(`Exception at ${e.line}: ${e.message}`));
  if (a.fatal) {
    lines.push(`Fatal: ${a.fatal}`);
  }
  return lines.join('\n');
}
```

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, limitWarnings, parseLimitLine, parseLine, repeatedQueries, report } from './logKit.mjs';

const t = (n, type, rest) => `10:00:00.0 (${n})|${type}${rest ? '|' + rest : ''}`;

const LOG = [
  '63.0 APEX_CODE,DEBUG;DB,INFO',
  t(1000000, 'EXECUTION_STARTED'),
  t(2000000, 'SOQL_EXECUTE_BEGIN', '[12]|Aggregations:0|SELECT Id FROM Account WHERE Id = :id'),
  t(5000000, 'SOQL_EXECUTE_END', '[12]|Rows:1'),
  t(6000000, 'DML_BEGIN', '[20]|Op:Update|Type:Account|Rows:3'),
  t(7000000, 'USER_DEBUG', '[22]|DEBUG|saved | with a pipe'),
  t(8000000, 'EXCEPTION_THROWN', '[30]|System.QueryException: List has no rows'),
  t(9000000, 'FATAL_ERROR', 'System.QueryException: List has no rows'),
  t(9500000, 'CUMULATIVE_LIMIT_USAGE'),
  t(9500001, 'LIMIT_USAGE_FOR_NS', '(default)|'),
  '  Number of SOQL queries: 91 out of 100',
  '  Number of DML statements: 3 out of 150',
  '  Maximum CPU time: 9000 out of 10000',
  t(9600000, 'CUMULATIVE_LIMIT_USAGE_END')
].join('\n');

test('parseLine reads time, type and the rest', () => {
  assert.deepEqual(parseLine(t(42, 'DML_BEGIN', 'a|b')), { nanos: 42, type: 'DML_BEGIN', rest: 'a|b' });
  assert.equal(parseLine('not a log line'), null);
});

test('parseLimitLine understands the limit lines', () => {
  assert.deepEqual(parseLimitLine('  Number of SOQL queries: 3 out of 100'),
    { name: 'Number of SOQL queries', used: 3, max: 100 });
  assert.equal(parseLimitLine('Something else'), null);
});

test('analyze finds queries with rows and time', () => {
  const a = analyze(LOG);
  assert.equal(a.soql.length, 1);
  assert.equal(a.soql[0].rows, 1);
  assert.equal(a.soql[0].ms, 3);
  assert.match(a.soql[0].query, /FROM Account/);
});

test('analyze finds DML, exceptions, fatal errors and keeps pipes in debug text', () => {
  const a = analyze(LOG);
  assert.deepEqual(a.dml[0], { line: '[20]', op: 'Update', type: 'Account', rows: 3 });
  assert.equal(a.exceptions.length, 1);
  assert.match(a.fatal, /List has no rows/);
  assert.equal(a.debug[0].message, 'saved | with a pipe');
});

test('limit warnings flag anything over the threshold', () => {
  const a = analyze(LOG);
  const warnings = limitWarnings(a.limits);
  assert.equal(warnings.length, 2);
  assert.ok(warnings[0].startsWith('Number of SOQL queries: 91 of 100'));
});

test('a query executed many times from one line is reported as a loop', () => {
  const lines = [];
  for (let i = 0; i < 6; i++) {
    lines.push(t(i * 10 + 1, 'SOQL_EXECUTE_BEGIN', '[7]|Aggregations:0|SELECT Id FROM Contact'));
    lines.push(t(i * 10 + 5, 'SOQL_EXECUTE_END', '[7]|Rows:1'));
  }
  const a = analyze(lines.join('\n'));
  assert.deepEqual(repeatedQueries(a.soql), [{ line: '[7]', count: 6 }]);
});

test('the report summarises everything in plain lines', () => {
  const text = report(LOG);
  assert.match(text, /SOQL queries: 1, DML statements: 1/);
  assert.match(text, /Limit warning: Maximum CPU time/);
  assert.match(text, /Exception at \[30\]/);
});

test('an empty log gives an empty, safe result', () => {
  const a = analyze('');
  assert.equal(a.soql.length, 0);
  assert.equal(a.longest, null);
  assert.equal(report(''), 'SOQL queries: 0, DML statements: 0');
});
```

Run `node --test tools/logKit.test.mjs`. Expected: 8 pass.

### 3. Using it on a real log

```javascript
// tools/analyze-log.mjs  (node tools/analyze-log.mjs last.log)
import { readFileSync } from 'node:fs';
import { report } from './logKit.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/analyze-log.mjs <logfile>');
  process.exit(2);
}
console.log(report(readFileSync(file, 'utf8')));
```

Reproduce the failure, fetch the log and run it:

```bash
sf apex run --file scripts/import200.apex --target-org dev
sf apex get log --number 1 --target-org dev > last.log
node tools/analyze-log.mjs last.log
```

Expected output for the broken handler with 150 loans:

```text
SOQL queries: 101, DML statements: 0
Possible query in a loop at [6] (101 times)
Limit warning: Number of SOQL queries: 100 of 100 (100%)
Exception at [6]: System.LimitException: Too many SOQL queries: 101
```

### 4. The fix and a test that guards it

```apex
public with sharing class LoanTriggerHandler {
    public static void setOwnerRegion(List<Loan__c> loans) {
        Set<Id> borrowerIds = new Set<Id>();
        for (Loan__c loan : loans) {
            if (loan.Borrower__c != null) {
                borrowerIds.add(loan.Borrower__c);
            }
        }
        Map<Id, Account> borrowers = new Map<Id, Account>(
            [SELECT Id, BillingState FROM Account WHERE Id IN :borrowerIds]
        );
        for (Loan__c loan : loans) {
            Account borrower = borrowers.get(loan.Borrower__c);
            loan.Region__c = borrower == null ? null : borrower.BillingState;
        }
    }
}
```

```apex
@IsTest
private class LoanTriggerHandlerTest {
    @IsTest
    static void twoHundredLoansUseOneQuery() {
        Account acct = new Account(Name = 'Acme', BillingState = 'TX');
        insert acct;
        List<Loan__c> loans = new List<Loan__c>();
        for (Integer i = 0; i < 200; i++) {
            loans.add(new Loan__c(Borrower__c = acct.Id));
        }

        Test.startTest();
        Integer before = Limits.getQueries();
        LoanTriggerHandler.setOwnerRegion(loans);
        Integer used = Limits.getQueries() - before;
        Test.stopTest();

        System.assertEquals(1, used, 'one query regardless of record count');
        System.assertEquals('TX', loans[0].Region__c);
        System.assertEquals('TX', loans[199].Region__c);
    }

    @IsTest
    static void missingBorrowerLeavesRegionEmpty() {
        List<Loan__c> loans = new List<Loan__c>{ new Loan__c() };
        LoanTriggerHandler.setOwnerRegion(loans);
        System.assertEquals(null, loans[0].Region__c);
    }
}
```

The Apex is syntax-checked but not compiled here; adjust field names for your org.

### 5. A logging helper that costs little

```apex
public with sharing class Log {
    public static void info(String where, String message) {
        System.debug(LoggingLevel.INFO, '[' + where + '] ' + message);
    }

    public static void limits(String where) {
        System.debug(LoggingLevel.INFO, '[' + where + '] SOQL ' + Limits.getQueries() + '/'
            + Limits.getLimitQueries() + ', DML ' + Limits.getDmlStatements() + '/'
            + Limits.getLimitDmlStatements() + ', CPU ' + Limits.getCpuTime() + '/'
            + Limits.getLimitCpuTime());
    }
}
```

Never log secrets, tokens or personal data. Anyone with log access can read them.

## What happens behind the scenes

1. You create a trace flag for your user with a debug level. From then on, every transaction that user starts writes a log until the flag expires.
2. The platform records an event for each step that your levels allow. A SOQL statement produces a `SOQL_EXECUTE_BEGIN` and `SOQL_EXECUTE_END` pair with the source line and row count; a DML statement produces `DML_BEGIN` with the operation, object and row count.
3. When a limit is exceeded, the platform records `EXCEPTION_THROWN` and `FATAL_ERROR` and stops the transaction. The `CUMULATIVE_LIMIT_USAGE` block shows every limit at the moment it ended.
4. The Web Console, the Developer Console and the CLI all read the same logs through the platform's APIs. They only differ in how they display them.
5. Your analyzer reads that text. Because the same trigger line appears 101 times, it flags a query in a loop without any guessing.
6. After the fix, the same import shows one `SOQL_EXECUTE_BEGIN` for the line and a limit summary far from the maximum.

## Web Console and Developer Console: what changed

The Web Console is built on VS Code for the Web and the Salesforce Extensions for VS Code, so familiar commands appear in a command palette. You can edit Apex and, newly, Lightning web components from the Org Browser, run anonymous Apex and SOQL (including a SOQL Builder, and a Query Plan Inspector per Salesforce's Web Console FAQ), run tests, view logs, and manage trace flags. In production orgs, Apex there is read-only. The Developer Console is hidden from Setup by default in Winter '27 and can be switched back on from the Web Console settings page. A log analyzer feature was announced as coming later, so treat the Node tool as complementary.

If you need a full development environment with more compute and AI help, Salesforce positions Agentforce Vibes IDE for that; the Web Console is for quick edits inside one org.

## Test it and verify

1. Run `node --test tools/logKit.test.mjs`. Expected: 8 pass.
2. Deploy the broken handler and create 150 loans in anonymous Apex. Expected: `Too many SOQL queries: 101`.
3. Fetch the log and run the analyzer. Expected: a loop warning for the query line and a limit warning at 100 percent.
4. Deploy the fixed handler and repeat. Expected: one query, no warnings.
5. Run `sf apex run test --tests LoanTriggerHandlerTest --result-format human --wait 10`. Expected: 2 pass.
6. Remove the trace flag or let it expire, and confirm no new logs appear for your user.

## Common mistakes and fixes

- **Symptom: no log appears.** Cause: no active trace flag, or it expired. Fix: create a new trace flag with a longer window for the right user.
- **Symptom: the log is cut off.** Cause: the log hit its size limit because levels were too high. Fix: lower noisy categories (for example database or system) and raise only what you need.
- **Symptom: the failing user is not the one you are logging.** Cause: an integration or automated process user runs the code. Fix: set the trace flag on that user, or on the class or trigger.
- **Symptom: logging slows the transaction.** Cause: FINEST everywhere. Fix: use INFO or DEBUG for Apex code and keep it targeted.
- **Symptom: `System.debug` of a large object eats heap.** Cause: serialising big collections into a string. Fix: log counts and ids, not whole lists.
- **Symptom: the Developer Console menu item is gone.** Cause: it is hidden by default in Winter '27. Fix: use the Web Console, or have an admin re-enable the Developer Console on the Web Console Setup page.
- **Symptom: editing Apex in production fails.** Cause: Apex is read-only in production in the Web Console. Fix: change code in a sandbox and deploy.

## Key takeaways

- A trace flag chooses who is logged; a debug level chooses how much. Keep both narrow.
- Read three things first: the queries (line numbers and counts), the exceptions, and the limit summary.
- The same source line running many times is a query or DML in a loop.
- The Web Console is the current in-browser tool; the Developer Console must be re-enabled if you want it.
- Automate log reading with a small script, and guard fixes with a test that asserts query counts.

## Where to go next

- [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/)
- [Bulkify Apex triggers](/articles/bulkify-apex-triggers/)
- [Apex exception handling and logging](/articles/apex-exception-handling-and-logging/)
- [Writing Apex tests that actually catch bugs](/articles/apex-test-classes-best-practices/)
- [Salesforce DX, scratch orgs and packages](/articles/salesforce-dx-scratch-orgs-and-packages/)
