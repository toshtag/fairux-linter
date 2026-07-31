// Lives in @fairux/core so every adapter shares it: it operates on already-normalized strings,
// which is browser-safe. Re-exported here for
// backward compatibility with anything importing it from @fairux/html.
export { detectPageContexts } from "@fairux/core";
