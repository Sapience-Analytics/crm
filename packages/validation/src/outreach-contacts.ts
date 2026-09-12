import { z } from "zod";
import { OUTREACH } from "./outreach";
import {
	contactResearchCandidateSchema,
	verifiedContactCandidateSchema,
} from "./outreach-contact-target";

export const CONTACT_RESEARCH = {
	maxAttempts: 2,
	perTick: 1,
	retryMs: 15 * OUTREACH.minuteMs,
	maxCandidates: 3,
	version: "official-contact-association-v1",
	candidateFreshMs: OUTREACH.dayMs,
	maxBlockChars: 1800,
} as const;

export const contactResearchInput = z
	.object({ id: z.string().min(1).max(100) })
	.strict();
export const queueContactResearchInput = contactResearchInput.extend({
	candidates: z
		.array(contactResearchCandidateSchema)
		.min(1)
		.max(CONTACT_RESEARCH.maxCandidates)
		.optional(),
});
export const selectContactInput = contactResearchInput.extend({
	candidateId: z.string().length(64),
});
export const contactResearchOutput = z.object({
	status: z.string(),
	error: z.string().nullable(),
	completedAt: z.string().nullable(),
	candidates: z
		.array(verifiedContactCandidateSchema)
		.max(CONTACT_RESEARCH.maxCandidates),
});
export const contactResearchActionOutput = z.object({ ok: z.literal(true) });
