---
title: "Apex Record Locking: FOR UPDATE, Deadlocks and UNABLE_TO_LOCK_ROW"
description: "Stop lost updates and lock errors in Apex: use FOR UPDATE correctly, lock rows in a safe order, group child rows by parent, and retry lock failures safely."
category: salesforce-development
tags: [Apex, Record Locking, FOR UPDATE, Concurrency, Advanced]
publishedAt: 2026-11-27
updatedAt: 2026-11-27
cover: /images/covers/apex-record-locking-for-update-and-contention.jpg
sources:
  - title: "Apex Developer Guide: Locking Statements"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexref/langCon_apex_locking_statements.htm"
  - title: "Apex Developer Guide: Avoiding Deadlocks"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/api/langCon_apex_deadlocks.htm"
  - title: "Data Model: Record-Level Locking"
    url: "https://developer.salesforce.com/docs/atlas.en-us.draes.meta/draes/draes_object_relationships_record_level_locking.htm"
  - title: "Bulk API Developer Guide: Organize Data to Minimize Lock Contention"
    url: "https://developer.salesforce.com/docs/platform/api-asynch/guide/datafiles-organize-data.html"
---

Two people draw money from the same credit line at the same moment. Both screens read "1,000 available", both subtract 700, and both save. Without protection the second save quietly overwrites the first and the line is overdrawn. This is a **lost update**, and it is the classic concurrency bug in Apex. The opposite problem is just as common: a data load or a trigger fails with `UNABLE_TO_LOCK_ROW` because two processes wanted the same record at the same time.

Salesforce protects records with **row locks**. This article shows when the platform locks for you, how to ask for a lock yourself with `FOR UPDATE`, how to take several locks without deadlocks, how to shape data loads so jobs do not fight over parents, and how to retry the failures that remain. For the governor limits that apply to the queries used here, see the [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/).

## The business scenario

Crestline Lending (a fictional lender) has a `Credit_Line__c` object with an `Available_Amount__c` field, and a `Drawdown__c` child object for each withdrawal. Relationship managers reserve money from a line on screen, a nightly job imports thousands of drawdowns, and a transfer tool moves money between two lines. Three things must be true: a line is never overdrawn, two opposite transfers never freeze each other, and the nightly import finishes even when users are working on the same lines.

## Before you start: setup

### In Salesforce

1. Use a Developer sandbox or scratch org. Verify: you can deploy Apex with `sf project deploy start`.
2. Create the custom object `Credit_Line__c` with a required currency or number field `Available_Amount__c`. Verify: you can create a record in the UI.
3. Create the child object `Drawdown__c` with a master-detail field `Credit_Line__c` pointing to `Credit_Line__c`, and a number field `Amount__c`. Verify: a Drawdown shows its Credit Line in the record page.
4. Give your user access to both objects and their fields (a permission set, see [permission sets vs profiles](/articles/permission-sets-vs-profiles/)). Verify: you can create and edit both objects as that user. The classes below use `with sharing`, and classes saved at API 67.0 or later run queries in user mode by default (see [Apex security and user mode](/articles/apex-security-and-user-mode/)), so access matters.

### On your computer

5. Install Node 22 LTS or newer to run the lock model. Verify: `node --version` prints v22 or higher.
6. Create a folder `tools/` and save the two files shown below as `lockKit.mjs` and `lockKit.test.mjs`. Verify: `node --test tools/lockKit.test.mjs` passes.

## How it works

A **row lock** says "I am changing this record, wait for me". Salesforce takes row locks for you in several cases, and you can request one yourself.

- **Automatic locks.** When a DML statement updates a record, that record is locked until the transaction ends. The data model guide adds that when child records in a master-detail relationship are updated, the system locks the parent and the child records to prevent inconsistencies. Locks are held very briefly in a normal transaction, so most users never notice them.
- **`FOR UPDATE`.** Add it after a SOQL query in Apex and the returned rows are locked at once, before you change them. While they are locked, no other client or user can update them through code or the user interface. The lock is released when the transaction completes.
- **Waiting.** A process that wants a locked record waits up to **10 seconds**. If the lock is still held, a query with `FOR UPDATE` throws a `QueryException` and a DML statement throws a `DmlException` (with the status code `UNABLE_TO_LOCK_ROW` for lock failures).
- **Ordering.** The Apex guide says that when records are locked, parents are locked first and then children, and that records of the same type are locked in order of Id when several are edited together. Two transactions that take locks in the same order cannot deadlock.
- **A restriction to remember.** You cannot use `ORDER BY` in a SOQL query that uses locking.

