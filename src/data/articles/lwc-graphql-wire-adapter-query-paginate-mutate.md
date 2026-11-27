---
title: "LWC GraphQL Wire Adapter: Query, Paginate and Update Records Without Apex"
description: "Use lightning/graphql to read filtered, sorted, paginated records and update them with executeMutation, with tested helpers, error handling and cache pitfalls."
category: react-and-salesforce
tags: [LWC, GraphQL, Pagination, Mutations, Frontend]
publishedAt: 2026-11-27
updatedAt: 2026-11-27
cover: /images/covers/lwc-graphql-wire-adapter-query-paginate-mutate.jpg
sources:
  - title: "Lightning Web Components Guide: GraphQL Wire Adapter"
    url: "https://developer.salesforce.com/docs/platform/lwc/guide/reference-graphql-wire.html"
  - title: "Lightning Web Components Guide: GraphQL Pagination"
    url: "https://developer.salesforce.com/docs/platform/lwc/guide/reference-graphql-pagination.html"
  - title: "Lightning Web Components Guide: GraphQL Mutations"
    url: "https://developer.salesforce.com/docs/platform/lwc/guide/reference-graphql-mutation.html"
  - title: "Lightning Web Components Guide: Refresh GraphQL Data"
    url: "https://developer.salesforce.com/docs/platform/lwc/guide/reference-graphql-refresh.html"
  - title: "GraphQL API Developer Guide: GraphQL Wire Adapter Best Practices"
    url: "https://developer.salesforce.com/docs/platform/graphql/guide/graphql-wire-lwc-best.html"
  - title: "Salesforce Developers Blog: GraphQL Mutations Now Available in LWC"
    url: "https://developer.salesforce.com/blogs/2026/05/graphql-mutations-now-available-in-lwc-create-update-and-delete-records"
---

Many Lightning web components need a list of records that is filtered, sorted, paged and sometimes edited. Before GraphQL you chose between several wire adapters that each fetched one record at a time, or an Apex controller you had to write, secure and test. The **GraphQL wire adapter** in `lightning/graphql` is a third option: you describe exactly the objects, fields, filters and sort order in one query, and Salesforce returns just that, with the user's own access applied.

This article builds a pipeline board that filters deals by name and amount, sorts them, loads more with cursor pagination, and saves an edit with `executeMutation`. The data handling is written as plain functions that you can test in Node. For the other ways to read and write records, see [LWC forms and UI API](/articles/lwc-forms-and-ui-api/) and [LWC lifecycle and wire](/articles/lwc-lifecycle-and-wire/).

## The business scenario

Crestline Lending (a fictional lender) has a sales team that lives in the Opportunity list. A manager wants a board that shows the largest deals first, lets people type part of a deal name, hide small deals with a slider, and load ten more deals at a time. A salesperson can type a next step and save it without leaving the page. The team has no Apex developer free this sprint, and the board must respect each user's field and record access.

## Before you start: setup

### In Salesforce

1. Use a Developer Edition org, sandbox or scratch org on Winter '27 (API 68.0). Verify: you can deploy a Lightning web component with `sf project deploy start`.
2. Create about 25 Opportunities with different amounts, some with an Account and some without, and a few with the Next Step field filled in. Verify: `SELECT COUNT() FROM Opportunity` returns at least 25.
3. Check your user can read and edit Opportunities and the Name, Amount, Stage, Next Step and Account fields (see [permission sets vs profiles](/articles/permission-sets-vs-profiles/)). Verify: you can edit Next Step on an Opportunity as that user.
4. Know the limits before you start. According to Salesforce's pages: `executeMutation` cannot be used with `@wire`, `lightning/graphql` does not support Mobile Offline, backward pagination (`last` and `before`) is not supported, and child relationships cannot be queried as part of a mutation. Verify: your component targets Lightning Experience on desktop.

### On your computer

5. Install Node 22 LTS or newer. Verify: `node --version` prints v22 or higher.
6. Create a folder `tools/` and save the two files shown below as `pipelineHelpers.mjs` and `pipelineHelpers.test.mjs`. Verify: `node --test tools/pipelineHelpers.test.mjs` passes.

