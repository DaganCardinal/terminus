import { z } from "zod"
import { junctionSchema } from "./junction"
import { integrationAttemptSchema } from "./integration"
import { technicianRepairSchema } from "./technician"
import { carSchema } from "./crossing"
export const junctionDetailsSchema = z.object({
  junction: junctionSchema,
  attempts: z.array(integrationAttemptSchema),
  repairs: z.array(technicianRepairSchema),
  cars: z.array(carSchema),
})
