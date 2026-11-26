---
title: "Apex Cursors: Process Millions of Records in Chunks Without Batch Apex"
description: "Use Database.getCursor and PaginationCursor to walk very large SOQL results from Queueable jobs and LWC pages, with limits, chaining, tests and a Node model."
category: salesforce-development
tags: [Apex, Cursors, SOQL, Queueable, Large Data]
publishedAt: 2026-11-26
updatedAt: 2026-11-26
cover: /images/covers/apex-cursors-large-result-processing.jpg
sources:
  - title: "Apex Developer Guide: Apex Cursors"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_cursors.htm"
  - title: "The Salesforce Developer's Guide to the Winter '27 Release"
    url: "https://developer.salesforce.com/blogs/2026/10/developers-guide-to-the-winter-27-release"
---

A single SOQL query can return at most 50,000 rows to Apex in one transaction, and holding a large result in memory risks the heap limit. The classic answer is Batch Apex. **Apex cursors** are a second answer: you run one query, Salesforce keeps the result on the server, and your code fetches slices of it by position, from any transaction, for up to 48 hours.

This article explains the two cursor types, the limits that matter, and how to chain a Queueable job over a cursor. It also shows a paginated cursor for a user interface. For choosing between cursors, Batch Apex and Queueable, read [Batch vs Queueable vs Future](/articles/batch-vs-queueable-vs-future/).

## The business scenario

Crestline Lending (a fictional lender) must recalculate a risk band on 2.4 million Loan records after a policy change. Batch Apex works, but the team wants fine control: process 200 rows per step, stop and resume, and let a support screen page through the same result in 50-row pages. Cursors give them both.

## Before you start: setup

### In Salesforce

1. Use a scratch org or Developer sandbox. Cursors are available in current releases, so the org should be on Winter '27 (API 68.0) or newer. Verify: `sf org display --target-org myorg` shows API version 68.0 or higher (the exact output layout can differ by CLI version).
2. Create `Loan__c` with `Risk_Band__c` (Text 10) and `Balance__c` (Currency). Verify: both fields appear on the object.
3. Create a custom object `Cursor_Run__c` with `Position__c` (Number 18,0), `Total__c` (Number 18,0) and `Status__c` (Text 20) to record progress. Verify: the object exists.
4. Load test data: 5,000 loans with `sf data import tree` or the Data Loader. Verify: `sf data query -q "SELECT COUNT() FROM Loan__c"` returns 5000.

### What the platform gives you

5. Read the limits in the Apex Developer Guide page on cursors before you design: rows per cursor, fetch calls per transaction, cursors per day and expiry. The key numbers are in the next section; confirm them against the current page because limits change between releases.

## How it works

Two cursor types exist:

- **`Database.Cursor`** (standard): created with `Database.getCursor(soql, accessLevel)`. You read it with `cursor.fetch(position, count)` and learn the total with `cursor.getNumRecords()`. You choose the offsets, so you can read forwards, backwards, or jump around.
- **`Database.PaginationCursor`**: created with `Database.getPaginationCursor(soql, accessLevel)`. You read it with `fetchPage(start, pageSize)` (zero-based start, page size up to 2,000). The result is a `Database.CursorFetchResult` with `getRecords()`, `getDeletedRows()`, `getNextIndex()` and `isDone()`. It is designed for user interfaces.

The limits to design around, from the Apex Developer Guide at the time of writing:

| Limit | Value |
|---|---|
| Rows per cursor | 50 million |
| `fetch()` calls per transaction | 100 (each counts against SOQL query and row limits) |
| Standard cursors created per org per rolling 24 hours | 10,000 |
| Pagination cursors per org per rolling 24 hours | 200,000 |
| Cursor expiry | 48 hours after creation |

Creating a cursor over N rows deducts N from a daily row allowance immediately. That is why the most important rule is: **create the cursor once, store it, and never recreate it inside a chained job.**

## Basic example

