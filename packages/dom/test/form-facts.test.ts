// @vitest-environment happy-dom
import { resolveDocumentCapabilities, RUNTIME_CAPABILITIES, scan } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { parseDocument } from "../src/index.js";

function load(html: string): Document {
  document.documentElement.innerHTML = html;
  return document;
}

const signup = `<body>
  <form id="signup">
    <input id="email" type="email" required>
    <input id="nickname" type="text">
    <label><input id="marketing" type="checkbox" required> Email me offers</label>
    <button type="submit">Create account</button>
  </form>
</body>`;

const control = (doc: ReturnType<typeof parseDocument>, htmlId: string) =>
  doc.findAll((node) => node.attributes.id === htmlId)[0];

describe("form facts are opt-in", () => {
  it("collects nothing, and claims nothing, by default", () => {
    const doc = parseDocument(load(signup));
    expect(resolveDocumentCapabilities(doc)).toEqual(RUNTIME_CAPABILITIES.dom);
    expect(doc.all().every((node) => node.form === undefined)).toBe(true);
  });

  it("still reports `form` as unavailable in a scan's coverage", () => {
    const report = scan(parseDocument(load(signup)), []);
    expect(report.coverage?.capabilities.unavailable).toContain("form");
  });
});

describe("form facts when asked for", () => {
  it("claims the capability, and reaches the scan's coverage", () => {
    const doc = parseDocument(load(signup), { formFacts: true });
    expect(resolveDocumentCapabilities(doc)).toContain("form");
    const report = scan(doc, []);
    expect(report.coverage?.capabilities.available).toContain("form");
    // Asking for one does not claim the other.
    expect(report.coverage?.capabilities.unavailable).toContain("computed-style");
  });

  it("claims both when both were read", () => {
    const doc = parseDocument(load(signup), { formFacts: true, visualFacts: true });
    const available = resolveDocumentCapabilities(doc);
    expect(available).toContain("form");
    expect(available).toContain("computed-style");
    expect(available).toContain("viewport");
  });

  it("records the constraint an empty required field is currently failing", () => {
    const doc = parseDocument(load(signup), { formFacts: true });
    expect(control(doc, "email")?.form?.failedConstraints).toContain("valueMissing");
    // Valid and non-validating are different states, and only one of them has an empty list for a
    // reason a rule should act on.
    expect(control(doc, "nickname")?.form?.failedConstraints).toEqual([]);
    expect(control(doc, "nickname")?.form?.willValidate).toBe(true);
  });

  it("names the form that owns a control, resolved by the engine rather than by ancestry", () => {
    const doc = parseDocument(
      load(`<body>
        <form id="outer"></form>
        <input id="detached" form="outer" required>
      </body>`),
      { formFacts: true },
    );
    const form = doc.findAll((node) => node.tag === "form")[0];
    // The input is a sibling of the form, not a descendant. Walking parents would find nothing.
    expect(control(doc, "detached")?.form?.formNodeId).toBe(form?.id);
  });

  it("distinguishes a required field that does not actually validate", () => {
    // The whole point of the capability. `required` is still in the markup; the engine says the
    // control is not a validation candidate, and no attribute on the input says so.
    const doc = parseDocument(
      load(`<body>
        <form id="f" novalidate>
          <input id="email" type="email" required>
          <input id="frozen" type="text" required disabled>
        </form>
      </body>`),
      { formFacts: true },
    );
    expect(control(doc, "email")?.attributes.required).toBe(true);
    expect(control(doc, "frozen")?.form?.willValidate).toBe(false);
    // The engine computes `valueMissing` for a disabled required input all the same. It is not
    // recorded, because a control barred from validation is not failing anything in effect — and
    // the authored `required` is still in `attributes` for a reader who wants the other question.
    expect(control(doc, "frozen")?.form?.failedConstraints).toEqual([]);
  });

  it("leaves non-controls alone", () => {
    const doc = parseDocument(load(signup), { formFacts: true });
    expect(doc.findAll((node) => node.tag === "label")[0]?.form).toBeUndefined();
  });

  it("is deterministic across two scans of one unchanged form", () => {
    const live = load(signup);
    const first = parseDocument(live, { formFacts: true })
      .all()
      .map((node) => node.form);
    const second = parseDocument(live, { formFacts: true })
      .all()
      .map((node) => node.form);
    expect(second).toEqual(first);
  });
});
