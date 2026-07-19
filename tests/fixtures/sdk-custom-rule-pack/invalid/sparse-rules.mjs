const sparseRules = new Array(1);

export const invalidRulePack = {
  meta: {
    id: "example/sparse-rules-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Sparse rules fixture",
    status: "stable",
  },
  rules: sparseRules,
};

export const expectedError = {
  messagePattern: "sparse arrays are not supported",
};