Locking is a trade: every lock makes other work wait. Lock only the rows you are about to change, and keep the transaction short. Do not make a callout between the lock and the commit: the Apex guide notes that locks taken with `FOR UPDATE` are released automatically when a callout happens, so a callout also removes the protection you wanted.

## Basic example

Start with the thinking tool: a model of locks, ordering and deadlock detection. It runs in Node in milliseconds, so you can see why opposite lock order freezes two transactions and why sorting fixes it. It models the idea, not Salesforce internals.

```javascript
// A small model of row locking: lock ordering, deadlock detection, retry planning and parent grouping.
// It models ideas (wait-for graphs, ordering, backoff), not Salesforce internals.

// Sort ids so every transaction takes locks in the same order.
export function lockOrder(ids) {
  return [...new Set(ids)].sort();
}

// Find a cycle in a wait-for graph: { tx1: 'tx2' } means tx1 waits for tx2.
export function findDeadlock(waitsFor) {
  for (const start of Object.keys(waitsFor)) {
    const seen = [start];
    let current = waitsFor[start];
    while (current !== undefined) {
      const at = seen.indexOf(current);
      if (at !== -1) {
        return seen.slice(at);
      }
      seen.push(current);
      current = waitsFor[current];
    }
  }
  return null;
}

// Run transactions step by step. Each transaction is { name, locks: [rowId, ...] }.
// A transaction takes its next lock each round, waits if another one holds it,
// and releases everything when it has all of its locks (it "commits").
export function simulate(transactions) {
  const owner = new Map();
  const state = transactions.map(t => ({ name: t.name, locks: t.locks, next: 0, done: false }));
  const committed = [];
  for (let round = 0; round < 100; round += 1) {
    const waitsFor = {};
    let progress = false;
    for (const tx of state.filter(t => !t.done)) {
      const row = tx.locks[tx.next];
      const holder = owner.get(row);
      if (holder === undefined || holder === tx.name) {
        owner.set(row, tx.name);
        tx.next += 1;
        progress = true;
        if (tx.next === tx.locks.length) {
          tx.done = true;
          committed.push(tx.name);
          for (const [r, o] of [...owner]) {
            if (o === tx.name) owner.delete(r);
          }
        }
      } else {
        waitsFor[tx.name] = holder;
      }
    }
    if (state.every(t => t.done)) {
      return { status: 'committed', order: committed };
    }
    if (!progress) {
      const cycle = findDeadlock(waitsFor);
      return { status: cycle ? 'deadlock' : 'stuck', cycle, order: committed };
    }
  }
  return { status: 'stuck', cycle: null, order: committed };
}

// Only lock errors are worth retrying; validation and other errors are not.
export function shouldRetry(statusCode, attempt, maxAttempts = 4) {
  return statusCode === 'UNABLE_TO_LOCK_ROW' && attempt < maxAttempts;
}

// Delay before the next try, in seconds: 2, 4, 8 ... capped.
export function retryDelaySeconds(attempt, baseSeconds = 2, capSeconds = 60) {
  return Math.min(capSeconds, baseSeconds * 2 ** (attempt - 1));
}

// Split rows into chunks without splitting one parent across two chunks (unless one parent
// alone is bigger than the chunk). Chunks that share no parent cannot fight over a parent lock.
export function chunkByParent(rows, parentKey, size) {
  const byParent = new Map();
  for (const row of rows) {
    const key = row[parentKey];
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(row);
  }
  const chunks = [];
  let current = [];
  for (const key of [...byParent.keys()].sort()) {
    const group = byParent.get(key);
    if (current.length > 0 && current.length + group.length > size) {
      chunks.push(current);
      current = [];
    }
    current = current.concat(group);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
```

Now the tests. The deadlock test creates the exact situation of two opposite transfers.

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkByParent, findDeadlock, lockOrder, retryDelaySeconds, shouldRetry, simulate } from './lockKit.mjs';

test('lockOrder sorts and removes duplicates', () => {
  assert.deepEqual(lockOrder(['b', 'a', 'b', 'c']), ['a', 'b', 'c']);
});