## How it works

A GraphQL request has an **operation** (a query or a mutation), a **document** that describes the data, and optional **variables**. In LWC you wrap the document in the `gql` tagged template and pass it to the adapter:

```javascript
import { gql, graphql, executeMutation } from 'lightning/graphql';
```

- **Query shape.** Records live under `uiapi { query { ObjectName(...) { edges { node { ... } } } } }`. Each record is a `node`, and `edges` is the list.
- **Field values are objects.** A field such as `Name` comes back as `Name { value }`, and many fields also offer `displayValue` (formatted text for the user). `Id` is a plain value. You read `node.Name.value`, not `node.Name`.
- **Filters and sorting.** `where: { Amount: { gte: $minAmount } }` filters. Salesforce's field operators include `eq`, `ne`, `lt`, `gt`, `lte`, `gte`, `like`, `in` and `nin`, and the set depends on the field type (a boolean supports only `eq` and `ne`). Several operators on one field are ANDed. `orderBy: { Amount: { order: DESC, nulls: LAST } }` sorts, and you can list several fields, which is why the query below adds `Id` as a second key: it keeps the order stable when amounts tie.
- **Variables.** Declare them on the operation line (`$minAmount: Currency`) and pass them in a `variables` object. To make the wire re-run when they change, point it at a getter: `variables: '$variables'`. Salesforce warns that passing a plain object such as `{ accountId: this.accountId }` does not react to changes.
- **Page size.** Without `first`, a query returns 10 records by default. Use `first` to set the size and `after` to continue.
- **Pagination.** It follows the GraphQL Cursor Connections Specification. Ask for `pageInfo { endCursor hasNextPage }`, and when `hasNextPage` is true pass the previous `endCursor` as `after`. Requesting `totalCount` makes Salesforce count every matching record, which can slow large queries, so this article does not use it.
- **The result.** The wire hands your handler an object with `data` and `errors`. Note the plural: unlike most wire adapters, the GraphQL adapter returns `errors` to follow the GraphQL response format. It also hands you a `refresh` function that re-runs the same query with the same variables.
- **Mutations.** `executeMutation` is imperative. For an update you send `uiapi { OpportunityUpdate(input: $input) { success } }` with an `input` that holds the record `Id` and the object's changed fields.

When is GraphQL the right tool? Salesforce's guidance: the `lightning/ui*Api` adapters that fetch records by Id are more efficient when they are enough, but they cannot express complex filtering, sorting or relationship traversal in one request. Use Apex when the object is not supported by UI API, or when you must run in system context, without the user's permissions, sharing or field-level security. GraphQL is for reading and shaping data for the signed-in user.

## Basic example

First the logic, as plain functions with no Salesforce imports. They unwrap field objects into simple values, accumulate pages, build variables, shape rows for the template and prepare mutation input.

