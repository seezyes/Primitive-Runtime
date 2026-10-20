import { z } from "zod";
// Native authorization precedes every use of these shapes and owns the exact
// UTF-8 byte limits. Host string bounds must not narrow the advertised catalog.
export const assignmentSchema = z
  .object({
    path: z.string().min(1).max(4096),
    objective: z.string().min(1).max(16384),
    dependencies: z.array(z.string().min(1).max(4096)).max(256),
    create: z.boolean().optional(),
  })
  .strict();
export const planSchema = z
  .object({
    assignments: z.array(assignmentSchema).min(1).max(256),
    summary: z.string().min(1).max(16384),
  })
  .strict();
export const diagnosisSchema = z
  .object({
    verdict: z.enum(["pass", "fail"]),
    evidence: z.array(z.string().min(1).max(16384)).max(256),
    causes: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            reason: z.string().min(1).max(16384),
          })
          .strict(),
      )
      .max(256),
    guidance: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            objective: z.string().min(1).max(16384),
          })
          .strict(),
      )
      .max(256),
    summary: z.string().min(1).max(16384),
  })
  .strict();
