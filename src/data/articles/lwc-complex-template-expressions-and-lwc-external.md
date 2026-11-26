---
title: "LWC Complex Template Expressions and lwc:external Web Components"
description: "Write JavaScript expressions directly in LWC templates and embed third-party web components with lwc:external, with a template linter, Jest tests and pitfalls."
category: react-and-salesforce
tags: [LWC, Templates, Web Components, Lightning Web Security, Frontend]
publishedAt: 2026-11-26
updatedAt: 2026-11-26
cover: /images/covers/lwc-complex-template-expressions-and-lwc-external.jpg
sources:
  - title: "Lightning Web Components Guide: Template Expressions"
    url: "https://developer.salesforce.com/docs/platform/lwc/guide/create-components-html-expressions.html"
  - title: "Lightning Web Components Guide: Use Third-Party Web Components"
    url: "https://developer.salesforce.com/docs/platform/lwc/guide/create-use-third-party-components.html"
  - title: "The Salesforce Developer's Guide to the Winter '27 Release"
    url: "https://developer.salesforce.com/blogs/2026/10/developers-guide-to-the-winter-27-release"
---

For years, a Lightning web component template could only show a property or a getter. If you wanted "Open" or "Closed" based on a boolean, you wrote a getter in JavaScript, even for a one-line decision. **Complex template expressions** change that: a template can now contain a JavaScript expression such as a ternary, a template literal or an optional chain. In Winter '27 this is generally available, together with **`lwc:external`**, which renders third-party web components inside an LWC.

This article shows both. It builds a loan card with expressions, a tested linter that catches the constructs the platform rejects, a third-party web component loaded from a static resource, and Jest tests for the component. If you are new to LWC, read [LWC lifecycle and wire](/articles/lwc-lifecycle-and-wire/) first.

## The business scenario

Crestline Lending (a fictional lender) has a loan card that shows a status label, a risk badge, a formatted title and a star rating. Today it has eleven getters like `get statusLabel()`, `get isHighRisk()` and `get titleText()`. The team wants to remove the trivial getters, keep real logic in JavaScript, and drop in a vendor-supplied `<rating-stars>` web component rather than rewrite it.

## Before you start: setup

### In Salesforce

1. Use a Developer sandbox or scratch org on Winter '27 (API 68.0). Complex expressions need API version 66.0 or higher in the component's meta file. Verify: the component's `.js-meta.xml` has `<apiVersion>68.0</apiVersion>`.
2. Enable **Lightning Web Security** if it is not already on (Setup, Session Settings). `lwc:external` requires it. Verify: the Session Settings page shows Lightning Web Security enabled.
3. Create a DX project and deploy the component below with `sf project deploy start`. Verify: the component shows in the Lightning App Builder component list.
4. Create a custom object `Loan__c` with `Name`, `Amount__c` (Currency), `Score__c` (Number 3,0) and `Status__c` (Text 20) to supply data. Verify: a sample record exists.

### In the external system (the web component)

5. For `lwc:external`, obtain the third-party component bundled as an **IIFE or UMD** file. ES module files do not work with `loadScript`. Verify: the file defines a custom element when loaded in a plain HTML page.
6. Upload it as a static resource named `ratingStars` (Setup, Static Resources, or a `.resource` file in your project). One static resource can be up to 5 MB. Verify: it is listed with the right content type.

### On your computer

7. Install the LWC Jest tooling in your project (`npm install --save-dev @salesforce/sfdx-lwc-jest`) and Node 22. Verify: `npx sfdx-lwc-jest --version` prints a version.

## How it works

**Complex expressions.** A template expression is anything inside `{ }`. The compiler accepts a JavaScript expression subset: template literals, ternaries, logical operators, function calls on values in scope, array expressions, optional chaining and nullish coalescing. These are rejected: `this`, `new`, and function declarations. When you use an expression in an attribute, wrap it in double quotes, as in `label="{score > 70 ? 'High' : 'Low'}"`. Keep expressions short: if you would hesitate to read it in a code review, move it to JavaScript.

**`lwc:external`.** Add the `lwc:external` directive to a custom element in your template and the framework renders it natively, without the LWC wrapper. The element is registered with `customElements.define` by the third-party script, which you load with `loadScript` from `lightning/platformResourceLoader`. Data is passed as attributes by default, and as properties only if the element already defines them.

## Basic example

A card with complex expressions only. No getters.

