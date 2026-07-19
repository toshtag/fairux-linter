import { isAbsolute, normalize, resolve } from "node:path";

const REJECTED_SOURCE_PATTERNS = [
  /(^|\/)packages\/[^/]+\/src(\/|$)/,
  /(^|\/)\.env($|[./_-])/,
  /workspace:/,
  /file:\/\//,
  /(^|\/)secret/i,
  /(^|\/)private/i,
  /^\/Users\//,
  /^\/home\//,
  /^[A-Za-z]:[\\/]/,
];

export function auditSourceMap(entry, text, options = {}) {
  const errors = [];
  let map;
  try {
    map = JSON.parse(text);
  } catch (error) {
    return [`${entry}: source map is not valid JSON (${error.message})`];
  }

  if (Array.isArray(map.sourcesContent)) {
    for (let index = 0; index < map.sourcesContent.length; index += 1) {
      const source = map.sourcesContent[index];
      if (typeof source === "string" && source.length > 0) {
        errors.push(`${entry}: sourcesContent[${index}] embeds private source`);
      }
    }
  }

  const repoRoot = options.repoRoot ? normalize(resolve(options.repoRoot)) : undefined;
  for (const [index, rawSource] of Object.entries(map.sources ?? [])) {
    if (typeof rawSource !== "string") {
      errors.push(`${entry}: sources[${index}] is not a string`);
      continue;
    }
    const source = rawSource.replaceAll("\\", "/");
    if (isAbsolute(rawSource)) {
      errors.push(`${entry}: sources[${index}] is an absolute path`);
    }
    if (repoRoot && normalize(resolve(rawSource)).startsWith(repoRoot)) {
      errors.push(`${entry}: sources[${index}] resolves inside the build repository`);
    }
    for (const pattern of REJECTED_SOURCE_PATTERNS) {
      if (pattern.test(source)) {
        errors.push(`${entry}: sources[${index}] contains rejected path ${rawSource}`);
        break;
      }
    }
  }

  return errors;
}
