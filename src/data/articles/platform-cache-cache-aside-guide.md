---
title: "Platform Cache in Apex: Cache-Aside, TTLs and Safe Fallbacks"
description: "Speed up Apex and LWC with Platform Cache: org and session partitions, CacheBuilder, TTL choices, fallbacks that never break a request, and a tested model."
category: salesforce-development
tags: [Apex, Platform Cache, Performance, CacheBuilder, Architecture]
publishedAt: 2026-11-26
updatedAt: 2026-11-26
cover: /images/covers/platform-cache-cache-aside-guide.jpg
sources:
  - title: "Apex Developer Guide: Platform Cache"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/pages/apex_cache_namespace_overview.htm"
  - title: "Apex Developer Guide: Platform Cache Limits"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/api/apex_platform_cache_limits.htm"
  - title: "Apex Developer Guide: Platform Cache Considerations"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/pages/apex_platform_cache_limitations.htm"
---

Some data is expensive to get and rarely changes: a rate table loaded from an external service, a tree of product categories, the result of a heavy aggregate query, a token returned by another system. Reading it again in every transaction wastes callouts, SOQL queries and CPU time. **Platform Cache** is the built-in answer: a fast, in-memory key-value store that Apex can read and write, with time-to-live expiry and automatic eviction.

This article builds a complete cache-aside implementation: partitions, a `CacheBuilder` loader, a wrapper that never breaks the request when the cache is missing, and a tested model of the algorithm. For the limits that caching helps you avoid, see the [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/).

## The business scenario

Crestline Lending (a fictional lender) prices every loan quote from a rate table owned by a treasury system. Each quote calls the treasury API (about 600 ms), so a screen that shows 40 quotes makes 40 callouts and sometimes hits the callout or rate limit of the vendor. The table changes at most a few times a day. The goal: one callout per five minutes per org, shared by all users, and a graceful result when the cache is empty or unavailable.

## Before you start: setup

### In Salesforce

1. Use a Developer Edition org or sandbox. Platform Cache capacity depends on edition and any purchased allocation: the Apex Developer Guide's limits page lists 10 MB for Enterprise Edition, 30 MB for Unlimited and Performance, and 0 MB for other editions unless you buy or are granted capacity. A sandbox copies the capacity model of its edition, so check what your org actually has. Verify: Setup, Platform Cache shows a total capacity above 0 MB.
2. Create an **org cache partition** named `Rates` (Setup, Platform Cache, New Platform Cache Partition). Give it some capacity, for example 1 MB, from the org's available allocation. Verify: it appears in the partition list, and you can see its full name `local.Rates`.
3. Optionally create a **session cache** partition for per-user data. Session cache lives for the user's login session; org cache is shared by everyone. Verify: both capacities are shown.
4. Create a Named Credential `Treasury` for the external API (see [Named Credentials](/articles/rest-callouts-named-credentials/)) and grant principal access. Verify: a callout to `callout:Treasury/rates` returns data.

### In the external system

5. Find out how often the rate table changes and how stale a quote may be. Verify: the owner confirms that five minutes is acceptable.
6. Ask for a version or last-modified value in the response. It lets you invalidate sooner when rates change.

## How it works

- **Org cache** (`Cache.Org`) is shared by all users and survives across transactions. **Session cache** (`Cache.Session`) is private to one user session.
- Keys are alphanumeric strings. When you use a partition-qualified key, the format is `local.PartitionName.keyName`. You can also work with one partition through `Cache.OrgPartition` or `Cache.SessionPartition`.
- Every entry has a **time to live (TTL)** in seconds. After it passes the entry is gone. The limits page lists these values: for the org cache the minimum is 300 seconds (5 minutes), the default is 86,400 seconds (24 hours) and the maximum is 172,800 seconds (48 hours); for the session cache the minimum is 300 seconds and the maximum is 28,800 seconds (8 hours). A TTL below the minimum is not honoured, so do not design around a 30-second cache.
- A key can be at most 50 characters, a single item put into the cache at most 100 KB, and a partition needs at least 1 MB. Cached data is not encrypted, and changing an Apex class in the org can invalidate some or all of the cache.
- The cache is **not guaranteed**. Entries can be evicted at any time (it uses a least recently used policy, and capacity is limited), and a partition can be missing in a new org. A cache miss must always be a normal path, not an error.
- **Cache-aside** is the pattern: look in the cache; on a miss load from the source, store the result, and return it.
- `Cache.CacheBuilder` is an interface with one method, `doLoad(String key)`. Passing a builder class to `get` makes the platform call `doLoad` on a miss, so you write the loader once.

A few large entries are generally more efficient than many tiny ones, so cache the whole table under one key rather than one key per rate.

