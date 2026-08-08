// import "node:fs" is exactly what this package must never do.
/* Nor may it write require("fs") here. */
export const marker = 1;