test('findDeadlock finds a cycle and ignores a chain', () => {
  assert.deepEqual(findDeadlock({ t1: 't2', t2: 't1' }).sort(), ['t1', 't2']);
  assert.equal(findDeadlock({ t1: 't2' }), null);
  assert.equal(findDeadlock({}), null);
});

test('opposite lock order deadlocks', () => {
  const result = simulate([
    { name: 't1', locks: ['A', 'B'] },
    { name: 't2', locks: ['B', 'A'] },
  ]);
  assert.equal(result.status, 'deadlock');
  assert.deepEqual(result.cycle.sort(), ['t1', 't2']);
});

test('the same order never deadlocks', () => {
  const result = simulate([
    { name: 't1', locks: lockOrder(['B', 'A']) },
    { name: 't2', locks: lockOrder(['A', 'B']) },
  ]);
  assert.equal(result.status, 'committed');
  assert.deepEqual(result.order, ['t1', 't2']);
});

test('transactions on different rows both commit in one round', () => {
  const result = simulate([
    { name: 't1', locks: ['A'] },
    { name: 't2', locks: ['B'] },
  ]);
  assert.equal(result.status, 'committed');
  assert.deepEqual(result.order, ['t1', 't2']);
});

test('only lock errors are retried, up to the attempt cap', () => {
  assert.equal(shouldRetry('UNABLE_TO_LOCK_ROW', 1), true);
  assert.equal(shouldRetry('UNABLE_TO_LOCK_ROW', 4), false);
  assert.equal(shouldRetry('REQUIRED_FIELD_MISSING', 1), false);
});

test('retry delay doubles and is capped', () => {
  assert.deepEqual([1, 2, 3, 4].map(n => retryDelaySeconds(n)), [2, 4, 8, 16]);
  assert.equal(retryDelaySeconds(10), 60);
});

test('chunkByParent keeps a parent in one chunk', () => {
  const rows = [
    { id: 1, p: 'B' }, { id: 2, p: 'A' }, { id: 3, p: 'A' },
    { id: 4, p: 'C' }, { id: 5, p: 'B' }, { id: 6, p: 'C' },
  ];
  const chunks = chunkByParent(rows, 'p', 4);
  assert.deepEqual(chunks.map(c => c.map(r => r.id)), [[2, 3, 1, 5], [4, 6]]);
  const parentsPerChunk = chunks.map(c => new Set(c.map(r => r.p)));
  const shared = [...parentsPerChunk[0]].filter(p => parentsPerChunk[1].has(p));
  assert.deepEqual(shared, []);
});

