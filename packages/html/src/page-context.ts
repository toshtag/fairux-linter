// Moved into @fairux/core so every adapter shares it — the DOM adapter contract
// (`docs/architecture/decisions/dom-adapter-contract.md`), "`pageContexts` detection".
// Re-exported here for
// backward compatibility with anything importing it from @fairux/html.
export { detectPageContexts } from "@fairux/core";