```html
<!-- loanCard.html -->
<template>
  <lightning-card title="{`Loan ${loan.name} (${loan.status ?? 'Draft'})`}">
    <div class="slds-p-around_medium">
      <p>{loan.amount ? `$${loan.amount}` : 'No amount yet'}</p>
      <p class="{loan.score >= 70 ? 'badge badge-ok' : 'badge badge-risk'}">
        {loan.score >= 70 ? 'Low risk' : 'Needs review'}
      </p>
      <p>{[loan.city, loan.state].filter(Boolean).join(', ')}</p>
      <p>{loan.owner?.name ?? 'Unassigned'}</p>
    </div>
  </lightning-card>
</template>
```

```javascript
// loanCard.js
import { LightningElement, api } from 'lwc';

export default class LoanCard extends LightningElement {
  @api loan = {
    name: 'L-1001',
    status: 'Open',
    amount: 250000,
    score: 82,
    city: 'Austin',
    state: 'TX',
    owner: { name: 'Priya' }
  };
}
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>68.0</apiVersion>
    <isExposed>true</isExposed>
    <masterLabel>Loan Card</masterLabel>
    <targets>
        <target>lightning__RecordPage</target>
        <target>lightning__AppPage</target>
    </targets>
</LightningComponentBundle>
```

Notice what disappeared: five getters. Keep a getter when the logic is non-trivial, shared in several places or needs a unit test of its own.

## Advanced end-to-end example

### 1. A list with expressions and a third-party component

```html
<!-- loanList.html -->
<template>
  <lightning-card title="Loans">
    <template lwc:if={loans.length}>
      <ul class="slds-p-around_medium">
        <template for:each={loans} for:item="loan">
          <li key={loan.id}>
            <span>{`${loan.name}: ${loan.amount ? '$' + loan.amount : 'n/a'}`}</span>
            <rating-stars lwc:external value={loan.score} max="100"></rating-stars>
          </li>
        </template>
      </ul>
    </template>
    <template lwc:else>
      <p class="slds-p-around_medium">No loans match the filter.</p>
    </template>
  </lightning-card>
</template>
```

```javascript
// loanList.js
import { LightningElement, api } from 'lwc';
import { loadScript } from 'lightning/platformResourceLoader';
import ratingStars from '@salesforce/resourceUrl/ratingStars';

export default class LoanList extends LightningElement {
  @api loans = [];
  scriptLoaded = false;
  error;

  async renderedCallback() {
    if (this.scriptLoaded) {
      return;
    }
    this.scriptLoaded = true;
    try {
      await loadScript(this, ratingStars);
    } catch (e) {
      this.error = e;
    }
  }
}
```

The `scriptLoaded` guard matters: `renderedCallback` runs after every render, and loading the script twice would try to register the same custom element again.

### 2. The third-party component (a stand-in for the vendor file)

This file is an IIFE that registers `rating-stars`. A real vendor file would be bundled the same way. Save it as the static resource `ratingStars`.

```javascript
// ratingStars.js  (static resource, IIFE format)
(function () {
  class RatingStars extends HTMLElement {
    static get observedAttributes() {
      return ['value', 'max'];
    }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
      this.render();
    }

    attributeChangedCallback() {
      this.render();
    }

    render() {
      const value = Number(this.getAttribute('value') || 0);
      const max = Number(this.getAttribute('max') || 100);
      const stars = Math.max(0, Math.min(5, Math.round((value / max) * 5)));
      this.shadowRoot.innerHTML = '<span aria-label="' + stars + ' of 5">'
        + '★'.repeat(stars) + '☆'.repeat(5 - stars) + '</span>';
    }
  }

  if (!customElements.get('rating-stars')) {
    customElements.define('rating-stars', RatingStars);
  }
})();
```

The component reads attributes, so LWC's default of setting attributes works. If a vendor element exposes properties instead, define them on the class and LWC will set properties. For a custom event with uppercase or hyphens in its name, attach the listener in JavaScript with `addEventListener` rather than in the template.

### 3. The linter

The platform will reject some expressions at compile time, but a linter in your pre-commit check gives faster feedback and teaches the rules. This one finds every `{...}` expression, flags `this`, `new` and function declarations, and warns about complex attribute expressions that are not in double quotes.

```javascript
// A small linter for LWC templates that use complex expressions.
// It flags constructs the platform rejects: `this`, `new` and function declarations inside {...}.

export function findExpressions(html) {
  const found = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] !== '{') {
      i += 1;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    let quote = null;
    while (j < html.length && depth > 0) {
      const c = html[j];
      if (quote) {
        if (c === '\\') {
          j += 1;
        } else if (c === quote) {
          quote = null;
        }
      } else if (c === '"' || c === "'" || c === '`') {
        quote = c;
      } else if (c === '{') {
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
      }
      j += 1;
    }
    const line = html.slice(0, i).split('\n').length;
    found.push({ text: html.slice(i + 1, j - 1), line });
    i = j;
  }
  return found;
}