First the logic, modelled in Node: a cursor you create once, a position you save, and a loop that fetches fixed-size chunks. The model has no Salesforce dependency, so you can test the control flow quickly.

```javascript
// A model of chunked processing over an Apex-style cursor.
// The cursor is created once; each "job hop" continues from a saved position.

export class FakeCursor {
  constructor(rows) {
    this.rows = rows;
    this.fetchCalls = 0;
  }
  getNumRecords() {
    return this.rows.length;
  }
  fetch(position, count) {
    this.fetchCalls += 1;
    return this.rows.slice(position, position + count);
  }
}

export const CHUNK = 200;
export const MAX_FETCH_CALLS_PER_TRANSACTION = 100;

// How many rows to fetch next, given the cursor size and the saved position.
export function nextCount(total, position, chunk = CHUNK) {
  const remaining = total - position;
  return remaining <= 0 ? 0 : Math.min(chunk, remaining);
}

// One job hop (one transaction). Returns the new position and whether to enqueue another hop.
export function runHop(cursor, position, handler, { chunk = CHUNK, fetchBudget = 1 } = {}) {
  let pos = position;
  let used = 0;
  while (used < fetchBudget) {
    const count = nextCount(cursor.getNumRecords(), pos, chunk);
    if (count === 0) {
      break;
    }
    const rows = cursor.fetch(pos, count);
    handler(rows);
    pos += rows.length;
    used += 1;
    if (rows.length === 0) {
      break; // defensive: never loop forever on an empty fetch
    }
  }
  return { position: pos, more: pos < cursor.getNumRecords() };
}

// Run hops until done. "createCursor" must be called exactly once.
export function runAll(createCursor, handler, options = {}) {
  const cursor = createCursor();
  let position = 0;
  let hops = 0;
  let more = true;
  while (more) {
    ({ position, more } = runHop(cursor, position, handler, options));
    hops += 1;
    if (hops > 1_000_000) {
      throw new Error('too many hops');
    }
  }
  return { hops, position, fetchCalls: cursor.fetchCalls };
}

// Will a plan stay inside the per-transaction fetch-call limit?
export function fetchCallsNeeded(total, chunk = CHUNK) {
  return Math.ceil(total / chunk);
}
export function fitsInOneTransaction(total, chunk = CHUNK) {
  return fetchCallsNeeded(total, chunk) <= MAX_FETCH_CALLS_PER_TRANSACTION;
}

// Page maths for a pagination cursor (page size at most 2000, zero-based start).
export function pageWindow(pageNumber, pageSize, total) {
  const size = Math.min(Math.max(pageSize, 1), 2000);
  const start = (Math.max(pageNumber, 1) - 1) * size;
  return { start, size, hasMore: start + size < total, isPastEnd: start >= total };
}
```

The tests prove the behaviour that matters: each row once, one cursor creation, a correct remainder chunk, no looping on an empty cursor, and the fetch-call arithmetic.

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeCursor, fetchCallsNeeded, fitsInOneTransaction, nextCount, pageWindow, runAll, runHop } from './cursorKit.mjs';

const rows = n => Array.from({ length: n }, (_, i) => ({ Id: 'R' + i }));

test('every row is processed exactly once, in order', () => {
  const seen = [];
  const result = runAll(() => new FakeCursor(rows(1050)), batch => seen.push(...batch.map(r => r.Id)));
  assert.equal(seen.length, 1050);
  assert.equal(new Set(seen).size, 1050);
  assert.equal(seen[0], 'R0');
  assert.equal(seen[1049], 'R1049');
  assert.equal(result.position, 1050);
});

test('the cursor is created once, however many hops run', () => {
  let created = 0;
  const result = runAll(() => { created += 1; return new FakeCursor(rows(1000)); }, () => {});
  assert.equal(created, 1);
  assert.equal(result.hops, 5);
});

test('the last chunk is the remainder', () => {
  assert.equal(nextCount(450, 400), 50);
  assert.equal(nextCount(450, 450), 0);
  assert.equal(nextCount(0, 0), 0);
});

