---
title: "LWC State Managers: Share Reactive State with defineState and fromContext"
description: "Replace prop drilling and event chains with an LWC state manager: atoms, computed values, actions, fromContext sharing, async loading, and tests that run in Node."
category: react-and-salesforce
tags: [LWC, State Management, defineState, Reactivity, Frontend]
publishedAt: 2026-11-27
updatedAt: 2026-11-27
cover: /images/covers/lwc-state-managers-share-reactive-state.jpg
sources:
  - title: "Lightning Web Components Guide: Manage State Across LWC Components with State Managers"
    url: "https://developer.salesforce.com/docs/platform/lwc/guide/state-management.html"
  - title: "Lightning Web Components Guide: Share a State Manager Across Components"
    url: "https://developer.salesforce.com/docs/platform/lwc/guide/state-management-example-fromcontext.html"
  - title: "Lightning Web Components Guide: Use lightning/stateManager* State Managers"
    url: "https://developer.salesforce.com/docs/platform/lwc/guide/reference-state-managers-use.html"
  - title: "Salesforce Developers Blog: LWC State Managers, Share Reactive State Across Components"
    url: "https://developer.salesforce.com/blogs/2026/07/lwc-state-managers-share-reactive-state-across-components"
---

A Lightning web component page often grows from one component into a family: a filter, a list, a summary, a detail panel. They all need the same data. The old answer is to keep the data in the top component, pass it down with `@api` properties, and send events back up. With two levels that is fine. With five levels you are passing values through components that do not use them, and every change has to travel up and down the tree.

An **LWC state manager** is a small JavaScript module that holds a set of related state and the functions that change it. Components read from it and call its actions, and the platform re-renders whatever read a value that changed. This article builds a loan workbench with one state manager shared by four components, loads data with an async action, and tests the manager with the real `@lwc/state` package in plain Node. For the basics of components and wires, read [LWC lifecycle and wire](/articles/lwc-lifecycle-and-wire/); for events between components see [LWC communication and data patterns](/articles/lwc-communication-and-data-patterns/).

## The business scenario

Crestline Lending (a fictional lender) wants a loan workbench page. A slider sets the minimum risk score. A summary shows how many loans pass the filter and their total amount. A list shows the loans, and clicking one shows its detail. Four components need the same three things: the loans, the filter, and the selection. Today the page passes them through the parent with properties and events, and a change of the filter is a chain of three events. The goal is one place that owns the state, with derived values (the visible loans, the total, the selected loan) calculated once and kept consistent.

## Before you start: setup

### In Salesforce

1. Use a Developer Edition org, sandbox or scratch org on Winter '27 (API 68.0). Salesforce's July 2026 developer blog announces state managers as generally available since Summer '26. Some documentation pages may still carry a Beta label, so check the current guide for your org. Verify: you can deploy a Lightning web component with `sf project deploy start`.
2. Create the custom object `Loan__c` with a currency field `Amount__c` and a number field `Risk_Score__c`. Verify: you can create a record in the UI.
3. Create five sample loans with scores between 40 and 95. Verify: `SELECT Name, Amount__c, Risk_Score__c FROM Loan__c` returns five rows.
4. Give your user read access to the object and its fields (see [permission sets vs profiles](/articles/permission-sets-vs-profiles/)). Verify: you can open a Loan record as that user.
5. Know the limit: Salesforce's overview page says state management is not currently available in Experience Cloud. This page targets Lightning Experience. Verify: you plan to place the component on a Lightning app, record or home page.

### On your computer

6. Install Node 22 LTS or newer. Verify: `node --version` prints v22 or higher.
7. In your Salesforce DX project folder run `npm install --save-dev @lwc/state lwc jsdom`. These packages are only for running tests locally: on the platform the `@lwc/state` module is provided, so do not deploy `node_modules`. The tests in this article ran against `@lwc/state` 0.36.0. Verify: `npm ls @lwc/state` shows the package.
8. Create a folder `tools/` and save the three files shown in this article as `setup-dom.mjs`, `loanWorkbenchState.mjs` and `loanWorkbenchState.test.mjs`. Verify: `node --test tools/loanWorkbenchState.test.mjs` passes.