```javascript
// pipelineHelpers.js: pure functions for a GraphQL-backed, paginated list.
// No Salesforce imports, so they run in Node and in Jest.

// GraphQL returns each field as an object such as { value, displayValue }.
// Turn { Name: { value: 'Acme' }, Account: { Name: { value: 'X' } } } into { Name: 'Acme', Account: { Name: 'X' } }.
export function unwrap(node) {
  if (node === null || typeof node !== 'object') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(unwrap);
  }
  const keys = Object.keys(node);
  if ('value' in node && keys.every(k => ['value', 'displayValue', 'label', 'format'].includes(k))) {
    return node.value;
  }
  const out = {};
  for (const key of keys) {
    out[key] = unwrap(node[key]);
  }
  return out;
}

// Convert a connection ({ edges: [{ node }], pageInfo }) to plain rows.
export function rowsFromConnection(connection) {
  const edges = (connection && connection.edges) || [];
  return edges.map(edge => unwrap(edge.node));
}

export function emptyPages() {
  return { rows: [], endCursor: undefined, hasNextPage: false };
}

// Accept one page. A page requested without a cursor is the first page and replaces everything;
// a page requested with a cursor is appended. Rows already present (same Id) are not added twice.
export function acceptPage(state, connection, after) {
  const incoming = rowsFromConnection(connection);
  const pageInfo = (connection && connection.pageInfo) || {};
  const base = after === undefined || after === null ? [] : state.rows;
  const seen = new Set(base.map(row => row.Id));
  const rows = base.concat(incoming.filter(row => !seen.has(row.Id)));
  return {
    rows,
    endCursor: pageInfo.endCursor,
    hasNextPage: Boolean(pageInfo.hasNextPage),
  };
}

// The cursor for the next page, or undefined when there is none.
export function nextCursor(state) {
  return state.hasNextPage ? state.endCursor : undefined;
}

// Replace fields of one row after a successful update, without touching the others.
export function patchRow(state, id, changes) {
  return { ...state, rows: state.rows.map(row => (row.Id === id ? { ...row, ...changes } : row)) };
}

// Variables for the query. A search text becomes a LIKE pattern; empty text matches everything.
export function buildVariables({ minAmount, search, pageSize, after }) {
  const text = (search || '').trim().replace(/[%_]/g, '');
  const variables = {
    first: pageSize,
    minAmount: Number.isFinite(minAmount) ? minAmount : 0,
    pattern: text ? `%${text}%` : '%',
  };
  if (after) {
    variables.after = after;
  }
  return variables;
}

// GraphQL responses carry an errors array of { message } objects.
export function errorMessages(errors) {
  return (errors || []).map(e => (e && e.message ? e.message : String(e)));
}

// Input for an update mutation: the record Id plus only the fields that changed.
export function updateInput(objectName, id, fields) {
  return { Id: id, [objectName]: { ...fields } };
}

// Shape one row for the template. Templates should not reach into values that can be null.
export function toViewRow(row) {
  return {
    id: row.Id,
    name: row.Name,
    accountName: row.Account && row.Account.Name ? row.Account.Name : 'No account',
    amount: row.Amount,
    stage: row.StageName,
    nextStep: row.NextStep || '',
  };
}
```

Now the tests. They include a tiny in-memory "server" that serves cursor pages, so the pagination logic is tested end to end without a Salesforce org.

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptPage, buildVariables, emptyPages, errorMessages, nextCursor, patchRow, rowsFromConnection, toViewRow, unwrap, updateInput,
} from './pipelineHelpers.mjs';

// A tiny in-memory "server" that behaves like a cursor connection.
function fakeServer(total) {
  const all = Array.from({ length: total }, (_, i) => ({
    Id: `006${String(i).padStart(3, '0')}`,
    Name: { value: `Deal ${i}` },
    Amount: { value: 1000 * (i + 1), displayValue: `$${1000 * (i + 1)}` },
    Account: { Name: { value: `Account ${i}` } },
  }));
  return ({ first, after }) => {
    const start = after ? Number(Buffer.from(after, 'base64').toString()) : 0;
    const slice = all.slice(start, start + first);
    const end = start + slice.length;
    return {
      edges: slice.map(node => ({ node })),
      pageInfo: { endCursor: Buffer.from(String(end)).toString('base64'), hasNextPage: end < total },
    };
  };
}

test('unwrap turns field objects into plain values, including parents', () => {
  const node = { Id: '006A', Name: { value: 'Acme' }, Amount: { value: 5, displayValue: '$5' }, Account: { Name: { value: 'X' } } };
  assert.deepEqual(unwrap(node), { Id: '006A', Name: 'Acme', Amount: 5, Account: { Name: 'X' } });
});

test('unwrap keeps null and a null value', () => {
  assert.equal(unwrap(null), null);
  assert.deepEqual(unwrap({ NextStep: { value: null } }), { NextStep: null });
});

test('rowsFromConnection handles an empty or missing connection', () => {
  assert.deepEqual(rowsFromConnection({ edges: [] }), []);
  assert.deepEqual(rowsFromConnection(undefined), []);
});