test('an oversized parent group gets its own chunk', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, p: 'A' })).concat([{ id: 9, p: 'B' }]);
  const chunks = chunkByParent(rows, 'p', 3);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 5);
});
```

Run `node --test tools/lockKit.test.mjs`. Expected: 9 tests pass. Read the test "opposite lock order deadlocks": transaction one wants A then B, transaction two wants B then A, each gets its first lock, and each waits forever for the other. The test "the same order never deadlocks" sorts the same rows first, so one transaction finishes and releases its locks before the other starts. On the platform the 10-second wait ends in an error instead of waiting forever, but the lesson is the same.

## Advanced end-to-end example

### 1. Reserve money without lost updates

The service locks the credit line, checks the balance, and subtracts. Because the query holds the lock until the transaction ends, a second user who runs the same method waits for the first to finish and then sees the updated balance.

```apex
public with sharing class CreditLineService {
    public class InsufficientFundsException extends Exception {}

    // Take money from a credit line without letting two users overdraw it.
    public static Decimal reserve(Id creditLineId, Decimal amount) {
        if (amount == null || amount <= 0) {
            throw new IllegalArgumentException('Amount must be positive.');
        }
        // The lock is taken here and held until the transaction ends.
        Credit_Line__c line = [
            SELECT Id, Available_Amount__c
            FROM Credit_Line__c
            WHERE Id = :creditLineId
            LIMIT 1
            FOR UPDATE
        ];
        if (line.Available_Amount__c < amount) {
            throw new InsufficientFundsException(
                'Requested ' + amount + ' but only ' + line.Available_Amount__c + ' is available.'
            );
        }
        line.Available_Amount__c -= amount;
        update line;
        return line.Available_Amount__c;
    }
}
```

Notice what is not here: no `ORDER BY`, no callout, and no work between the query and the update except the check. The lock is held for as short a time as possible.

### 2. Move money between two lines without deadlocks

A transfer needs two locks. If it used two separate queries, a transfer from A to B and another from B to A could each lock their first line and wait for the second. One query that returns both rows lets the platform take the locks in Id order for you.

```apex
public with sharing class CreditLineTransfer {
    // Move money between two lines. Both rows are locked by ONE query, so the
    // platform takes the locks in Id order and two opposite transfers cannot deadlock.
    public static void move(Id fromId, Id toId, Decimal amount) {
        if (fromId == toId) {
            throw new IllegalArgumentException('Choose two different credit lines.');
        }
        Set<Id> wanted = new Set<Id>{ fromId, toId };
        Map<Id, Credit_Line__c> lines = new Map<Id, Credit_Line__c>([
            SELECT Id, Available_Amount__c
            FROM Credit_Line__c
            WHERE Id IN :wanted
            FOR UPDATE
        ]);
        Credit_Line__c source = lines.get(fromId);
        Credit_Line__c target = lines.get(toId);
        if (source == null || target == null) {
            throw new IllegalArgumentException('One of the credit lines is not visible to you.');
        }
        if (source.Available_Amount__c < amount) {
            throw new CreditLineService.InsufficientFundsException('Not enough available on the source line.');
        }
        source.Available_Amount__c -= amount;
        target.Available_Amount__c += amount;
        update new List<Credit_Line__c>{ source, target };
    }
}
```

If you must use two queries (for example because the second row depends on the first), sort the Ids yourself and query in that order, the same rule the model above checks.

### 3. Load rows and collect the lock failures

During a large import, many `Drawdown__c` rows share the same parent `Credit_Line__c`. Each insert locks the parent briefly. When two batches touch the same parent at once, some rows fail with `UNABLE_TO_LOCK_ROW`. Use partial-success DML, keep the real data errors separate, and retry only the lock failures.

```apex
public with sharing class DrawdownImport {
    public static final Integer MAX_ATTEMPTS = 4;

    // Insert what we can. Return only the rows that failed because of a lock.
    public static List<Drawdown__c> insertAndCollectLockFailures(List<Drawdown__c> rows) {
        List<Drawdown__c> lockFailures = new List<Drawdown__c>();
        List<Database.SaveResult> results = Database.insert(rows, false);
        for (Integer i = 0; i < results.size(); i++) {
            if (results[i].isSuccess()) {
                continue;
            }
            for (Database.Error err : results[i].getErrors()) {
                if (shouldRetry(err.getStatusCode(), 1)) {
                    lockFailures.add(rows[i]);
                    break;
                }
            }
            // Other errors (validation, required fields) are real data problems: log them, do not retry.
        }
        return lockFailures;
    }

    // Only lock errors are worth another try, and only a few times.
    public static Boolean shouldRetry(StatusCode code, Integer attempt) {
        return code == StatusCode.UNABLE_TO_LOCK_ROW && attempt < MAX_ATTEMPTS;
    }
}
```

### 4. Retry in a Queueable job, a few times

A lock failure is temporary, so another attempt a moment later usually works. The job below retries the failed rows and stops after the attempt cap. It reuses the same `shouldRetry` rule as the importer, so the decision lives in one place.

```apex
public with sharing class DrawdownRetryJob implements Queueable {
    private List<Drawdown__c> rows;
    private Integer attempt;

    public DrawdownRetryJob(List<Drawdown__c> rows, Integer attempt) {
        this.rows = rows;
        this.attempt = attempt;
    }

    public void execute(QueueableContext context) {
        List<Drawdown__c> stillLocked = new List<Drawdown__c>();
        List<Database.SaveResult> results = Database.insert(rows, false);
        for (Integer i = 0; i < results.size(); i++) {
            if (results[i].isSuccess()) {
                continue;
            }
            for (Database.Error err : results[i].getErrors()) {
                if (DrawdownImport.shouldRetry(err.getStatusCode(), attempt)) {
                    stillLocked.add(rows[i]);
                    break;
                }
            }
        }
        if (!stillLocked.isEmpty() && attempt < DrawdownImport.MAX_ATTEMPTS && !Test.isRunningTest()) {
            System.enqueueJob(new DrawdownRetryJob(stillLocked, attempt + 1));
        } else if (!stillLocked.isEmpty()) {
            // Out of attempts: keep the rows somewhere a person can see them.
            System.debug(LoggingLevel.ERROR, stillLocked.size() + ' drawdowns still locked after ' + attempt + ' attempts.');
        }
    }
}
```

The job does not retry endlessly. After the last attempt it records the rows for a person or a support job to review (here as a debug line; in a real org write them to a status field or a log object, as in [batch partial failures and per-record retry](/articles/batch-partial-failures-per-record-status-retry/)). For a general treatment of chaining jobs see [Queueable Apex: the complete guide](/articles/queueable-apex-complete-guide/) and [advanced async patterns](/articles/apex-async-advanced-patterns/).

### 5. Shape the load so jobs do not collide

The best fix is to avoid the contention. The Bulk API guide advises sorting the main records by their parent so that different child records of one parent do not land in different jobs, because creating or updating a child locks its parent. The same idea applies to your own batches: group the rows by parent and never split one parent across two parallel chunks. The function `chunkByParent` in the model does exactly that, and its tests prove that two chunks never share a parent. See also the [Bulk API 2.0 ingest guide](/articles/bulk-api-2-ingest-guide/).

### 6. Tests

```apex
@IsTest
private class CreditLineServiceTest {
    @TestSetup
    static void setup() {
        insert new Credit_Line__c(Name = 'Line A', Available_Amount__c = 1000);
        insert new Credit_Line__c(Name = 'Line B', Available_Amount__c = 500);
    }