## How it works

You define a state manager with `defineState`, imported from `@lwc/state`. You pass it one function (the definition). Its first parameter gives you three tools, and any further parameters configure each instance, with normal JavaScript defaults.

- **`atom(initialValue)`** creates a reactive value. It can wrap any JavaScript value, but Salesforce recommends JSON-serializable values or `undefined` for best compatibility.
- **`computed([a, b], fn)`** creates a derived value. The function receives the current values of the listed dependencies, in order, and returns the result. It recalculates when a dependency changes, not before.
- **`setAtom(atom, newValue)`** changes an atom and tells LWC's reactivity system. It is the only supported way to change an atom, and only inside the manager that created the atom.
- **Actions** are plain functions that call `setAtom`. They can be synchronous or asynchronous. Salesforce describes them as the only way consumers can change the manager's internal state, so think of them as its public methods.

The definition function **returns** an object with what you want to expose (atoms, computed values, actions). A component creates an instance by calling the manager, for example `state = loanWorkbenchState(0);`, and reads it through `.value`: `state.value.visible` in a template, `this.state.value.select(id)` in JavaScript.

To **share** one instance, the parent component creates it as a class field. A descendant gets the same instance by declaring `state = fromContext(loanWorkbenchState);`, where `fromContext` also comes from `@lwc/state`. The descendant looks for the closest instance of that definition, starting with itself and moving up the component hierarchy, so no property or event is needed. Two rules from Salesforce's guide: the provider must create its instance during construction and must not replace it after the component is connected, and a consumer does not have its reference until it is connected, so it must not read the state in its constructor.

When a state manager is **not** a good fit: a single parent with one or two children is served well by `@api` properties and events, and Salesforce's comparison page recommends state managers when an app has grown large and complex. If unrelated components that are not in one tree must share state, the same page notes that a singleton exported from a shared module gives every importing component the same instance.

Salesforce also ships **built-in state managers** for record, object info, layout and related list data, such as `lightning/stateManagerRecord` and `lightning/stateManagerObjectInfo`. Each default export is a factory, and each manager has `status` (`unconfigured`, `loading`, `loaded` or `error`), `data` and `error`. For simple needs the wire service is still recommended; the custom manager below copies the same `status` and `error` shape, which makes it feel familiar.

## Basic example

First the state manager itself, written once and used everywhere. This is the whole module: atoms for the raw state, computed values for what is derived, and actions as the only way to change anything.

```javascript
// loanWorkbenchState.js: one state manager for the whole loan workbench.
import { defineState } from '@lwc/state';

export const loanWorkbenchState = defineState(({ atom, computed, setAtom }, initialMinScore = 0) => {
  // Raw state: only actions below may change these atoms.
  const status = atom('unconfigured'); // unconfigured | loading | loaded | error
  const error = atom(undefined);
  const loans = atom([]);
  const minScore = atom(initialMinScore);
  const selectedId = atom(undefined);

  // Derived state: recalculated only when its inputs change.
  const visible = computed([loans, minScore], (all, min) => all.filter(loan => loan.score >= min));
  const totalAmount = computed([visible], list => list.reduce((sum, loan) => sum + loan.amount, 0));
  const selected = computed([visible, selectedId], (list, id) => list.find(loan => loan.id === id));

  // Actions: the only public way to change state.
  const setMinScore = value => setAtom(minScore, Number(value) || 0);
  const select = id => setAtom(selectedId, id);

  let latestRequest = 0;
  const loadLoans = async fetcher => {
    latestRequest += 1;
    const mine = latestRequest;
    setAtom(status, 'loading');
    setAtom(error, undefined);
    try {
      const result = await fetcher();
      if (mine !== latestRequest) {
        return; // a newer request started while this one was running: ignore this answer
      }
      setAtom(loans, result);
      setAtom(status, 'loaded');
    } catch (e) {
      if (mine !== latestRequest) {
        return;
      }
      setAtom(error, e && e.message ? e.message : String(e));
      setAtom(status, 'error');
    }
  };

  return { status, error, loans, minScore, selectedId, visible, totalAmount, selected, setMinScore, select, loadLoans };
});
```

