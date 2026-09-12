import { createHash } from "node:crypto";
import type { OutreachProspectModel } from "@crm/db";
import {
	consentSchema,
	contactEligible,
	evidenceSchema,
	OUTREACH,
	type templatesSchema,
} from "@crm/validation/outreach";
import {
	draftArtifactSchema,
	groundedSequence,
	PERSONALISATION,
} from "@crm/validation/outreach-drafts";
import type { z } from "zod";

export function campaignHash(templates: z.infer<typeof templatesSchema>) {
	return createHash("sha256")
		.update(
			JSON.stringify({
				templates,
				rules: OUTREACH,
				personalisation: PERSONALISATION,
			}),
		)
		.digest("hex");
}

export function draftReviewHash(draft: z.infer<typeof draftArtifactSchema>) {
	return createHash("sha256").update(JSON.stringify(draft)).digest("hex");
}

export function draftInputHash(
	prospect: Pick<OutreachProspectModel, "email" | "evidence" | "consent">,
	templates: z.infer<typeof templatesSchema>,
) {
	return createHash("sha256")
		.update(
			JSON.stringify({
				campaign: campaignHash(templates),
				evidence: evidenceSchema.parse(prospect.evidence),
				email: prospect.email,
				consent: consentSchema.safeParse(prospect.consent).data ?? null,
			}),
		)
		.digest("hex");
}

export function currentDraft(
	prospect: Pick<
		OutreachProspectModel,
		| "email"
		| "evidence"
		| "consent"
		| "emailDrafts"
		| "emailDraftHash"
		| "emailDraftStatus"
	>,
	templates: z.infer<typeof templatesSchema>,
) {
	const evidence = evidenceSchema.safeParse(prospect.evidence);
	const consent = consentSchema.safeParse(prospect.consent);
	if (
		!evidence.success ||
		!consent.success ||
		!contactEligible(evidence.data, consent.data) ||
		prospect.email !== evidence.data.email
	)
		return null;
	const artifact = draftArtifactSchema.safeParse(prospect.emailDrafts);
	const hash = draftInputHash(prospect, templates);
	if (
		prospect.emailDraftStatus !== "READY" ||
		prospect.emailDraftHash !== hash ||
		!artifact.success ||
		artifact.data.inputHash !== hash ||
		artifact.data.campaignHash !== campaignHash(templates)
	)
		return null;
	try {
		const expected = groundedSequence(artifact.data, templates, evidence.data);
		if (
			expected.some(
				(stage, index) =>
					stage.subject !== artifact.data.stages[index]?.subject ||
					stage.body !== artifact.data.stages[index]?.body,
			)
		)
			return null;
	} catch {
		return null;
	}
	return artifact.data;
}