    @IsTest
    static void reserveReducesTheAvailableAmount() {
        Credit_Line__c line = [SELECT Id FROM Credit_Line__c WHERE Name = 'Line A'];
        Decimal left = CreditLineService.reserve(line.Id, 250);
        System.assertEquals(750, left);
        System.assertEquals(750, [SELECT Available_Amount__c FROM Credit_Line__c WHERE Id = :line.Id].Available_Amount__c);
    }

    @IsTest
    static void reserveRejectsMoreThanAvailable() {
        Credit_Line__c line = [SELECT Id FROM Credit_Line__c WHERE Name = 'Line B'];
        try {
            CreditLineService.reserve(line.Id, 501);
            System.assert(false, 'Expected an InsufficientFundsException.');
        } catch (CreditLineService.InsufficientFundsException e) {
            System.assert(e.getMessage().contains('only 500'));
        }
        System.assertEquals(500, [SELECT Available_Amount__c FROM Credit_Line__c WHERE Id = :line.Id].Available_Amount__c);
    }

    @IsTest
    static void transferMovesMoneyBothWays() {
        Credit_Line__c a = [SELECT Id FROM Credit_Line__c WHERE Name = 'Line A'];
        Credit_Line__c b = [SELECT Id FROM Credit_Line__c WHERE Name = 'Line B'];
        CreditLineTransfer.move(a.Id, b.Id, 100);
        CreditLineTransfer.move(b.Id, a.Id, 30);
        System.assertEquals(930, [SELECT Available_Amount__c FROM Credit_Line__c WHERE Id = :a.Id].Available_Amount__c);
        System.assertEquals(570, [SELECT Available_Amount__c FROM Credit_Line__c WHERE Id = :b.Id].Available_Amount__c);
    }

