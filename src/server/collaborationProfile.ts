import { z } from "zod";

import {
  CollaborationProfileValidationError,
  normalizeCollaborationProfile,
  type CollaborationProfile,
} from "../shared/collaborationProfile.js";

export const collaborationProfileSchema = z.object({
  displayName: z.string(),
  color: z.string(),
}).strict().transform<CollaborationProfile>((value, context) => {
  try {
    return normalizeCollaborationProfile(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof CollaborationProfileValidationError
        ? error.message
        : "Collaboration profile is invalid",
    });
    return z.NEVER;
  }
});
