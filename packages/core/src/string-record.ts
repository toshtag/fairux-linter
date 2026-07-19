export function createStringRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function readOwnStringValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