test('pages accumulate until there is no next page', () => {
  const server = fakeServer(25);
  let state = emptyPages();
  let after;
  let requests = 0;
  do {
    state = acceptPage(state, server({ first: 10, after }), after);
    after = nextCursor(state);
    requests += 1;
  } while (after);
  assert.equal(requests, 3);
  assert.equal(state.rows.length, 25);
  assert.equal(state.hasNextPage, false);
  assert.equal(state.rows[24].Account.Name, 'Account 24');
});

test('a first page without a cursor replaces old rows', () => {
  const server = fakeServer(25);
  let state = acceptPage(emptyPages(), server({ first: 10 }), undefined);
  state = acceptPage(state, server({ first: 10, after: state.endCursor }), state.endCursor);
  assert.equal(state.rows.length, 20);
  state = acceptPage(state, server({ first: 10 }), undefined); // filter changed: start again
  assert.equal(state.rows.length, 10);
});

test('the same page delivered twice does not duplicate rows', () => {
  const server = fakeServer(25);
  let state = acceptPage(emptyPages(), server({ first: 10 }), undefined);
  const cursor = state.endCursor;
  const page2 = server({ first: 10, after: cursor });
  state = acceptPage(state, page2, cursor);
  state = acceptPage(state, page2, cursor); // a refresh delivers it again
  assert.equal(state.rows.length, 20);
});

test('patchRow changes one row only', () => {
  const server = fakeServer(3);
  const state = acceptPage(emptyPages(), server({ first: 10 }), undefined);
  const patched = patchRow(state, '006001', { NextStep: 'Call on Monday' });
  assert.equal(patched.rows[1].NextStep, 'Call on Monday');
  assert.equal(patched.rows[0].NextStep, undefined);
  assert.equal(state.rows[1].NextStep, undefined); // the old state is untouched
});

test('buildVariables makes a LIKE pattern and strips wildcard characters', () => {
  assert.deepEqual(buildVariables({ minAmount: 5000, search: ' acme ', pageSize: 10 }), { first: 10, minAmount: 5000, pattern: '%acme%' });
  assert.equal(buildVariables({ search: '50%_off', pageSize: 5 }).pattern, '%50off%');
  assert.equal(buildVariables({ minAmount: NaN, search: '', pageSize: 5 }).pattern, '%');
  assert.equal(buildVariables({ minAmount: NaN, pageSize: 5 }).minAmount, 0);
  assert.equal(buildVariables({ pageSize: 5, after: 'abc' }).after, 'abc');
});

test('errorMessages and updateInput', () => {
  assert.deepEqual(errorMessages([{ message: 'Bad field' }, 'plain']), ['Bad field', 'plain']);
  assert.deepEqual(errorMessages(undefined), []);
  assert.deepEqual(updateInput('Opportunity', '006A', { NextStep: 'Call' }), { Id: '006A', Opportunity: { NextStep: 'Call' } });
});

test('toViewRow survives a missing account and next step', () => {
  const row = toViewRow({ Id: '006A', Name: 'Deal', Amount: 10, StageName: 'Prospecting', Account: null, NextStep: null });
  assert.deepEqual(row, { id: '006A', name: 'Deal', accountName: 'No account', amount: 10, stage: 'Prospecting', nextStep: '' });
  assert.equal(toViewRow({ Id: '1', Account: { Name: 'Acme' } }).accountName, 'Acme');
});
```

Run `node --test tools/pipelineHelpers.test.mjs`. Expected: 10 tests pass. Read these three: "pages accumulate until there is no next page" walks three requests (10, 10, 5 rows); "a first page without a cursor replaces old rows" is what happens when the user changes a filter; and "the same page delivered twice does not duplicate rows" is what protects you when a refresh delivers a page again.

## Advanced end-to-end example

### 1. The query

The query asks only for the fields the board shows. It filters by amount and name, sorts largest first, and reads one page at a time.

```javascript
const PIPELINE_QUERY = gql`
    query PipelinePage($first: Int, $after: String, $minAmount: Currency, $pattern: String) {
        uiapi {
            query {
                Opportunity(
                    first: $first
                    after: $after
                    where: { Amount: { gte: $minAmount }, Name: { like: $pattern } }
                    orderBy: { Amount: { order: DESC, nulls: LAST }, Id: { order: ASC } }
                ) {
                    edges {
                        node {
                            Id
                            Name { value }
                            Amount { value displayValue }
                            StageName { value }
                            NextStep { value }
                            Account { Name { value } }
                        }
                    }
                    pageInfo { endCursor hasNextPage }
                }
            }
        }
    }
`;
```

Variables use the type `Currency` for the amount, as in Salesforce's reactive-variables example for a currency field, and `String` for the name pattern. A `like` filter works on string fields only.

### 2. The component

Save the component as `force-app/main/default/lwc/pipelineBoard/`. The helper file from the basic example goes next to it as `pipelineHelpers.js` (the same code, with the `.js` extension), and the component imports it with a relative path.

```javascript
// pipelineBoard.js
import { LightningElement, wire } from 'lwc';
import { gql, graphql, executeMutation } from 'lightning/graphql';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import {
    acceptPage, buildVariables, emptyPages, errorMessages, nextCursor, patchRow, toViewRow, updateInput,
} from './pipelineHelpers';