test('one hop with a bigger fetch budget handles several chunks', () => {
  const cursor = new FakeCursor(rows(1000));
  const out = runHop(cursor, 0, () => {}, { fetchBudget: 3 });
  assert.equal(out.position, 600);
  assert.equal(out.more, true);
});

test('an empty cursor finishes without fetching', () => {
  const cursor = new FakeCursor([]);
  const result = runAll(() => cursor, () => assert.fail('no rows expected'));
  assert.equal(cursor.fetchCalls, 0);
  assert.equal(result.hops, 1);
});

test('fetch-call planning respects the 100 calls per transaction limit', () => {
  assert.equal(fetchCallsNeeded(20000), 100);
  assert.equal(fitsInOneTransaction(20000), true);
  assert.equal(fitsInOneTransaction(20001), false);
});

test('a smaller chunk size needs more fetch calls', () => {
  assert.equal(fetchCallsNeeded(1000, 50), 20);
});

test('page windows are zero based and capped at 2000 rows', () => {
  assert.deepEqual(pageWindow(1, 50, 120), { start: 0, size: 50, hasMore: true, isPastEnd: false });
  assert.deepEqual(pageWindow(3, 50, 120), { start: 100, size: 50, hasMore: false, isPastEnd: false });
  assert.equal(pageWindow(1, 5000, 10).size, 2000);
  assert.equal(pageWindow(9, 50, 120).isPastEnd, true);
});
```

Run `node --test tools/cursorKit.test.mjs`. Expected: 8 tests pass. The test "the cursor is created once, however many hops run" encodes the central rule.

## Advanced end-to-end example

### 1. A Queueable that walks a cursor

```apex
public with sharing class RiskBandJob implements Queueable {
    private static final Integer CHUNK = 200;

    private Database.Cursor cursor;
    private Integer position;
    private Id runId;

    // First call: create the cursor ONCE and record the run.
    public RiskBandJob() {
        this.cursor = Database.getCursor(
            'SELECT Id, Balance__c, Risk_Band__c FROM Loan__c ORDER BY Id',
            AccessLevel.USER_MODE
        );
        this.position = 0;
        Cursor_Run__c run = new Cursor_Run__c(
            Position__c = 0,
            Total__c = this.cursor.getNumRecords(),
            Status__c = 'Running'
        );
        insert run;
        this.runId = run.Id;
    }

    public void execute(QueueableContext ctx) {
        Integer total = this.cursor.getNumRecords();
        Integer remaining = total - this.position;
        if (remaining <= 0) {
            finish(total);
            return;
        }

        Integer count = Math.min(CHUNK, remaining);
        List<Loan__c> loans = (List<Loan__c>) this.cursor.fetch(this.position, count);

        for (Loan__c loan : loans) {
            loan.Risk_Band__c = RiskBands.forBalance(loan.Balance__c);
        }
        update as user loans;

        this.position += loans.size();
        update new Cursor_Run__c(Id = this.runId, Position__c = this.position);

        if (this.position < total) {
            System.enqueueJob(this);       // same cursor, same position: no new query
        } else {
            finish(total);
        }
    }

    private void finish(Integer total) {
        update new Cursor_Run__c(Id = this.runId, Position__c = total, Status__c = 'Done');
    }
}
```

The job object itself, including the cursor, is serialised when it is enqueued, so the next hop reuses the same server-side result.

### 2. The rule, kept pure and testable

```apex
public with sharing class RiskBands {
    public static String forBalance(Decimal balance) {
        if (balance == null) {
            return 'Unrated';
        }
        if (balance >= 1000000) {
            return 'High';
        }
        if (balance >= 100000) {
            return 'Medium';
        }
        return 'Low';
    }
}
```

### 3. A pagination cursor for a screen

```apex
public with sharing class LoanPager {
    public class PageResult {
        @AuraEnabled public List<Loan__c> records;
        @AuraEnabled public Integer nextIndex;
        @AuraEnabled public Boolean isDone;
    }

    // Stateless Apex cannot keep the cursor object between calls, so the screen
    // stores the cursor in a Queueable/record only for long-lived exports.
    // For a quick page, create a pagination cursor and read one page.
    @AuraEnabled
    public static PageResult page(Integer start, Integer pageSize) {
        Integer size = Math.min(Math.max(pageSize, 1), 2000);
        Database.PaginationCursor pc = Database.getPaginationCursor(
            'SELECT Id, Name, Balance__c FROM Loan__c ORDER BY Name',
            AccessLevel.USER_MODE
        );
        Database.CursorFetchResult res = pc.fetchPage(start, size);
        PageResult out = new PageResult();
        out.records = (List<Loan__c>) res.getRecords();
        out.nextIndex = res.getNextIndex();
        out.isDone = res.isDone();
        return out;
    }
}
```

Be careful with the cost of this shape. Each call creates a pagination cursor, which counts against the daily allowance. For a screen with many users, either cache the cursor in a longer-lived process, or prefer keyset pagination (`WHERE Name > :lastName ORDER BY Name LIMIT 50`) for simple lists. Use cursors where you truly need random access into a large frozen result.

### 4. Checking limits while you run

```apex
public with sharing class CursorLimits {
    public static String snapshot() {
        return 'cursors ' + Limits.getApexCursors() + '/' + Limits.getLimitApexCursors()
            + ', cursor rows ' + Limits.getApexCursorRows() + '/' + Limits.getLimitApexCursorRows()
            + ', fetch calls ' + Limits.getFetchCallsOnApexCursor()
            + '/' + Limits.getLimitFetchCallsOnApexCursor();
    }
}
```

### 5. Tests

```apex
@IsTest
private class RiskBandJobTest {
    @TestSetup
    static void makeData() {
        List<Loan__c> loans = new List<Loan__c>();
        for (Integer i = 0; i < 450; i++) {
            loans.add(new Loan__c(Balance__c = i * 10000));
        }
        insert loans;
    }

