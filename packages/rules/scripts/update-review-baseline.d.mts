import type { ReviewBaseline } from "./review-baseline.mjs";

/** The baseline as the built packages and the review records currently stand. */
export function measureReviewBaseline(): Promise<ReviewBaseline>;
