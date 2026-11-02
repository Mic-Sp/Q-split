import type { HybridTelemetryResponse } from "@/types/telemetry";

export type ResourceModelVersion = 1 | 2;

export const modelVersionLabel = (version: ResourceModelVersion) => version === 2 ? "CALIBRATED_V2" : "ILLUSTRATIVE_V1";

/** Missing markers identify historical V1 runs. Reject conflicting or unknown markers. */
export function resourceModelVersion(data: HybridTelemetryResponse): ResourceModelVersion {
  const markers: ResourceModelVersion[] = [];
  const version = (value: unknown) => {
    if (value === undefined) return;
    if (value !== 1 && value !== 2) throw new Error("Unsupported resource model version.");
    markers.push(value);
  };
  const tag = (value: unknown) => {
    if (value === undefined) return;
    if (typeof value !== "string" || !/^(ILLUSTRATIVE_V1|CALIBRATED_V2)(?: \(not device measurements\))?$/.test(value)) {
      throw new Error("Unsupported routing model.");
    }
    markers.push(value.startsWith("CALIBRATED_V2") ? 2 : 1);
  };
  version(data.resource_model_version);
  tag(data.routing_model);
  for (const stage of Object.values(data.stages)) {
    version(stage.metrics.resource_model_version);
    tag(stage.metrics.routing_model);
  }
  if (markers.some(marker => marker !== markers[0])) throw new Error("Conflicting resource model versions.");
  return markers[0] ?? 1;
}

export const sameModelVersion = (before: HybridTelemetryResponse, after: HybridTelemetryResponse) =>
  resourceModelVersion(before) === resourceModelVersion(after);

/** Store the resolved version in existing telemetry JSON, including newly saved legacy runs. */
export function versionedTelemetry(data: HybridTelemetryResponse): HybridTelemetryResponse {
  const version = resourceModelVersion(data);
  return { ...data, resource_model_version: version, routing_model: modelVersionLabel(version) };
}