## Basic example

First the algorithm, in a tested Node model: a TTL cache with a least-recently-used cap, hit statistics, and a cache-aside function that shares one load between concurrent requests and never caches a null.

```javascript
// A model of the cache-aside pattern with a time to live (TTL), a size cap and statistics.

export class TtlCache {
  constructor({ ttlSeconds = 300, maxEntries = 1000, now = () => Date.now() } = {}) {
    this.ttl = ttlSeconds * 1000;
    this.max = maxEntries;
    this.now = now;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry || entry.expires <= this.now()) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.map.delete(key);
    this.map.set(key, entry); // move to the end: most recently used
    return entry.value;
  }

  put(key, value, ttlSeconds) {
    if (value === undefined) {
      throw new Error('Cannot cache undefined');
    }
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + (ttlSeconds ?? this.ttl / 1000) * 1000 });
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value); // evict the least recently used
    }
  }

  remove(key) {
    return this.map.delete(key);
  }

  stats() {
    const total = this.hits + this.misses;
    return { hits: this.hits, misses: this.misses, hitRate: total === 0 ? 0 : this.hits / total, size: this.map.size };
  }
}

// Cache-aside: look in the cache, otherwise load and store. Concurrent loads of one key share a promise.
export function cacheAside(cache, loader) {
  const inFlight = new Map();
  return async key => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (inFlight.has(key)) {
      return inFlight.get(key);
    }
    const promise = Promise.resolve(loader(key))
      .then(value => {
        if (value !== undefined && value !== null) {
          cache.put(key, value);
        }
        return value;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };
}

// Keys: "local.Partition.name" in Apex. This validates the same shape.
export function validKey(key) {
  return /^[A-Za-z0-9]{1,50}$/.test(key);
}
```

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache, cacheAside, validKey } from './cacheKit.mjs';

function clock() {
  let t = 0;
  return { now: () => t, tick: ms => { t += ms; } };
}

test('a value is returned until its ttl passes', () => {
  const c = clock();
  const cache = new TtlCache({ ttlSeconds: 10, now: c.now });
  cache.put('a', 1);
  c.tick(9_999);
  assert.equal(cache.get('a'), 1);
  c.tick(2);
  assert.equal(cache.get('a'), undefined);
});

test('a per-entry ttl overrides the default', () => {
  const c = clock();
  const cache = new TtlCache({ ttlSeconds: 100, now: c.now });
  cache.put('short', 1, 1);
  c.tick(1_001);
  assert.equal(cache.get('short'), undefined);
});

test('the least recently used entry is evicted at the size cap', () => {
  const cache = new TtlCache({ maxEntries: 2 });
  cache.put('a', 1);
  cache.put('b', 2);
  cache.get('a');
  cache.put('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('statistics count hits and misses', () => {
  const cache = new TtlCache();
  cache.put('a', 1);
  cache.get('a');
  cache.get('missing');
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1, hitRate: 0.5, size: 1 });
});

test('cache-aside loads once and then serves from the cache', async () => {
  const cache = new TtlCache();
  let loads = 0;
  const get = cacheAside(cache, async key => { loads += 1; return key.toUpperCase(); });
  assert.equal(await get('x'), 'X');
  assert.equal(await get('x'), 'X');
  assert.equal(loads, 1);
});

test('concurrent requests for one key share a single load', async () => {
  const cache = new TtlCache();
  let loads = 0;
  const get = cacheAside(cache, async () => { loads += 1; await new Promise(r => setTimeout(r, 5)); return 'v'; });
  const results = await Promise.all([get('k'), get('k'), get('k')]);
  assert.deepEqual(results, ['v', 'v', 'v']);
  assert.equal(loads, 1);
});

test('null results are not cached, so a later load can succeed', async () => {
  const cache = new TtlCache();
  let calls = 0;
  const get = cacheAside(cache, async () => (++calls === 1 ? null : 'ok'));
  assert.equal(await get('k'), null);
  assert.equal(await get('k'), 'ok');
});

test('undefined cannot be stored', () => {
  assert.throws(() => new TtlCache().put('a', undefined));
});