const PAGE_SIZE = 10;

const PIPELINE_QUERY = gql`
    query PipelinePage($first: Int, $after: String, $minAmount: Currency, $pattern: String) {
        uiapi {
            query {
                Opportunity(
                    first: $first
                    after: $after
                    where: { Amount: { gte: $minAmount }, Name: { like: $pattern } }
                    orderBy: { Amount: { order: DESC, nulls: LAST }, Id: { order: ASC } }
                ) {
                    edges {
                        node {
                            Id
                            Name { value }
                            Amount { value displayValue }
                            StageName { value }
                            NextStep { value }
                            Account { Name { value } }
                        }
                    }
                    pageInfo { endCursor hasNextPage }
                }
            }
        }
    }
`;

const UPDATE_NEXT_STEP = gql`
    mutation UpdateNextStep($input: OpportunityUpdateInput!) {
        uiapi {
            OpportunityUpdate(input: $input) {
                success
            }
        }
    }
`;

export default class PipelineBoard extends LightningElement {
    pages = emptyPages();
    minAmount = 0;
    search = '';
    after; // the cursor of the page we are asking for; undefined means "the first page"
    errors = [];
    isLoading = true;
    _refresh;

    // A getter keeps the variables reactive: change a property it reads and the wire runs again.
    get variables() {
        return buildVariables({
            minAmount: this.minAmount,
            search: this.search,
            pageSize: PAGE_SIZE,
            after: this.after,
        });
    }

    @wire(graphql, { query: PIPELINE_QUERY, variables: '$variables' })
    wiredPipeline({ data, errors, refresh }) {
        this._refresh = refresh;
        if (data) {
            this.pages = acceptPage(this.pages, data.uiapi.query.Opportunity, this.after);
            this.errors = [];
            this.isLoading = false;
        } else if (errors) {
            this.errors = errorMessages(errors);
            this.isLoading = false;
        }
    }

    get rows() {
        return this.pages.rows.map(toViewRow);
    }

    get hasRows() {
        return this.pages.rows.length > 0;
    }

    get hasErrors() {
        return this.errors.length > 0;
    }

    get canLoadMore() {
        return this.pages.hasNextPage;
    }

    handleSearch(event) {
        this.search = event.target.value;
        this.after = undefined; // a new filter starts again from the first page
    }

    handleMinAmount(event) {
        this.minAmount = Number(event.detail.value);
        this.after = undefined;
    }

    handleLoadMore() {
        this.after = nextCursor(this.pages);
    }

