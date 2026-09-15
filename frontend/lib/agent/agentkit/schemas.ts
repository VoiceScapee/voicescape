/**
 * Input schemas for the Voicescape Agent Kit plugin tools.
 *
 * These are the `parameters` of each Hedera Agent Kit `Tool` — zod objects,
 * as the kit requires. They also drive the OpenAI function definitions sent
 * to the model (via zod-to-json-schema).
 */
import { z } from "zod";

/** lookupBlockpage — input schema. */
export const lookupBlockpageSchema = z.object({
  username: z
    .string()
    .min(1)
    .max(64)
    .describe("Voicescape blockpage username, e.g. 'forge'"),
});

/** verifyTip — input schema. */
export const verifyTipSchema = z.object({
  transactionId: z
    .string()
    .regex(/^\d+\.\d+\.\d+-\d+-\d+$/)
    .describe(
      "Mirror node transaction id, e.g. '0.0.10424063-1789415526-674972740'"
    ),
});

/** treasuryStats — input schema. */
export const treasuryStatsSchema = z.object({
  hoursBack: z
    .number()
    .int()
    .min(1)
    .max(168)
    .default(24)
    .describe("Lookback window in hours"),
});