Three details deserve a second look. The filter action uses `Number(value) || 0`, so a non-numeric value from an input cannot break the list. The `loadLoans` action receives the fetching function as an argument, which keeps the manager free of Salesforce imports and easy to test. And `latestRequest` guards against a classic bug: if the user triggers two loads, a slow first answer must not overwrite the second.

To run it in plain Node, the package needs a browser-like environment, because it loads the LWC engine. This small helper provides one with `jsdom`. (In a Jest project with the jsdom environment you do not need it.)

```javascript
// Minimal DOM for @lwc/state under plain Node (the package loads the LWC engine, which expects a browser).
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
for (const key of Object.getOwnPropertyNames(window)) {
  if (!(key in globalThis)) {
    try {
      globalThis[key] = window[key];
    } catch {
      // some window properties are getters that throw; skip them
    }
  }
}
```

Now the tests, which exercise the real `@lwc/state` package.

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './setup-dom.mjs'; // only needed under plain Node; Jest with the jsdom environment does this for you

const { loanWorkbenchState } = await import('./loanWorkbenchState.mjs');
const { defineState } = await import('@lwc/state');

const LOANS = [
  { id: 'L1', name: 'Harbor Bakery', amount: 120000, score: 82 },
  { id: 'L2', name: 'Pine Logistics', amount: 450000, score: 55 },
  { id: 'L3', name: 'Cedar Dental', amount: 80000, score: 91 },
];

async function loaded(minScore) {
  const manager = loanWorkbenchState(minScore);
  await manager.value.loadLoans(async () => LOANS);
  return manager;
}

test('a new manager starts empty and unconfigured', () => {
  const manager = loanWorkbenchState();
  assert.equal(manager.value.status, 'unconfigured');
  assert.deepEqual(manager.value.visible, []);
  assert.equal(manager.value.totalAmount, 0);
});

test('loading fills the state and sets the status', async () => {
  const manager = await loaded();
  assert.equal(manager.value.status, 'loaded');
  assert.equal(manager.value.visible.length, 3);
  assert.equal(manager.value.totalAmount, 650000);
});

test('the filter recalculates the derived values', async () => {
  const manager = await loaded();
  manager.value.setMinScore('80');
  assert.deepEqual(manager.value.visible.map(l => l.id), ['L1', 'L3']);
  assert.equal(manager.value.totalAmount, 200000);
  manager.value.setMinScore('not a number');
  assert.equal(manager.value.visible.length, 3);
});

test('selection follows the visible list', async () => {
  const manager = await loaded();
  manager.value.select('L2');
  assert.equal(manager.value.selected.name, 'Pine Logistics');
  manager.value.setMinScore(80); // L2 is now filtered out
  assert.equal(manager.value.selected, undefined);
});

test('each instance has its own state', async () => {
  const first = await loaded();
  const second = loanWorkbenchState();
  first.value.setMinScore(90);
  assert.equal(second.value.minScore, 0);
  assert.equal(first.value.minScore, 90);
});

test('consumers cannot assign state directly', async () => {
  const manager = await loaded();
  assert.throws(() => {
    manager.value.minScore = 99;
  }, TypeError);
  assert.equal(manager.value.minScore, 0);
});

test('a failed load sets the error and status', async () => {
  const manager = loanWorkbenchState();
  await manager.value.loadLoans(async () => {
    throw new Error('Server unavailable');
  });
  assert.equal(manager.value.status, 'error');
  assert.equal(manager.value.error, 'Server unavailable');
});

