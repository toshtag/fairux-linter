import { describe, expect, it } from "vitest";
import { JSX_ALIASES, parseSource } from "../../packages/ast/src/index.js";
import { scan, type UiDocument } from "../../packages/core/src/index.js";
import { parseHtml } from "../../packages/html/src/index.js";
import { allRules, dictionary } from "../../packages/rules/src/index.js";

/**
 * The same page, written the way a framework writes it.
 *
 * Issue #335: `<input type="checkbox" defaultChecked />` produced no finding while
 * `<input type="checkbox" checked />` produced one. Both are a box that arrives ticked, which is the
 * case `consent/checked-checkbox` exists for — and `defaultChecked` is the spelling React actually
 * recommends, because `checked` without `onChange` is the form it warns about in development. The
 * adapter recognised the rarer one.
 *
 * That is not a rule defect. It is an adapter one: `parse.ts` already normalised `className` and
 * `htmlFor`, so the boundary was in the right place and the map was two entries short. Fixing it
 * there means no rule changes, no `ruleVersion` moves, and no review record is touched.
 *
 * **What this file measures, rather than guesses.** The second half runs a scan with every node's
 * attribute bag behind a `Proxy` and records the names the engine actually asks for. Every one of
 * them has to have a decision recorded — an alias, or "JSX spells it the same". A rule that starts
 * reading a new attribute fails here until somebody answers the question for it, which is the point:
 * this is not drift detection, it is a decision that has to be made at the moment it matters.
 *
 * **What is out of reach, and why there is no code for it.** Vue and Svelte templates live in
 * `.vue` and `.svelte` files, and neither is an extension this project scans — so `:checked`,
 * `v-bind:checked`, `v-model` and `bind:checked` are not spellings anything here can meet. Adding
 * support for those file types is a scope decision, not an alias table; inventing entries for it
 * now would be code for an input that cannot arrive.
 */

const ruleIdsOf = (doc: UiDocument) =>
  scan(doc, allRules, { dictionary })
    .findings.map((finding) => finding.ruleId)
    .sort();

const fromHtml = (body: string) =>
  ruleIdsOf(
    parseHtml(`<!doctype html><html lang="en"><body>${body}</body></html>`, { file: "page.html" }),
  );

const fromJsx = (body: string) =>
  ruleIdsOf(parseSource(`export const Page = () => (<div>${body}</div>);`, { file: "Page.tsx" }));

describe("a JSX spelling of an attribute means what the DOM spelling means", () => {
  it("sees a box React ships pre-ticked", () => {
    // The defect, both directions. The HTML side is what the rule was written against.
    const html = fromHtml('<label><input type="checkbox" checked> Email me offers</label>');
    expect(html).toContain("consent/checked-checkbox");
    expect(
      fromJsx('<label><input type="checkbox" defaultChecked /> Email me offers</label>'),
    ).toEqual(html);
    expect(
      fromJsx('<label><input type="checkbox" defaultChecked={true} /> Email me offers</label>'),
    ).toEqual(html);
  });

  it("stays quiet on a box that is not ticked, however it is spelled", () => {
    // The direction that matters more: a normalization that fired on `defaultChecked={false}` would
    // have traded one silent miss for a false positive on every uncontrolled form in a codebase.
    const quiet = fromHtml('<label><input type="checkbox"> Email me offers</label>');
    expect(quiet).not.toContain("consent/checked-checkbox");
    for (const jsx of [
      '<label><input type="checkbox" /> Email me offers</label>',
      '<label><input type="checkbox" defaultChecked={false} /> Email me offers</label>',
      '<label><input type="checkbox" defaultChecked={isOn} /> Email me offers</label>',
    ]) {
      expect(fromJsx(jsx), jsx).not.toContain("consent/checked-checkbox");
    }
  });

  it("reads a control's label through the JSX spellings of class, for, and value", () => {
    // `className` and `htmlFor` were already mapped; `defaultValue` is the fallback the engine uses
    // for a control with no text of its own, and it had the same gap as `defaultChecked`.
    const html = fromHtml(
      '<div class="cookie-consent"><p>We use cookies to personalise ads.</p>' +
        '<input type="submit" value="Accept all cookies"></div>',
    );
    expect(html).toContain("consent/missing-reject-option");
    expect(
      fromJsx(
        '<div className="cookie-consent"><p>We use cookies to personalise ads.</p>' +
          '<input type="submit" defaultValue="Accept all cookies" /></div>',
      ),
    ).toEqual(html);
  });
});

