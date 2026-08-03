// `detectPageContexts` lives in @fairux/core so every adapter shares one implementation: it
// operates on already-normalized strings, which is browser-safe. Re-exported here because a
// caller holding the HTML adapter should not need a second import to read a page's contexts.
export { detectPageContexts } from "@fairux/core";
export { type ParseHtmlOptions, parseHtml } from "./parse.js";
