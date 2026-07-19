export const invalidRulePack = {
  meta: {
    id: "example/invalid-locale-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Invalid locale fixture",
    status: "stable",
  },
  dictionary: {
    "de-1901-1901": {
      cta: [/buy/],
    },
  },
  rules: [],
};

export const expectedError = {
  messagePattern: "expected a well-formed RFC 5646 language tag",
};