test('keys must be alphanumeric', () => {
  assert.equal(validKey('RateTable1'), true);
  assert.equal(validKey('rate-table'), false);
  assert.equal(validKey(''), false);
});
```

Run `node --test tools/cacheKit.test.mjs`. Expected: 9 tests pass. Note the test "null results are not cached": caching a failure would keep serving it for the whole TTL.

## Advanced end-to-end example

### 1. The loader (CacheBuilder)

```apex
public with sharing class RateTableLoader implements Cache.CacheBuilder {
    public Object doLoad(String key) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Treasury/rates');
        req.setMethod('GET');
        req.setTimeout(10000);
        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() != 200) {
            throw new RateException('Treasury returned ' + res.getStatusCode());
        }
        Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        return parsed;
    }

    public class RateException extends Exception {}
}
```

### 2. The wrapper: cache with a safe fallback

```apex
public with sharing class RateTable {
    private static final String PARTITION = 'local.Rates';
    private static final String KEY = 'current';
    private static final Integer TTL_SECONDS = 300;

    // Test code and unit tests can replace the loader.
    @TestVisible
    private static Map<String, Object> testOverride;

    public static Map<String, Object> current() {
        if (testOverride != null) {
            return testOverride;
        }
        Cache.OrgPartition partition = null;
        try {
            partition = Cache.Org.getPartition(PARTITION);
        } catch (Exception e) {
            // Partition missing or cache unavailable: carry on without a cache.
            System.debug(LoggingLevel.WARN, 'Platform Cache unavailable: ' + e.getMessage());
        }

        if (partition != null) {
            Object hit = partition.get(KEY);
            if (hit != null) {
                return (Map<String, Object>) hit;
            }
        }

        Map<String, Object> fresh = (Map<String, Object>) new RateTableLoader().doLoad(KEY);
        if (partition != null && fresh != null) {
            try {
                partition.put(KEY, fresh, TTL_SECONDS);
            } catch (Exception e) {
                System.debug(LoggingLevel.WARN, 'Could not cache rates: ' + e.getMessage());
            }
        }
        return fresh;
    }

    public static void invalidate() {
        try {
            Cache.Org.getPartition(PARTITION).remove(KEY);
        } catch (Exception e) {
            System.debug(LoggingLevel.WARN, 'Nothing to invalidate: ' + e.getMessage());
        }
    }

    public static Decimal rateFor(String product) {
        Map<String, Object> table = current();
        Object value = table == null ? null : table.get(product);
        if (value == null) {
            throw new RateTableLoader.RateException('No rate for ' + product);
        }
        return Decimal.valueOf(String.valueOf(value));
    }
}
```

Two decisions are worth pointing out. First, the wrapper treats the cache as optional: every cache call is inside a `try`, so a missing partition costs speed, not correctness. Second, `invalidate()` exists so a webhook or scheduled job can clear the entry when rates change, rather than waiting for the TTL.

### 3. A shorter form with CacheBuilder

When the loader needs no special error handling, let the platform call it on a miss:

```apex
public with sharing class RateTableShort {
    public static Map<String, Object> current() {
        return (Map<String, Object>) Cache.Org.get(RateTableLoader.class, 'local.Rates.current');
    }
}
```

With `CacheBuilder`, a miss runs `doLoad` and stores the result for you, which is the least code. Use the explicit wrapper when you need a custom TTL, fallbacks or metrics.

### 4. Session cache for per-user values

```apex
public with sharing class UserPrefs {
    public static String preferredCurrency() {
        try {
            Cache.SessionPartition p = Cache.Session.getPartition('local.UserData');
            Object v = p.get('currency');
            if (v != null) {
                return (String) v;
            }
            String loaded = [SELECT DefaultCurrencyIsoCode FROM User WHERE Id = :UserInfo.getUserId()]
                .DefaultCurrencyIsoCode;
            p.put('currency', loaded, 3600);
            return loaded;
        } catch (Exception e) {
            return UserInfo.getDefaultCurrency();
        }
    }
}
```

### 5. Tests

```apex
@IsTest
private class RateTableTest {
    private class TreasuryMock implements HttpCalloutMock {
        public Integer calls = 0;
        public HttpResponse respond(HttpRequest req) {
            calls++;
            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setBody('{"STANDARD":"5.25","JUMBO":"5.75"}');
            return res;
        }
    }

    @IsTest
    static void rateIsReadFromTheTable() {
        RateTable.testOverride = new Map<String, Object>{ 'STANDARD' => '5.25' };
        System.assertEquals(5.25, RateTable.rateFor('STANDARD'));
    }

    @IsTest
    static void unknownProductThrows() {
        RateTable.testOverride = new Map<String, Object>{ 'STANDARD' => '5.25' };
        try {
            RateTable.rateFor('MISSING');
            System.assert(false, 'expected an exception');
        } catch (RateTableLoader.RateException e) {
            System.assert(e.getMessage().contains('MISSING'));
        }
    }

    @IsTest
    static void loaderParsesTheResponse() {
        TreasuryMock mock = new TreasuryMock();
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest();
        Map<String, Object> table = (Map<String, Object>) new RateTableLoader().doLoad('current');
        Test.stopTest();
        System.assertEquals('5.75', table.get('JUMBO'));
        System.assertEquals(1, mock.calls);
    }

