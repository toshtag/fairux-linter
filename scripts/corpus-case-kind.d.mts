/** Whether a corpus case is a positive or a negative, derived from its `expected` array. */
export declare function caseKind(entry: { expected?: readonly unknown[] }): "positive" | "negative";
