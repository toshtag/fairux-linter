#!/usr/bin/env node
// Guard against accidental direct-source publish.
// The ONLY supported publish path is the release workflow, which packs a verified
// tarball and publishes it with `npm publish --ignore-scripts <tarball>`.
// A stray `npm publish` from apps/cli would skip pnpm's workspace:* rewrite
// and ship a broken package. This guard fails unless we detect a tarball argument
// (release workflow) or the FAIRUX_RELEASE env var.
const args = process.argv.slice(2);
const hasTarball = args.some((a) => a.endsWith(".tgz"));
const isRelease = process.env.FAIRUX_RELEASE === "1";
if (!hasTarball && !isRelease) {
  console.error(
    "prepublishOnly: direct `npm publish` from source is not allowed.\n" +
      "Use the release workflow (pnpm pack:smoke → npm publish --ignore-scripts <tarball>) " +
      "or set FAIRUX_RELEASE=1 to override.",
  );
  process.exit(1);
}