    @IsTest
    static void invalidateNeverThrowsWithoutAPartition() {
        RateTable.invalidate();
        System.assert(true);
    }
}
```

This Apex is syntax-checked but not compiled here. Platform Cache behaves differently in tests (data from the org is not visible, and partitions may not exist), which is why the wrapper falls back and the tests override the table. Verify method signatures on the current Apex Reference.

### 6. What to cache, and what not to

Cache read-mostly, shareable data. Do not cache per-user secrets in the org cache (everyone can read it), do not cache anything whose staleness would cause a wrong financial result, and do not use the cache as a database: an entry can vanish at any time.

## What happens behind the scenes

1. A user opens the quote screen. `RateTable.rateFor('STANDARD')` calls `current()`.
2. `current()` gets the `local.Rates` partition and asks for the key `current`. On the first request of the day, nothing is there, so the call returns null.
3. The wrapper loads the table through `RateTableLoader`: one callout to the Treasury Named Credential. It stores the parsed map in the partition with a 300-second TTL.
4. The next 39 quotes, and every other user's quotes for the next five minutes, read the map from memory. No callout, no SOQL.
5. After 300 seconds the entry expires. The next request loads a fresh table and stores it again.
6. If the platform evicts the entry sooner (capacity pressure), the next request behaves like a normal miss.
7. If the partition does not exist (a new sandbox), the `try` catches the exception and the code works, just without the speed-up.

## Choosing the TTL

A TTL is a business decision about how stale the data may be. Short TTLs (the minimum is 5 minutes) suit data that can change at any time and is expensive to load. Long TTLs (hours) suit reference data that changes on a known schedule. Combine a long TTL with explicit invalidation when you can be told about changes. Add a little randomness to TTLs of many keys so they do not all expire at the same moment and trigger a stampede of reloads; the Node model above shares one load between concurrent requests inside a process, and in Apex you can reduce the stampede risk by keeping the cached object large and the number of keys small.

## Test it and verify

1. Run `node --test tools/cacheKit.test.mjs`. Expected: 9 pass.
2. Deploy the classes and run `sf apex run test --tests RateTableTest --result-format human --wait 10`. Expected: 4 pass.
3. In anonymous Apex run `System.debug(RateTable.rateFor('STANDARD'));` twice with a debug log open. Expected: the first run shows one `CALLOUT_REQUEST`; the second shows none.
4. Wait six minutes and run it again. Expected: one callout again, because the entry expired.
5. Run `RateTable.invalidate();` then call `rateFor` again. Expected: a new callout.
6. In Setup, Platform Cache, open the partition and check the usage and hit information to confirm the cache is being used.

## Common mistakes and fixes

- **Symptom: `Cache.Org.OrgCacheException` or a null partition.** Cause: the partition does not exist or has no capacity in this org. Fix: create it, and wrap cache access so a miss falls back to the source.
- **Symptom: stale data after a change.** Cause: a long TTL with no invalidation. Fix: shorten the TTL or call `remove` when the source changes.
- **Symptom: cache never hits.** Cause: keys differ between calls (for example a timestamp in the key) or the key contains characters that are not allowed. Fix: use stable alphanumeric keys.
- **Symptom: an entry is rejected as too large.** Cause: a single item above the allowed size. Fix: cache a smaller summary, or split into several entries.
- **Symptom: one user sees another user's data.** Cause: per-user data stored in the org cache. Fix: use the session cache or put the user id in a safe key and avoid secrets.
- **Symptom: a failed load is served for minutes.** Cause: caching a null or error response. Fix: cache only successful results.
- **Symptom: tests pass locally and fail in CI.** Cause: tests depend on real cache contents. Fix: design for a miss and override data in tests.

## Key takeaways

- Platform Cache stores data in memory for Apex and Visualforce: org cache for shared data, session cache for one user.
- Use cache-aside: read, on a miss load and store, return. Never treat a miss as an error.
- Choose the TTL from the business tolerance for stale data, and invalidate explicitly when you can.
- Cache a few larger items instead of many small ones, and never cache secrets in the org cache.
- Wrap cache calls so a missing partition costs speed and not correctness.

## Where to go next

- [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/)
- [Calling external APIs with Named Credentials](/articles/rest-callouts-named-credentials/)
- [Outbound callouts: advanced patterns](/articles/outbound-callouts-advanced/)
- [Timeouts, duplicates and external IDs](/articles/idempotent-retries-timeouts-and-external-ids/)
- [Apex test classes best practices](/articles/apex-test-classes-best-practices/)
