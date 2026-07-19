const inheritedMeta = Object.create({
  id: "example/inherited-metadata-pack",
  version: "0.1.0",
  engineApiVersion: "1",
  title: "Inherited metadata fixture",
  status: "stable",
});

export const invalidRulePack = {
  meta: inheritedMeta,
  rules: [],
};

export const expectedError = {
  messagePattern: "expected a plain object",
};