    @IsTest
    static void bandsFollowTheBalance() {
        System.assertEquals('Unrated', RiskBands.forBalance(null));
        System.assertEquals('Low', RiskBands.forBalance(99999));
        System.assertEquals('Medium', RiskBands.forBalance(100000));
        System.assertEquals('High', RiskBands.forBalance(1000000));
    }

    @IsTest
    static void firstHopProcessesOneChunkAndRecordsProgress() {
        Test.startTest();
        System.enqueueJob(new RiskBandJob());
        Test.stopTest();

        Cursor_Run__c run = [SELECT Position__c, Total__c, Status__c FROM Cursor_Run__c LIMIT 1];
        System.assertEquals(450, run.Total__c);
        System.assert(run.Position__c >= 200, 'at least one chunk was processed');
        System.assert([SELECT COUNT() FROM Loan__c WHERE Risk_Band__c != null] >= 200);
    }

    @IsTest
    static void pagerReturnsRequestedPage() {
        LoanPager.PageResult first = LoanPager.page(0, 100);
        System.assertEquals(100, first.records.size());
        System.assertEquals(false, first.isDone);
    }
}
```

Tests that fetch from a cursor need records created in the test, and a Queueable chain in a test runs only the first hop, which is why the assertion above checks "at least one chunk". Run these in your org; the Apex here is syntax-checked but not compiled, and the exact `getCursor` overloads and result types should be confirmed against the current Apex Reference.

## What happens behind the scenes

1. `new RiskBandJob()` runs `Database.getCursor(...)`. Salesforce executes the query once, stores the result set on the server, and returns a handle. 2.4 million rows are deducted from the daily cursor-row allowance, and one cursor from the daily cursor count.
2. The job is enqueued. Its fields, including the cursor handle and the integer position, are serialised.
3. `execute` asks the cursor for its size, computes how many rows remain, and fetches at most 200 rows from the saved position. That counts as one fetch call and one query for the transaction's limits.
4. The records are updated in user mode, and the position moves forward by the number of rows fetched.
5. If rows remain, the same job object is enqueued again. The next hop deserialises the same cursor and continues from the saved position. If it recreated the cursor instead, it would consume the daily allowance quickly and restart from row 0.
6. When the position equals the total, the run is marked `Done`. The cursor expires on its own after 48 hours.
7. A status screen can read `Cursor_Run__c` for progress without touching the cursor.

## When to choose a cursor

Use a cursor when you need to resume at a known position, read the same frozen result several times, read in either direction, or serve pages from a large result. Use Batch Apex when you want the platform to manage scope, retries per scope and a simple start-execute-finish structure with its own monitoring. Use plain SOQL with keyset pagination for ordinary screens. One cursor query is also a snapshot: rows changed after creation do not change what you fetch, and `PaginationCursor.fetchDeleted()` helps you find rows removed since.

The Winter '27 release notes describe a beta that applies cursors to Data 360 data model objects, with separate monitoring methods and a 24-hour expiry. Treat that as beta and check the current documentation before relying on it.

## Test it and verify

1. Run `node --test tools/cursorKit.test.mjs`. Expected: 8 pass.
2. Deploy the classes and run the Apex tests: `sf apex run test --tests RiskBandJobTest --result-format human --wait 10`. Expected: 3 pass.
3. In anonymous Apex run `System.enqueueJob(new RiskBandJob());`. Then open Setup, Apex Jobs. Expected: a chain of Queueable jobs, one per 200 rows.
4. Query progress: `sf data query -q "SELECT Position__c, Total__c, Status__c FROM Cursor_Run__c"`. Expected: the position rises until it equals the total and the status is `Done`.
5. Run `System.debug(CursorLimits.snapshot());` before and after. Expected: the cursor count and cursor-row usage reflect one cursor, not one per hop.

## Common mistakes and fixes

- **Symptom: daily cursor or cursor-row limits run out.** Cause: `getCursor` called inside `execute`, so every hop creates a new cursor. Fix: create it once in the constructor and reuse it.
- **Symptom: the job restarts from the first row.** Cause: the position was not stored or advanced. Fix: keep the position as an instance variable and increase it by the number of rows actually fetched.
- **Symptom: too many fetch calls.** Cause: fetching in a loop with a small chunk. Fix: bigger chunks, or spread the work over several transactions (100 fetch calls per transaction).
- **Symptom: `FatalCursorException` or an expired cursor.** Cause: the cursor is older than 48 hours, or it was invalid. Fix: recreate it deliberately and restart the run; handle `TransientCursorException` by retrying.
- **Symptom: pagination cursors are created for every page view.** Cause: a new cursor per call. Fix: use keyset pagination for simple screens, or keep the cursor in a long-lived process.
- **Symptom: records processed twice after a failure.** Cause: the position was saved before the update or not saved after it. Fix: update the records, then save the position, and make the update idempotent.
- **Symptom: results include fields the user should not see.** Cause: cursor created in system mode. Fix: pass `AccessLevel.USER_MODE` unless you have a reviewed reason not to.

## Key takeaways

- A cursor is a server-side query result you read by position, from many transactions, for up to 48 hours.
- Use `Database.Cursor` for resumable processing and `Database.PaginationCursor` for page-by-page reading.
- Create the cursor once and store it with an integer position; never recreate it in a chain.
- Watch the limits: 100 fetch calls per transaction, daily cursor and row allowances, 48-hour expiry.
- Save progress, make updates idempotent, and choose Batch Apex or keyset pagination when they fit better.

## Where to go next

- [Batch vs Queueable vs Future](/articles/batch-vs-queueable-vs-future/)
- [Queueable Apex: the complete guide](/articles/queueable-apex-complete-guide/)
- [Batch Apex: the complete guide](/articles/batch-apex-complete-guide/)
- [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/)
- [Partial batch failures and per-record status](/articles/batch-partial-failures-per-record-status-retry/)