    @IsTest
    static void onlyLockErrorsAreRetriedAndOnlyAFewTimes() {
        System.assertEquals(true, DrawdownImport.shouldRetry(StatusCode.UNABLE_TO_LOCK_ROW, 1));
        System.assertEquals(false, DrawdownImport.shouldRetry(StatusCode.UNABLE_TO_LOCK_ROW, DrawdownImport.MAX_ATTEMPTS));
        System.assertEquals(false, DrawdownImport.shouldRetry(StatusCode.REQUIRED_FIELD_MISSING, 1));
    }
}
```

This Apex is syntax-checked but not compiled here. Tests cannot create real concurrency, so they check the logic (balances, the retry rule); the locking itself is the platform's job. To see a real lock timeout, run the manual check in the next section.

## What happens behind the scenes

1. `CreditLineService.reserve` runs the query with `FOR UPDATE`. The platform finds the row and locks it for your transaction. If another transaction already holds the lock, yours waits.
2. If the other transaction finishes within 10 seconds, its lock is released, your query returns the fresh row, and your check works on the real balance. If not, a `QueryException` is thrown and nothing has changed.
3. `update line` changes the locked row. The lock stays until the transaction ends, so no one can slip in between your check and your update.
4. When the transaction commits (or rolls back), the lock is released and any waiting transaction continues.
5. For the import, each inserted `Drawdown__c` also locks its master `Credit_Line__c` for a short time. Two batches inserting children for the same line can collide. The platform reports `UNABLE_TO_LOCK_ROW` for the loser, and `Database.insert(rows, false)` lets the rest of the rows succeed.
6. The retry job inserts the failed rows again. By then the other batch has usually finished, so the lock is free.

## When to lock, and when not to

Use `FOR UPDATE` when you read a value, decide, and then write it back, and a stale read would cause a wrong result (balances, counters, inventory, "next number" fields). Do not use it for plain reads, reports or screens that only display data. Do not lock a large number of rows "to be safe": every locked row can make another user's save wait. If many records can be changed independently, prefer a design where each record owns its own data, so there is nothing to fight over.

## Test it and verify

1. Run `node --test tools/lockKit.test.mjs`. Expected: 9 pass.
2. Deploy the classes and run `sf apex run test --tests CreditLineServiceTest --result-format human --wait 10`. Expected: 4 pass.
3. Manual lock check, two sessions. In session one, run anonymous Apex that queries a credit line with `FOR UPDATE` and then waits, for example with a loop that checks `System.currentTimeMillis()` for about eight seconds, and in the meantime start session two with `CreditLineService.reserve(lineId, 1);`. Expected: session two waits and then succeeds if session one ends within 10 seconds. This is a demonstration only, never ship a busy loop.
4. Open a debug log (see [Web Console and debug logs](/articles/web-console-and-apex-debug-logs/)) and find the SOQL line for the locking query. Expected: it shows `FOR UPDATE` in the query text.
5. Import 200 `Drawdown__c` rows for one credit line in two parallel Bulk API jobs. Expected: some `UNABLE_TO_LOCK_ROW` failures in the failed-results file. Sort the file by `Credit_Line__c` and run it again as one job. Expected: no lock failures.

## Common mistakes and fixes

- **Symptom: a compile or query error mentioning `ORDER BY` with `FOR UPDATE`.** Cause: locking queries cannot use `ORDER BY`. Fix: remove it and sort the returned list in Apex.
- **Symptom: the balance is still wrong under load.** Cause: the query that reads the value has no `FOR UPDATE`, so two users read the same number. Fix: lock the row when you read it, not afterwards.
- **Symptom: `QueryException` after about 10 seconds.** Cause: another process holds the lock for too long, often a long transaction or a slow trigger. Fix: shorten the work that runs while a lock is held, and retry or tell the user to try again.
- **Symptom: two opposite transfers sometimes fail.** Cause: locks taken in different orders. Fix: lock all rows in one query, or sort Ids and always lock in that order.
- **Symptom: `UNABLE_TO_LOCK_ROW` during large loads.** Cause: parallel jobs updating children of the same parent. Fix: sort and group the data by parent, reduce parallelism, and retry only lock errors.
- **Symptom: the lock "disappears" after a callout.** Cause: the Apex guide says locks from `FOR UPDATE` are released on callouts. Fix: finish the read-decide-write cycle before any callout, or move the callout to a separate job.
- **Symptom: retries never end.** Cause: no attempt cap, or retrying every error. Fix: retry only `UNABLE_TO_LOCK_ROW`, and stop after a few attempts.

## Key takeaways

- A row lock stops two transactions from changing the same record at once; it is released when the transaction ends.
- Use `FOR UPDATE` for read, decide, write cycles. Keep the locked section short, with no callouts.
- Waiting is limited to 10 seconds, after which you get an exception; plan for it.
- Take several locks in one query, or always in the same (Id) order, to avoid deadlocks.
- Group child rows by parent in loads, and retry only lock failures, a few times.

## Where to go next

- [Batch partial failures and per-record retry](/articles/batch-partial-failures-per-record-status-retry/)
- [Bulkify Apex triggers](/articles/bulkify-apex-triggers/)
- [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/)
- [Apex test classes best practices](/articles/apex-test-classes-best-practices/)
- [Idempotent retries, timeouts and external IDs](/articles/idempotent-retries-timeouts-and-external-ids/)