function stripStrings(code) {
  return code.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
}

export function lintExpression(text) {
  const problems = [];
  const code = stripStrings(text);
  if (/\bthis\b/.test(code)) {
    problems.push('Do not use `this` in a template expression; use the property name.');
  }
  if (/\bnew\s+[A-Za-z_$]/.test(code)) {
    problems.push('Do not use `new` in a template expression; compute the value in JavaScript.');
  }
  if (/\bfunction\b/.test(code)) {
    problems.push('Function declarations are not allowed in a template expression.');
  }
  return problems;
}

export function lintTemplate(html) {
  const issues = [];
  for (const expr of findExpressions(html)) {
    for (const message of lintExpression(expr.text)) {
      issues.push({ line: expr.line, expression: expr.text.trim(), message });
    }
  }
  return issues;
}

// Attribute expressions in the complex form should be wrapped in double quotes: attr="{a ? b : c}".
export function findUnquotedComplexAttributes(html) {
  const hits = [];
  const re = /\s([a-z][\w:-]*)=\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/[?:&|!+\-*/<>(\[]|\?\./.test(m[2]) && !/^\s*[\w.]+\s*$/.test(m[2])) {
      hits.push({ attribute: m[1], expression: m[2].trim() });
    }
  }
  return hits;
}
```

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExpressions, findUnquotedComplexAttributes, lintExpression, lintTemplate } from './templateLint.mjs';

test('finds simple and nested expressions with line numbers', () => {
  const html = '<p>{name}</p>\n<p>{`Hi ${first}`}</p>';
  const found = findExpressions(html);
  assert.equal(found.length, 2);
  assert.equal(found[0].text, 'name');
  assert.equal(found[1].line, 2);
  assert.equal(found[1].text, '`Hi ${first}`');
});

test('accepts ternaries, optional chaining and nullish coalescing', () => {
  assert.deepEqual(lintExpression("isOpen ? 'Open' : 'Closed'"), []);
  assert.deepEqual(lintExpression("user?.profile?.theme ?? 'default'"), []);
  assert.deepEqual(lintExpression("[first, last].join(' ')"), []);
});

test('rejects this, new and function declarations', () => {
  assert.equal(lintExpression('this.name').length, 1);
  assert.equal(lintExpression('new Date()').length, 1);
  assert.equal(lintExpression('function f() { return 1; }').length, 1);
});

test('words inside strings do not trigger rules', () => {
  assert.deepEqual(lintExpression("'this is new'"), []);
});

test('a template report lists line, expression and reason', () => {
  const issues = lintTemplate('<div>\n  {this.title}\n</div>');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 2);
  assert.match(issues[0].message, /this/);
});

test('flags complex attribute expressions that are not in double quotes', () => {
  const bad = findUnquotedComplexAttributes('<c-badge label={score > 70 ? "High" : "Low"}></c-badge>');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].attribute, 'label');
  const good = findUnquotedComplexAttributes('<c-badge label="{score > 70 ? \'High\' : \'Low\'}" other={plain}></c-badge>');
  assert.equal(good.length, 0);
});
```

Run `node --test tools/templateLint.test.mjs`. Expected: 6 pass.

### 4. Jest tests for the card

```javascript
// __tests__/loanCard.test.js
import { createElement } from 'lwc';
import LoanCard from 'c/loanCard';

function mount(loan) {
  const element = createElement('c-loan-card', { is: LoanCard });
  element.loan = loan;
  document.body.appendChild(element);
  return element;
}

describe('c-loan-card', () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  it('shows a low risk label for a high score', async () => {
    const el = mount({ name: 'L-1', status: 'Open', amount: 100, score: 90 });
    await Promise.resolve();
    expect(el.shadowRoot.textContent).toContain('Low risk');
  });

  it('shows needs review for a low score', async () => {
    const el = mount({ name: 'L-2', status: 'Open', amount: 100, score: 40 });
    await Promise.resolve();
    expect(el.shadowRoot.textContent).toContain('Needs review');
  });

  it('falls back when optional values are missing', async () => {
    const el = mount({ name: 'L-3', score: 70 });
    await Promise.resolve();
    const text = el.shadowRoot.textContent;
    expect(text).toContain('No amount yet');
    expect(text).toContain('Unassigned');
  });
});
```

