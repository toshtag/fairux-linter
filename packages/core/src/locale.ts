const GRANDFATHERED_TAGS = new Set([
  "en-gb-oed",
  "i-ami",
  "i-bnn",
  "i-default",
  "i-enochian",
  "i-hak",
  "i-klingon",
  "i-lux",
  "i-mingo",
  "i-navajo",
  "i-pwn",
  "i-tao",
  "i-tay",
  "i-tsu",
  "sgn-be-fr",
  "sgn-be-nl",
  "sgn-ch-de",
]);

function isAlpha(value: string): boolean {
  return /^[A-Za-z]+$/.test(value);
}

function isDigit(value: string): boolean {
  return /^\d+$/.test(value);
}

function isAlphaNumeric(value: string): boolean {
  return /^[A-Za-z0-9]+$/.test(value);
}

function hasLength(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max;
}

function isVariant(value: string): boolean {
  return (
    (hasLength(value, 5, 8) && isAlphaNumeric(value)) ||
    (value.length === 4 && /^\d[A-Za-z0-9]{3}$/.test(value))
  );
}

function isExtensionSingleton(value: string): boolean {
  return /^[0-9A-WY-Za-wy-z]$/.test(value);
}

function isPrivateUse(subtags: readonly string[], start: number): boolean {
  if (subtags[start]?.toLowerCase() !== "x") return false;
  if (start + 1 >= subtags.length) return false;
  for (let index = start + 1; index < subtags.length; index += 1) {
    if (!(hasLength(subtags[index] ?? "", 1, 8) && isAlphaNumeric(subtags[index] ?? ""))) {
      return false;
    }
  }
  return true;
}

function consumeLanguage(subtags: readonly string[]): number {
  const language = subtags[0] ?? "";
  if (hasLength(language, 2, 3) && isAlpha(language)) {
    let index = 1;
    for (let count = 0; count < 3; count += 1) {
      const extlang = subtags[index] ?? "";
      if (!(extlang.length === 3 && isAlpha(extlang))) break;
      index += 1;
    }
    return index;
  }
  if ((language.length === 4 || hasLength(language, 5, 8)) && isAlpha(language)) {
    return 1;
  }
  return -1;
}

function isLangTag(subtags: readonly string[]): boolean {
  let index = consumeLanguage(subtags);
  if (index < 0) return false;

  const script = subtags[index] ?? "";
  if (script.length === 4 && isAlpha(script)) index += 1;

  const region = subtags[index] ?? "";
  if ((region.length === 2 && isAlpha(region)) || (region.length === 3 && isDigit(region))) {
    index += 1;
  }

  const seenVariants = new Set<string>();
  while (isVariant(subtags[index] ?? "")) {
    const variant = (subtags[index] ?? "").toLowerCase();
    if (seenVariants.has(variant)) return false;
    seenVariants.add(variant);
    index += 1;
  }

  const seenExtensions = new Set<string>();
  while (isExtensionSingleton(subtags[index] ?? "")) {
    const singleton = (subtags[index] ?? "").toLowerCase();
    if (seenExtensions.has(singleton)) return false;
    seenExtensions.add(singleton);
    index += 1;

    let extensionSubtagCount = 0;
    while (hasLength(subtags[index] ?? "", 2, 8) && isAlphaNumeric(subtags[index] ?? "")) {
      extensionSubtagCount += 1;
      index += 1;
    }
    if (extensionSubtagCount === 0) return false;
  }

  if (index < subtags.length && isPrivateUse(subtags, index)) {
    index = subtags.length;
  }

  return index === subtags.length;
}

export function isLocaleTag(value: string): boolean {
  if (value.length === 0 || value.includes("_") || value.startsWith("-") || value.endsWith("-")) {
    return false;
  }
  const subtags = value.split("-");
  if (subtags.some((subtag) => subtag.length === 0)) return false;
  if (GRANDFATHERED_TAGS.has(value.toLowerCase())) return true;
  if (subtags[0]?.toLowerCase() === "x") return isPrivateUse(subtags, 0);
  return isLangTag(subtags);
}
