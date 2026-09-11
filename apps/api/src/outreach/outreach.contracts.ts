import {
	consentSchema,
	outreachReportSchema,
	readinessSchema,
	templatesSchema,
} from "@crm/validation/outreach";
import { z } from "zod";

export const campaignUpdateInput = z.object({ templates: templatesSchema });
export const campaignActionInput = z.object({
	action: z.enum([
		"research-on",
		"research-off",
		"approve",
		"pause",
		"start-pilot",
		"start-active",
	]),
	hash: z.string().optional(),
});
export const campaignReadinessInput = readinessSchema;
export const prospectApproveInput = z.object({
	id: z.string().min(1),
	consent: consentSchema.omit({ verifiedBy: true, verifiedAt: true }),
});
export const prospectStopInput = z.object({ id: z.string().min(1) });
export const outreachPageInput = z.object({
	page: z.number().int().min(0).default(0),
});
export const outreachResult = z.object({ ok: z.boolean() });
export const outreachStatusOutput = z.object({
	exists: z.boolean(),
	status: z.string(),
	hash: z.string(),
	approved: z.boolean(),
	templates: templatesSchema,
	researchEnabled: z.boolean(),
	sendConnected: z.boolean(),
	ready: z.boolean(),
	lastError: z.string().nullable(),
	researchError: z.string().nullable(),
	lastTickAt: z.string().nullable(),
	lastResearchAt: z.string().nullable(),
	counts: z.array(z.object({ status: z.string(), count: z.number() })),
	budgets: z.array(
		z.object({
			id: z.string(),
			reservedMicroUsd: z.number(),
			actualMicroUsd: z.number(),
			calls: z.number(),
		}),
	),
	reports: z.array(
		z.object({ week: z.string(), summary: outreachReportSchema }),
	),
});
export const outreachProspectsOutput = z.object({
	total: z.number(),
	rows: z.array(
		z.object({
			id: z.string(),
			company: z.string(),
			email: z.string().nullable(),
			status: z.string(),
			manual: z.boolean(),
			sourceUrl: z.string(),
			sourceQuote: z.string(),
			fleetBand: z.string(),
			fit: z.string(),
			verified: z.boolean(),
			consent: z.json().nullable(),
			replyDraft: z.string().nullable(),
			stopReason: z.string().nullable(),
			preview: z.object({ subject: z.string(), body: z.string() }),
		}),
	),
});