Tests run in a simulated DOM. Whether the Jest transformer in your installed version supports every expression form depends on the version of the LWC compiler it bundles, so update `@salesforce/sfdx-lwc-jest` to a release that matches your API version.

## What happens behind the scenes

1. At deploy time, the LWC compiler parses each template. Expressions in `{ }` are parsed as JavaScript expressions against a restricted grammar, which is why `this`, `new` and function declarations fail the build.
2. At runtime, each expression is evaluated against the component's public properties and fields whenever the component re-renders. Reactive tracking works as before: changing a field that an expression reads schedules a re-render.
3. `loadScript` fetches the static resource through the platform, runs it under Lightning Web Security, and the script calls `customElements.define`.
4. For an element with `lwc:external`, the framework creates a native custom element instead of an LWC component. It sets attributes from your template, sets a property only when the element defines one, and keeps the element inside the page's shadow DOM tree.
5. Events fired by the external element bubble as normal DOM events. Lowercase names can be bound in the template; others need `addEventListener`.

## Limits worth knowing

- Third-party components must be pre-bundled as IIFE or UMD. `loadScript` does not support ES modules, npm packages that need bundling, or compilation steps.
- Code in the external component cannot reach the global `document` through the shadow boundary. Use refs or the shadow root.
- Dynamic component creation is not supported with `lwc:external`, and slotting is not supported under synthetic shadow.
- Experience Builder sites did not support third-party web components with Lightning Web Security at the time of the documentation I read; check the current page if you build for a site.
- Salesforce does not provide support for third-party web components themselves.

## Test it and verify

1. Run `node --test tools/templateLint.test.mjs`. Expected: 6 pass. Then lint your own template: pass its text to `lintTemplate`.
2. Run the Jest tests: `npx sfdx-lwc-jest -- --testPathPattern loanCard`. Expected: 3 pass.
3. Deploy: `sf project deploy start --source-dir force-app/main/default/lwc --target-org dev`. Expected: success with no template compile errors.
4. Add the card and the list to a Lightning page. Expected: labels change with the data, and the list shows a row of stars from the third-party element.
5. Temporarily change an expression to `{this.loan.name}`. Expected: the deploy fails with a clear message, which proves the linter rule matches the platform.

## Common mistakes and fixes

- **Symptom: deploy fails with an error about `this`.** Cause: `this.` used inside `{ }`. Fix: refer to the property directly, as in `{loan.name}`.
- **Symptom: `new Date()` in a template fails.** Cause: `new` is not allowed. Fix: compute the date in JavaScript and expose a field.
- **Symptom: an attribute expression is ignored or errors.** Cause: it is not wrapped in double quotes. Fix: write `label="{expr}"`.
- **Symptom: the component uses a feature of an old API.** Cause: the meta file is below API 66.0. Fix: raise `apiVersion`.
- **Symptom: `lwc:external` element does not render.** Cause: the script has not loaded or Lightning Web Security is off. Fix: load it with `loadScript` and enable LWS.
- **Symptom: the custom element is defined twice.** Cause: `loadScript` runs on every render. Fix: guard with a flag, and guard `customElements.define` with `customElements.get`.
- **Symptom: a value never reaches the third-party element.** Cause: it reads properties, but LWC set attributes (or the reverse). Fix: check which the element supports and define properties if needed.
- **Symptom: a template becomes unreadable.** Cause: long expressions. Fix: keep one decision per expression and move bigger logic to a getter.

## Key takeaways

- Complex expressions put short JavaScript decisions in the template; keep logic in JavaScript when it grows.
- `this`, `new` and function declarations are not allowed, and attribute expressions belong in double quotes.
- Use API 66.0 or higher in the meta file; Winter '27 is API 68.0.
- `lwc:external` needs Lightning Web Security and an IIFE or UMD bundle loaded with `loadScript`.
- Test components with Jest and lint templates in CI so rules fail fast.

## Where to go next

- [LWC lifecycle and wire](/articles/lwc-lifecycle-and-wire/)
- [LWC communication and data patterns](/articles/lwc-communication-and-data-patterns/)
- [LWC Jest unit testing](/articles/lwc-jest-unit-testing/)
- [LWC forms and UI API](/articles/lwc-forms-and-ui-api/)
- [Choosing between LWC, multi-framework and microfrontends](/articles/choosing-lwc-multiframework-microfrontends/)
