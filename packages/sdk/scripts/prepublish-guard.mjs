#!/usr/bin/env node
const args = process.argv.slice(2);
const hasTarball = args.some((arg) => arg.endsWith(".tgz"));
const isRelease = process.env.FAIRUX_ALLOW_SDK_PUBLISH === "1";

if (!hasTarball && !isRelease) {
  console.error(
    "prepublishOnly: direct `npm publish` from packages/sdk is not allowed.\n" +
      "Pack and verify the SDK tarball first, then publish the verified artifact " +
      "with FAIRUX_ALLOW_SDK_PUBLISH=1 only after release approval.",
  );
  process.exit(1);
}