    async handleSaveNextStep(event) {
        const id = event.currentTarget.dataset.id;
        const field = this.template.querySelector(`lightning-input[data-id="${id}"]`);
        const nextStep = field.value;
        try {
            const result = await executeMutation({
                query: UPDATE_NEXT_STEP,
                variables: { input: updateInput('Opportunity', id, { NextStep: nextStep }) },
            });
            if (result.errors && result.errors.length > 0) {
                this.toast('Update failed', errorMessages(result.errors).join(' '), 'error');
                return;
            }
            this.pages = patchRow(this.pages, id, { NextStep: nextStep });
            this.toast('Saved', 'Next step updated.', 'success');
        } catch (e) {
            this.toast('Update failed', e && e.message ? e.message : 'Unknown error', 'error');
        }
    }

    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
```

Four design choices are worth pointing out.

- **The `after` property is part of the variables.** Setting it re-runs the wire for the next page. Changing a filter resets it to `undefined`, so `acceptPage` replaces the rows instead of appending.
- **The template never reaches into a value that can be null.** `toViewRow` turns a missing Account into "No account", so the template stays simple.
- **After a successful update the row is patched locally.** `patchRow` changes one row in the accumulated list. Why not just call `refresh`? Because `refresh` re-runs the same query with the same variables, which means it refreshes only the page you asked for last, and Salesforce's refresh page does not describe pagination. Patching keeps the list you are looking at correct. Use `refresh` after a create (Salesforce's blog says new records do not appear in existing query results until the query is refreshed), and do not call it on a timer: the guide says to refresh once after a mutation or offer a user-triggered refresh.
- **Both ways of failing are handled.** The mutation result can carry `errors`, and the call itself can throw, so the code checks both.

### 3. The template

```html
<!-- pipelineBoard.html -->
<template>
    <lightning-card title="Pipeline" icon-name="standard:opportunity">
        <div class="slds-p-horizontal_medium">
            <div class="slds-grid slds-gutters">
                <div class="slds-col">
                    <lightning-input type="search" label="Deal name contains" onchange={handleSearch}></lightning-input>
                </div>
                <div class="slds-col">
                    <lightning-slider label="Minimum amount" min="0" max="500000" step="10000"
                        value={minAmount} onchange={handleMinAmount}></lightning-slider>
                </div>
            </div>

            <template lwc:if={hasErrors}>
                <template for:each={errors} for:item="message">
                    <p key={message} class="slds-text-color_error">{message}</p>
                </template>
            </template>

            <template lwc:if={isLoading}>
                <lightning-spinner alternative-text="Loading deals" size="small"></lightning-spinner>
            </template>
            <template lwc:elseif={hasRows}>
                <ul class="slds-m-top_small">
                    <template for:each={rows} for:item="row">
                        <li key={row.id} class="slds-m-bottom_small">
                            <strong>{row.name}</strong> ({row.accountName}, {row.stage})
                            <lightning-formatted-number value={row.amount} format-style="currency"
                                currency-code="USD"></lightning-formatted-number>
                            <div class="slds-grid slds-grid_vertical-align-end">
                                <lightning-input data-id={row.id} label="Next step" value={row.nextStep}></lightning-input>
                                <lightning-button data-id={row.id} label="Save" class="slds-m-left_small"
                                    onclick={handleSaveNextStep}></lightning-button>
                            </div>
                        </li>
                    </template>
                </ul>
                <template lwc:if={canLoadMore}>
                    <lightning-button label="Load more" onclick={handleLoadMore}></lightning-button>
                </template>
            </template>
            <template lwc:else>
                <p class="slds-m-top_small">No deals match these filters.</p>
            </template>
        </div>
    </lightning-card>
</template>
```

### 4. The metadata

```xml
<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>68.0</apiVersion>
    <isExposed>true</isExposed>
    <masterLabel>Pipeline Board</masterLabel>
    <targets>
        <target>lightning__AppPage</target>
        <target>lightning__HomePage</target>
    </targets>
</LightningComponentBundle>
```

### 5. A starter Jest test

```javascript
// __tests__/pipelineBoard.test.js
import { createElement } from 'lwc';
import PipelineBoard from 'c/pipelineBoard';

describe('c-pipeline-board', () => {
    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
    });

