export const REPAIR_REVIEW_STATES = [
  "proposed",
  "approved",
  "rejected",
  "unavailable",
] as const;

export type RepairReviewState = (typeof REPAIR_REVIEW_STATES)[number];
export type RepairReviewAction = "approve" | "reject";

export interface RepairReviewProjection {
  readonly state: Exclude<RepairReviewState, "unavailable">;
  readonly proposedBy: string;
}

export interface RepairReviewViewer {
  readonly viewer: string;
  readonly isAuthorisedHuman: boolean;
}

export function repairReviewState(
  projection: RepairReviewProjection | undefined,
): RepairReviewState {
  return projection?.state ?? "unavailable";
}

export function allowedRepairReviewActions(
  projection: RepairReviewProjection | undefined,
  viewer: RepairReviewViewer,
): readonly RepairReviewAction[] {
  if (
    projection === undefined ||
    projection.state !== "proposed" ||
    !viewer.isAuthorisedHuman
  ) {
    return [];
  }

  return projection.proposedBy === viewer.viewer
    ? ["reject"]
    : ["approve", "reject"];
}
