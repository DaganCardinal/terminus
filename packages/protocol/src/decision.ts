import { z } from "zod"

/**
 * The wire format of a decision model (Clef on Workers AI). It scores fixed
 * answer options for typed questions about a state and never writes text.
 */
const questionIdSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)

export const decisionQuestionSchema = z.discriminatedUnion("type", [
  /** A yes/no question, answered with the probability of yes. */
  z.strictObject({ type: z.literal("noul"), instructions: z.string().min(1) }),
  /** Named options, each with an optional description. */
  z.strictObject({
    type: z.literal("choice"),
    instructions: z.string().min(1),
    criteria: z.record(z.string(), z.string().nullable()).refine((criteria) => {
      const count = Object.keys(criteria).length
      return count >= 2 && count <= 255
    }, "A choice needs 2 to 255 options"),
  }),
  /** Ordered levels, lowest first. */
  z.strictObject({
    type: z.literal("score"),
    instructions: z.string().min(1),
    criteria: z.array(z.string()).min(2).max(10),
  }),
])
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>

export const decisionQuestionsSchema = z
  .record(questionIdSchema, decisionQuestionSchema)
  .refine((questions) => {
    const count = Object.keys(questions).length
    return count >= 1 && count <= 64
  }, "A decision request needs 1 to 64 questions")

const probabilitySchema = z.number().min(0).max(1)

export const decisionAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probabilitySchema }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), probabilitySchema),
    confidence: probabilitySchema,
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    probabilities: z.record(z.string(), probabilitySchema),
    confidence: probabilitySchema,
  }),
])
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>

/** The REST response from `/ai/run/<model>`, inside Cloudflare's envelope. */
export const decisionRunResponseSchema = z.object({
  result: z.object({
    answers: z.record(z.string(), decisionAnswerSchema),
  }),
})