/**
 * Every attribute name the engine asked for during a scan, observed rather than listed.
 *
 * A `Proxy` on each node's attribute bag, trapping the three ways a name can be consulted: read,
 * `in`, and enumeration. What comes back is the surface a JSX spelling could hide.
 */
function attributeReadsDuring(document: UiDocument): Set<string> {
  const seen = new Set<string>();
  for (const node of document.findAll(() => true)) {
    const raw = node.attributes;
    (node as { attributes: Record<string, string | true> }).attributes = new Proxy(raw, {
      get(target, key) {
        if (typeof key === "string") seen.add(key);
        return Reflect.get(target, key);
      },
      has(target, key) {
        if (typeof key === "string") seen.add(key);
        return Reflect.has(target, key);
      },
      ownKeys(target) {
        for (const key of Reflect.ownKeys(target)) if (typeof key === "string") seen.add(key);
        return Reflect.ownKeys(target);
      },
    });
  }
  scan(document, allRules, { dictionary });
  return seen;
}

/**
 * DOM attribute names JSX spells identically, recorded as answers rather than assumed.
 *
 * Exactly the names the survey below observes, and no more. A wider set would be pre-approval: a
 * name nobody has seen the engine read, waved through in advance by whoever guessed it might come
 * up. This grows when the pages grow, which is the right direction.
 *
 * It is not a list that detects drift — a new entry arrives in the same edit as the rule that
 * needed it. It is a list that forces the question to be *asked*: when a rule starts reading an
 * attribute, somebody writes down whether a framework spells it differently, at the moment they
 * still have the answer in their head.
 */
const SAME_IN_JSX = new Set(["type", "href", "id", "data-countdown", "data-timer"]);

describe("every attribute the engine reads has a JSX answer", () => {
  /** Pages chosen to reach as many rules as this file can without becoming a corpus. */
  const PAGES = [
    '<div class="cookie-consent"><p>We use cookies and similar technologies for advertising.</p>' +
      '<button type="button">Accept all cookies</button></div>',
    // A control labelled only by `value`, which is the fallback `getControlLabel` reaches last —
    // and the read that makes `defaultValue` worth an alias rather than a guess.
    '<div class="cookie-consent"><p>We use cookies to personalise ads.</p>' +
      '<input type="submit" value="Accept all cookies"></div>',
    '<label><input type="checkbox" checked> Email me offers</label>',
    // A control labelled through `for`/`id` rather than by wrapping, which is the other branch.
    '<form><label for="opt">Email me offers</label><input id="opt" type="checkbox" checked></form>',
    '<div role="dialog" aria-modal="true"><p>Subscribe now</p><button type="button">Continue</button></div>',
    '<p>Only 2 left in stock! Offer ends in <span data-countdown="600">10:00</span></p>',
    '<main><h1>Checkout</h1><p>Total $40.00</p><button type="submit">Pay now</button>' +
      '<a href="/terms">Terms</a></main>',
    "<p>Start your free trial today</p>" +
      '<button type="button" style="opacity:0.4">No thanks, I hate saving money</button>',
  ];

  const observed = new Set<string>();
  for (const page of PAGES) {
    const document = parseHtml(`<!doctype html><html lang="en"><body>${page}</body></html>`, {
      file: "survey.html",
    });
    for (const name of attributeReadsDuring(document)) observed.add(name);
  }

  it("observed enough to be worth checking", () => {
    // A survey that watched nothing would pass every assertion below while proving nothing. The
    // four the rules are built on are the floor.
    expect(observed.size).toBeGreaterThan(3);
    // `value` and `for` are the two the first version of these pages never reached, which is how a
    // survey quietly measures less than it claims.
    for (const name of ["type", "checked", "class", "value", "for"]) {
      expect(observed, `the survey should have seen ${name}`).toContain(name);
    }
  });

  it("has an alias or a decision for every one of them", () => {
    const aliasTargets = new Set(Object.values(JSX_ALIASES));
    const undecided = [...observed].filter(
      (name) => !aliasTargets.has(name) && !SAME_IN_JSX.has(name),
    );
    expect(
      undecided,
      "a rule started reading an attribute nobody has answered for: add it to JSX_ALIASES in " +
        "packages/ast/src/parse.ts if a framework spells it differently, or to SAME_IN_JSX here",
    ).toEqual([]);
  });

  it("maps exactly the spellings JSX reserves or renames, and nothing invented", () => {
    // Two of these are JSX reserving a JavaScript keyword; two are React naming an uncontrolled
    // input's initial state. Every entry has a page in the cases above that proves it matters.
    expect(JSX_ALIASES).toEqual({
      className: "class",
      htmlFor: "for",
      defaultChecked: "checked",
      defaultValue: "value",
    });
  });
});
