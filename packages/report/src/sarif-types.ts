/**
 * Minimal local SARIF 2.1.0 surface — only the fields we emit.
 *
 * We deliberately do NOT pull in `@types/sarif`: it adds a heavy types dep, and the upside
 * (covering surface we don't use) is negative — extra fields in our objects would surprise
 * snapshot tests. This file is the single source of truth for what FairUX writes into SARIF.
 */

export type SarifLevel = "error" | "warning" | "note" | "none";

export interface SarifMessage {
  text: string;
}

export interface SarifMultiformatMessage {
  text: string;
  markdown?: string;
}

export interface SarifArtifactLocation {
  uri: string;
}

export interface SarifRegion {
  startLine?: number;
  startColumn?: number;
}

export interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region?: SarifRegion;
}

export interface SarifLogicalLocation {
  name: string;
  kind?: string;
  fullyQualifiedName?: string;
}

export interface SarifLocation {
  physicalLocation?: SarifPhysicalLocation;
  logicalLocations?: SarifLogicalLocation[];
}

export interface SarifReportingDescriptor {
  id: string;
  name?: string;
  shortDescription?: SarifMessage;
  fullDescription?: SarifMultiformatMessage;
  helpUri?: string;
  properties?: Record<string, unknown>;
}

export interface SarifToolDriver {
  name: string;
  version?: string;
  informationUri?: string;
  shortDescription?: SarifMessage;
  fullDescription?: SarifMultiformatMessage;
  rules?: SarifReportingDescriptor[];
}

export interface SarifTool {
  driver: SarifToolDriver;
}

export interface SarifInvocation {
  executionSuccessful: boolean;
}

export interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: SarifMessage;
  locations: SarifLocation[];
  relatedLocations?: SarifLocation[];
  fingerprints: Record<string, string>;
  properties?: Record<string, unknown>;
}

export interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
  invocations?: SarifInvocation[];
  properties?: Record<string, unknown>;
}

export interface SarifLog {
  $schema?: string;
  version: "2.1.0";
  runs: SarifRun[];
}