test('a slow old response cannot overwrite a newer one', async () => {
  const manager = loanWorkbenchState();
  let releaseSlow;
  const slow = manager.value.loadLoans(() => new Promise(resolve => {
    releaseSlow = () => resolve([{ id: 'OLD', name: 'Old', amount: 1, score: 1 }]);
  }));
  await manager.value.loadLoans(async () => LOANS); // newer request finishes first
  releaseSlow();
  await slow;
  assert.equal(manager.value.visible.length, 3);
  assert.equal(manager.value.status, 'loaded');
});

test('a computed value is cached until its dependency changes', () => {
  let runs = 0;
  const counter = defineState(({ atom, computed, setAtom }) => {
    const n = atom(1);
    const plusOne = computed([n], value => {
      runs += 1;
      return value + 1;
    });
    return { plusOne, set: value => setAtom(n, value) };
  })();
  assert.equal(counter.value.plusOne, 2);
  assert.equal(counter.value.plusOne, 2);
  assert.equal(runs, 1); // second read came from the cache
  counter.value.set(5);
  assert.equal(counter.value.plusOne, 6);
  assert.equal(runs, 2);
});
```

Run `node --test tools/loanWorkbenchState.test.mjs`. Expected: 9 tests pass. The tests show the points that matter: derived values follow the filter, the selection disappears when its loan is filtered out, instances do not share state, direct assignment is rejected, a slow stale response is ignored, and computed values are cached.

## Advanced end-to-end example

### 1. Save the state manager as a module component

In a Salesforce DX project, a state manager is a JavaScript module inside an LWC bundle with no template. Create `force-app/main/default/lwc/loanWorkbenchState/loanWorkbenchState.js` with the same code as the `.mjs` file above, and this metadata file next to it as `loanWorkbenchState.js-meta.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>68.0</apiVersion>
    <isExposed>false</isExposed>
</LightningComponentBundle>
```

Other components import it as `c/loanWorkbenchState`. The `isExposed` value is `false` because it is internal and not for the App Builder.

### 2. The Apex that supplies the loans

```apex
public with sharing class LoanWorkbenchController {
    public class LoanDto {
        @AuraEnabled public Id id;
        @AuraEnabled public String name;
        @AuraEnabled public Decimal amount;
        @AuraEnabled public Decimal score;
    }

    @AuraEnabled(cacheable=true)
    public static List<LoanDto> getLoans() {
        List<LoanDto> result = new List<LoanDto>();
        for (Loan__c loan : [
            SELECT Id, Name, Amount__c, Risk_Score__c
            FROM Loan__c
            WITH USER_MODE
            ORDER BY Name
            LIMIT 200
        ]) {
            LoanDto dto = new LoanDto();
            dto.id = loan.Id;
            dto.name = loan.Name;
            dto.amount = loan.Amount__c;
            dto.score = loan.Risk_Score__c;
            result.add(dto);
        }
        return result;
    }
}
```

The query runs `WITH USER_MODE`, so the loans a user sees respect their field and record access. If you have not read it yet, [Apex security and user mode](/articles/apex-security-and-user-mode/) explains why.

### 3. The provider component

The provider creates the single instance and starts the load. Its template shows a spinner, an error or the child components.

```html
<!-- loanWorkbench.html (the provider) -->
<template>
    <lightning-card title="Loan workbench" icon-name="standard:opportunity">
        <div class="slds-p-horizontal_medium">
            <template lwc:if={isLoading}>
                <lightning-spinner alternative-text="Loading loans" size="small"></lightning-spinner>
            </template>
            <template lwc:elseif={hasError}>
                <p class="slds-text-color_error">{state.value.error}</p>
            </template>
            <template lwc:else>
                <c-loan-filter></c-loan-filter>
                <c-loan-summary></c-loan-summary>
                <div class="slds-grid slds-gutters slds-m-top_small">
                    <div class="slds-col"><c-loan-list></c-loan-list></div>
                    <div class="slds-col"><c-loan-detail></c-loan-detail></div>
                </div>
            </template>
        </div>
    </lightning-card>