    it('renders the filters before data arrives', () => {
        const element = createElement('c-pipeline-board', { is: PipelineBoard });
        document.body.appendChild(element);
        expect(element.shadowRoot.querySelector('lightning-input[type="search"]')).not.toBeNull();
        expect(element.shadowRoot.querySelector('lightning-slider')).not.toBeNull();
    });
});
```

The component and its Jest test are syntax-checked, not run here. The `graphql` adapter needs the platform, so test the logic in the helper file (as above) and keep component tests for rendering. See [LWC Jest unit testing](/articles/lwc-jest-unit-testing/) for mocking wire adapters.

## What happens behind the scenes

1. The component loads. The wire reads the `variables` getter and sends the parsed `gql` document with those variables to Salesforce's GraphQL API.
2. Salesforce runs the query as the signed-in user, so only records and fields that user can see come back. The response has `data` (or `errors`) following the GraphQL response format.
3. Your handler receives `data`, passes the `Opportunity` connection to `acceptPage`, and the template re-renders with the rows.
4. "Load more" sets `after` to the last `endCursor`. The getter returns new variables, the wire calls the API again, and the new rows are appended.
5. Typing in the search box changes `search`, resets `after`, and the wire re-runs with a new `pattern`. Because the query and variables are separate, the framework can reuse the parsed query and only the variable values change.
6. The module caches query results. When you save, `executeMutation` posts the mutation to the GraphQL API. Salesforce's blog says updated fields can flow to other subscribed Lightning Data Service wires when their cached data overlaps, deletes disappear from them without a refresh, and new records need a refresh.
7. The `success` flag comes back, the component patches its own row and shows a toast.

## Common mistakes and fixes

- **Symptom: the list never changes when a property changes.** Cause: variables were passed as a plain object. Fix: pass a getter, `variables: '$variables'`, that reads the properties.
- **Symptom: `node.Name` prints `[object Object]`.** Cause: GraphQL fields are objects. Fix: read `Name.value` (or `displayValue` for display text), or unwrap them as the helper does.
- **Symptom: only 10 records show.** Cause: no `first` argument, and the default page size is 10. Fix: set `first`, and paginate with `after`.
- **Symptom: pages repeat or the list jumps back after "Load more".** Cause: the cursor was not reset after a filter change, or pages were replaced instead of appended. Fix: reset `after` to `undefined` on filter change and use `acceptPage`.
- **Symptom: `last` or `before` are rejected.** Cause: backward pagination is not supported. Fix: keep the loaded pages in memory and move back within them.
- **Symptom: `data` is `undefined` and nothing renders.** Cause: the first callback is empty while loading, or `errors` has content. Fix: handle `data`, then `errors`, and show a message.
- **Symptom: a mutation succeeds but the list shows old values.** Cause: the cached query result was not updated, or a new record does not match the cached query. Fix: patch the row, or call the `refresh` function once after the mutation.
- **Symptom: the mutation fails with an input error.** Cause: the `input` does not follow the pattern (record `Id` plus the object's fields), or includes fields the user cannot update. Fix: send only updateable fields, as `updateInput` does.
- **Symptom: a slow query on a large object.** Cause: `totalCount` forces a full count. Fix: leave it out unless the screen needs it.
- **Symptom: the component misbehaves on the mobile app.** Cause: `lightning/graphql` does not support Mobile Offline. Fix: use another approach for offline scenarios.

## Key takeaways

- The GraphQL wire adapter reads exactly the records and fields you ask for, with filters, sorting and cursor pagination, as the signed-in user.
- Field values come back as objects with `value`. The handler receives `data` and `errors`.
- Use a getter for variables, use `first` and `after` for paging, and reset the cursor when filters change.
- `executeMutation` updates records imperatively. Check `errors`, patch the local row, and refresh once after creates.
- Keep the data handling in plain functions so you can test it in Node.

## Where to go next

- [LWC forms and UI API](/articles/lwc-forms-and-ui-api/)
- [LWC lifecycle and wire](/articles/lwc-lifecycle-and-wire/)
- [LWC state managers: share reactive state](/articles/lwc-state-managers-share-reactive-state/)
- [LWC Jest unit testing](/articles/lwc-jest-unit-testing/)
- [Apex security and user mode](/articles/apex-security-and-user-mode/)
