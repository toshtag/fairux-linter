export class RulePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulePackError";
  }
}