</template>
```

```javascript
// loanWorkbench.js
import { LightningElement } from 'lwc';
import { loanWorkbenchState } from 'c/loanWorkbenchState';
import getLoans from '@salesforce/apex/LoanWorkbenchController.getLoans';

export default class LoanWorkbench extends LightningElement {
    // Created while the component is constructed, before it is connected, and never replaced.
    state = loanWorkbenchState(0);

    connectedCallback() {
        this.state.value.loadLoans(() => getLoans());
    }

    get isLoading() {
        return this.state.value.status === 'loading';
    }

    get hasError() {
        return this.state.value.status === 'error';
    }
}
```

Notice that the provider does not pass anything to its children. There is no `@api` property and no event listener.

### 4. The consumers

Each consumer declares one line, `state = fromContext(loanWorkbenchState);`, and uses the state in its template or handlers.

```html
<!-- loanFilter.html -->
<template>
    <lightning-slider
        label="Minimum risk score"
        min="0"
        max="100"
        value={state.value.minScore}
        onchange={handleChange}
    ></lightning-slider>
</template>

// loanFilter.js
import { LightningElement } from 'lwc';
import { fromContext } from '@lwc/state';
import { loanWorkbenchState } from 'c/loanWorkbenchState';

export default class LoanFilter extends LightningElement {
    // Finds the closest ancestor instance. It is available once the component is connected,
    // so read it in handlers and getters, not in the constructor.
    state = fromContext(loanWorkbenchState);

    handleChange(event) {
        this.state.value.setMinScore(event.detail.value);
    }
}
```

```html
<!-- loanSummary.html -->
<template>
    <p class="slds-m-top_small">
        {state.value.visible.length} loans, total
        <lightning-formatted-number
            value={state.value.totalAmount}
            format-style="currency"
            currency-code="USD"
        ></lightning-formatted-number>
    </p>
</template>

// loanSummary.js
import { LightningElement } from 'lwc';
import { fromContext } from '@lwc/state';
import { loanWorkbenchState } from 'c/loanWorkbenchState';

export default class LoanSummary extends LightningElement {
    state = fromContext(loanWorkbenchState);
}
```

```html
<!-- loanList.html -->
<template>
    <ul class="slds-has-dividers_bottom-space">
        <template for:each={state.value.visible} for:item="loan">
            <li key={loan.id} class="slds-item">
                <a data-id={loan.id} onclick={handleSelect}>{loan.name} (score {loan.score})</a>
            </li>
        </template>
    </ul>
</template>

// loanList.js
import { LightningElement } from 'lwc';
import { fromContext } from '@lwc/state';
import { loanWorkbenchState } from 'c/loanWorkbenchState';

export default class LoanList extends LightningElement {
    state = fromContext(loanWorkbenchState);

    handleSelect(event) {
        this.state.value.select(event.currentTarget.dataset.id);
    }
}
```

```html
<!-- loanDetail.html -->
<template>
    <template lwc:if={state.value.selected}>
        <h3 class="slds-text-heading_small">{state.value.selected.name}</h3>
        <p>Amount: {state.value.selected.amount}</p>
        <p>Risk score: {state.value.selected.score}</p>
    </template>
    <template lwc:else>
        <p>Select a loan to see its details.</p>
    </template>
</template>

// loanDetail.js
import { LightningElement } from 'lwc';
import { fromContext } from '@lwc/state';
import { loanWorkbenchState } from 'c/loanWorkbenchState';

export default class LoanDetail extends LightningElement {
    state = fromContext(loanWorkbenchState);
}
```

### 5. A test for the Apex

```apex
@IsTest
private class LoanWorkbenchControllerTest {
    @IsTest
    static void returnsLoansAsDtos() {
        insert new Loan__c(Name = 'Harbor Bakery', Amount__c = 120000, Risk_Score__c = 82);
        List<LoanWorkbenchController.LoanDto> loans = LoanWorkbenchController.getLoans();
        System.assertEquals(1, loans.size());
        System.assertEquals('Harbor Bakery', loans[0].name);
        System.assertEquals(82, loans[0].score);
    }
}
```

The components and Apex above are syntax-checked, not run here. The state manager is what the Node tests exercise. To test the components themselves, use Jest as described in [LWC Jest unit testing](/articles/lwc-jest-unit-testing/).

## What happens behind the scenes

1. When `loanWorkbench` is constructed, the class field calls `loanWorkbenchState(0)`. The definition function runs once for this instance: it creates the atoms and computed values and returns the exposed object. The instance wraps it, and `.value` gives access.
2. While the template renders, reading `state.value.visible` registers the component as a subscriber of that value. Reading a computed value also subscribes to the atoms it depends on.
3. `connectedCallback` calls `loadLoans`. The action sets the status atom to `loading`, awaits the Apex call, then sets the loans and the status. Each `setAtom` marks dependents as stale. The package README says updates are batched in a microtask, and the July 2026 blog says several `setAtom` calls in the same tick give one notification cycle, so the page re-renders once, not once per atom.
4. Computed values are lazy. `visible` is not recalculated until something reads it after a dependency changed. The last test in the Node file confirms it against the real package: reading a computed value twice runs its function once, and changing its dependency makes the next read run it again.
5. Each child component's `fromContext` call looks up the component tree for the closest instance of `loanWorkbenchState`. All four children find the provider's instance, so they read and change the same atoms.
6. When the slider changes, `LoanFilter` calls `setMinScore`. The atom changes, `visible`, `totalAmount` and `selected` become stale, and only the components that read them re-render.

## Common mistakes and fixes

- **Symptom: a child cannot find the state, or reads `undefined` in the constructor.** Cause: the consumer's reference arrives when the component is connected. Fix: read the state in `connectedCallback`, getters and event handlers only.
- **Symptom: undefined behavior after the provider replaces its state.** Cause: the provider assigned a new instance after it was connected. Fix: create the instance once in the class field and never replace it.
- **Symptom: changing a value from a component does nothing, or throws.** Cause: the component tried to assign to `state.value.minScore`. Fix: add an action to the manager and call it. In the Node test the assignment throws a `TypeError`.
- **Symptom: `ReferenceError` in a sandbox, silent failure in production.** Cause: `setAtom` was used on an atom that belongs to a different manager. The package README documents this behavior. Fix: keep every `setAtom` inside the manager that created the atom.
- **Symptom: a list flickers with old data after a fast second load.** Cause: a slow first response finished last. Fix: ignore stale responses with a request counter, as `loadLoans` does.
- **Symptom: the manager breaks in tests or on the server.** Cause: it touches `document` or `window`. Fix: keep DOM work in components. Salesforce's guide says state managers must not rely on DOM-specific APIs.
- **Symptom: it does not work on an Experience Cloud site.** Cause: Salesforce's overview page says state management is not currently available there. Fix: use properties and events on sites until that changes.
- **Symptom: a complicated object is stored in an atom and behaves strangely.** Cause: Salesforce recommends JSON-serializable values or `undefined`. Fix: store plain data, and compute helper objects in `computed`.

## Key takeaways

- A state manager is one module holding state (atoms), derived values (computed) and actions, defined with `defineState` from `@lwc/state`.
- Components read through `.value` and change state only through actions that call `setAtom`.
- The provider creates the instance as a class field. Descendants call `fromContext(definition)` and need no properties or events.
- Computed values are cached and recalculate only when their dependencies change, and updates are batched.
- Keep the manager free of Salesforce and DOM imports, so you can test it in plain Node or Jest.
- Use it when sharing data has become awkward. For simple parent and child pairs, properties and events are enough.

## Where to go next

- [LWC lifecycle and wire](/articles/lwc-lifecycle-and-wire/)
- [LWC communication and data patterns](/articles/lwc-communication-and-data-patterns/)
- [LWC Jest unit testing](/articles/lwc-jest-unit-testing/)
- [LWC complex template expressions and lwc:external](/articles/lwc-complex-template-expressions-and-lwc-external/)
- [React state and reducers](/articles/react-state-and-reducers/)
