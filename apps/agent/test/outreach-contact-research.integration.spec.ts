import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { db, Prisma } from "@crm/db";
import {
	DEFAULT_TEMPLATES,
	evidenceSchema,
	OUTREACH,
} from "@crm/validation/outreach";
import { contactResearchCandidateSchema } from "@crm/validation/outreach-contact-target";
import { runOutreachContactResearch } from "../agent/lib/outreach-contact-research";
import * as sources from "../agent/lib/outreach-research";
import { RESEARCH_PROVIDER } from "../agent/lib/outreach-research-config";

const sourceSpy = spyOn(sources, "readSource");
const fetchSpy = spyOn(globalThis, "fetch");
const previousEnvironment = process.env.VERCEL_ENV;
const previousKey = process.env.PERPLEXITY_API_KEY;
const domain = "contact-research-spec.test";
const ownerId = "contact-research-owner";
const budgetId = `research:${new Date().toISOString().slice(0, 7)}`;
const candidate = contactResearchCandidateSchema.parse({
	kind: "named",
	name: "Alex Smith",
	role: "operations",
	roleTitle: "Operations Manager",
	email: `alex@${domain}`,
	sourceUrl: `https://${domain}/contact`,
	associationQuote: `Alex Smith Operations Manager alex@${domain}`,
	employmentQuote: "Alex Smith Operations Manager",
});
const evidence = evidenceSchema.parse({
	company: "Test Haulage",
	domain,
	email: `team@${domain}`,
	industry: "transport",
	fleetBand: "unknown",
	fleetEvidence: "unknown",
	fit: "Delivery vehicles operating across Western Australia",
	sourceUrl: `https://${domain}`,
	sourceQuote: "We operate delivery vehicles across Perth.",
	waQuote: "Perth, Western Australia",
	checkedAt: new Date().toISOString(),
	verified: true,
});
let id = "";
let companyId = "";
let ownsFixtures = false;

beforeEach(async () => {
	expect(
		await db.outreachCampaign.findUnique({ where: { id: OUTREACH.id } }),
	).toBeNull();
	expect(
		await db.outreachBudget.findUnique({ where: { id: budgetId } }),
	).toBeNull();
	expect(await db.company.findFirst({ where: { domain } })).toBeNull();
	ownsFixtures = true;
	await db.user.create({
		data: {
			id: ownerId,
			name: "Contact research test",
			email: "owner@contact-research-spec.test",
			emailVerified: true,
		},
	});
	process.env.VERCEL_ENV = "production";
	process.env.PERPLEXITY_API_KEY = "controlled-people-research-test";
	await db.outreachCampaign.create({
		data: {
			id: OUTREACH.id,
			ownerId,
			senderEmail: OUTREACH.sender,
			templates: DEFAULT_TEMPLATES,
			status: "PAUSED",
			researchEnabled: true,
		},
	});
	const company = await db.company.create({
		data: { name: evidence.company, domain, ownerId },
	});
	companyId = company.id;
	const prospect = await db.outreachProspect.create({
		data: {
			campaignId: OUTREACH.id,
			companyId,
			domain,
			email: evidence.email,
			evidence,
			status: "MANUAL",
			manual: true,
			pilotSlot: 1,
			contactResearch: { create: { submittedCandidates: [candidate] } },
		},
	});
	id = prospect.id;
	sourceSpy.mockResolvedValue({
		text: `<section><h2>Alex Smith</h2><p>Operations Manager</p><p>alex@${domain}</p></section>`,
		url: new URL(candidate.sourceUrl),
	});
});

afterEach(async () => {
	sourceSpy.mockReset();
	fetchSpy.mockReset();
	if (previousEnvironment === undefined) delete process.env.VERCEL_ENV;
	else process.env.VERCEL_ENV = previousEnvironment;
	if (previousKey === undefined) delete process.env.PERPLEXITY_API_KEY;
	else process.env.PERPLEXITY_API_KEY = previousKey;
	if (!ownsFixtures) return;
	await db.outreachProspect.deleteMany({ where: { campaignId: OUTREACH.id } });
	await db.outreachCampaign.deleteMany({ where: { id: OUTREACH.id } });
	await db.outreachBudget.deleteMany({ where: { id: budgetId } });
	await db.suppressedDomain.deleteMany({ where: { domain } });
	await db.emailThread.deleteMany({ where: { companyId } });
	await db.company.deleteMany({ where: { id: companyId } });
	await db.user.deleteMany({ where: { id: ownerId } });
	ownsFixtures = false;
});
afterAll(() => {
	sourceSpy.mockRestore();
	fetchSpy.mockRestore();
});

function response(
	cost: number | null = 0.004,
	model = RESEARCH_PROVIDER.model,
) {
	return Response.json({
		model,
		service_tier: "default",
		status: "completed",
		usage:
			cost === null
				? undefined
				: { cost: { currency: "USD", total_cost: cost } },
		output: [
			{
				type: "message",
				role: "assistant",
				status: "completed",
				content: [
					{
						type: "output_text",
						text: JSON.stringify({ candidates: [candidate] }),
					},
				],
			},
		],
	});
}

async function hosted() {
	await db.outreachContactResearch.update({
		where: { prospectId: id },
		data: { submittedCandidates: Prisma.DbNull },
	});
}

test("owner candidate verification spends no model budget and preserves the pilot identity and manual slot", async () => {
	delete process.env.PERPLEXITY_API_KEY;
	await runOutreachContactResearch();
	const row = await db.outreachProspect.findUniqueOrThrow({
		where: { id },
		include: { contactResearch: true },
	});
	expect(row.contactResearch?.status).toBe("READY");
	expect(row.email).toBe(evidence.email);
	expect(row.manual).toBe(true);
	expect(row.pilotSlot).toBe(1);
	expect(row.evidence).toEqual(evidence);
	expect(fetchSpy).not.toHaveBeenCalled();
	expect(await db.outreachBudget.count({ where: { id: budgetId } })).toBe(0);
	await runOutreachContactResearch();
	expect(sourceSpy).toHaveBeenCalledTimes(1);
});

test("hosted people research reserves the shared ledger before one request and reconciles actual usage", async () => {
	await hosted();
	fetchSpy.mockImplementation(async () => {
		expect(
			(await db.outreachBudget.findUniqueOrThrow({ where: { id: budgetId } }))
				.reservedMicroUsd,
		).toBe(OUTREACH.researchReserveMicroUsd);
		return response();
	});
	await runOutreachContactResearch();
	const budget = await db.outreachBudget.findUniqueOrThrow({
		where: { id: budgetId },
	});
	expect(budget.actualMicroUsd).toBe(4000);
	expect(budget.reservedMicroUsd).toBe(4000);
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	expect(
		(
			await db.outreachCampaign.findUniqueOrThrow({
				where: { id: OUTREACH.id },
			})
		).status,
	).toBe("PAUSED");
	expect(await db.outreachDelivery.count({ where: { prospectId: id } })).toBe(
		0,
	);
});

test("budget exhaustion holds people research without dispatch", async () => {
	await hosted();
	await db.outreachBudget.create({
		data: { id: budgetId, reservedMicroUsd: OUTREACH.monthlyMicroUsd },
	});
	await runOutreachContactResearch();
	expect(fetchSpy).not.toHaveBeenCalled();
	expect(
		(
			await db.outreachContactResearch.findUniqueOrThrow({
				where: { prospectId: id },
			})
		).error,
	).toContain("budget reached");
});

test("unknown provider failure retains reservation and does not retry on another tick", async () => {
	await hosted();
	fetchSpy.mockRejectedValue(new Error("Bearer private-request-do-not-log"));
	await runOutreachContactResearch();
	await runOutreachContactResearch();
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	const job = await db.outreachContactResearch.findUniqueOrThrow({
		where: { prospectId: id },
	});
	expect(job.status).toBe("HELD");
	expect(job.error).not.toContain("private-request");
	expect(
		(await db.outreachBudget.findUniqueOrThrow({ where: { id: budgetId } }))
			.reservedMicroUsd,
	).toBe(OUTREACH.researchReserveMicroUsd);
});

test("cost overrun records actual usage and disables both research lanes", async () => {
	await hosted();
	fetchSpy.mockResolvedValue(response(0.06));
	await runOutreachContactResearch();
	expect(
		(await db.outreachBudget.findUniqueOrThrow({ where: { id: budgetId } }))
			.actualMicroUsd,
	).toBe(60000);
	expect(
		(
			await db.outreachCampaign.findUniqueOrThrow({
				where: { id: OUTREACH.id },
			})
		).researchEnabled,
	).toBe(false);
	expect(sourceSpy).not.toHaveBeenCalled();
});

test("concurrent ticks acquire one durable lease", async () => {
	await Promise.all([
		runOutreachContactResearch(),
		runOutreachContactResearch(),
	]);
	expect(sourceSpy).toHaveBeenCalledTimes(1);
	expect(
		(
			await db.outreachContactResearch.findUniqueOrThrow({
				where: { prospectId: id },
			})
		).attempts,
	).toBe(1);
});

test("identity or assignment drift discards a completed source result", async () => {
	sourceSpy.mockImplementation(async () => {
		await db.outreachProspect.update({
			where: { id },
			data: { email: `changed@${domain}` },
		});
		return {
			text: `<div>${candidate.associationQuote}</div>`,
			url: new URL(candidate.sourceUrl),
		};
	});
	await runOutreachContactResearch();
	expect(
		(
			await db.outreachContactResearch.findUniqueOrThrow({
				where: { prospectId: id },
			})
		).candidates,
	).toBeNull();
});

test("failed association saves no candidates", async () => {
	sourceSpy.mockResolvedValue({
		text: "<main><section>Alex Smith Operations Manager</section></main><footer>alex@contact-research-spec.test</footer>",
		url: new URL(candidate.sourceUrl),
	});
	await runOutreachContactResearch();
	expect(
		(
			await db.outreachContactResearch.findUniqueOrThrow({
				where: { prospectId: id },
			})
		).status,
	).toBe("HELD");
});

test("suppression blocks work before source or provider calls", async () => {
	await db.suppressedDomain.create({ data: { domain } });
	await runOutreachContactResearch();
	expect(sourceSpy).not.toHaveBeenCalled();
	expect(fetchSpy).not.toHaveBeenCalled();
});

test("an unverified changed-email HELD row can recover through its valid company binding", async () => {
	await db.outreachProspect.update({
		where: { id },
		data: { status: "HELD", evidence: { ...evidence, verified: false } },
	});
	await runOutreachContactResearch();
	expect(
		(
			await db.outreachContactResearch.findUniqueOrThrow({
				where: { prospectId: id },
			})
		).status,
	).toBe("READY");
	expect(
		(await db.outreachProspect.findUniqueOrThrow({ where: { id } })).status,
	).toBe("HELD");
});

test("new unallocated discovery adopts the best verified target without consent or assignment", async () => {
	await hosted();
	await db.outreachProspect.update({
		where: { id },
		data: { status: "HELD", pilotSlot: null, manual: false },
	});
	fetchSpy.mockResolvedValue(response());
	await runOutreachContactResearch();
	const row = await db.outreachProspect.findUniqueOrThrow({ where: { id } });
	expect(row.email).toBe(candidate.email);
	expect(row.status).toBe("HELD");
	expect(row.pilotSlot).toBeNull();
	expect(row.consent).toBeNull();
	expect(row.contactId).toBeNull();
	expect(evidenceSchema.parse(row.evidence).verified).toBe(false);
	expect(evidenceSchema.parse(row.evidence).contactTarget?.name).toBe(
		candidate.name,
	);
	expect(
		(
			await db.outreachContactResearch.findUniqueOrThrow({
				where: { prospectId: id },
			})
		).status,
	).toBe("SELECTED");
});

test("new discovery with existing CRM conversation requires owner selection", async () => {
	await hosted();
	await db.outreachProspect.update({
		where: { id },
		data: { status: "HELD", pilotSlot: null, manual: false },
	});
	await db.emailThread.create({
		data: {
			rootMessageId: `contact-research-${id}`,
			companyId,
			firstMessageAt: new Date(),
			lastMessageAt: new Date(),
			messageCount: 1,
		},
	});
	fetchSpy.mockResolvedValue(response());
	await runOutreachContactResearch();
	expect(
		(await db.outreachProspect.findUniqueOrThrow({ where: { id } })).email,
	).toBe(evidence.email);
	expect(
		(
			await db.outreachContactResearch.findUniqueOrThrow({
				where: { prospectId: id },
			})
		).status,
	).toBe("READY");
});

test("nonproduction runs do no work", async () => {
	process.env.VERCEL_ENV = "preview";
	await runOutreachContactResearch();
	expect(sourceSpy).not.toHaveBeenCalled();
	expect(fetchSpy).not.toHaveBeenCalled();
});

test("interrupted exhausted jobs recover to a visible hold even after lease cleanup", async () => {
	await db.outreachContactResearch.update({
		where: { prospectId: id },
		data: { status: "RESEARCHING", attempts: 2, leaseUntil: null },
	});
	await runOutreachContactResearch();
	expect(
		(
			await db.outreachContactResearch.findUniqueOrThrow({
				where: { prospectId: id },
			})
		).status,
	).toBe("HELD");
	expect(sourceSpy).not.toHaveBeenCalled();
});

test("suppression arising during verification prevents completion and releases the lease to HELD", async () => {
	sourceSpy.mockImplementation(async () => {
		await db.suppressedDomain.create({ data: { domain } });
		return {
			text: `<div>${candidate.associationQuote}</div>`,
			url: new URL(candidate.sourceUrl),
		};
	});
	await runOutreachContactResearch();
	const job = await db.outreachContactResearch.findUniqueOrThrow({
		where: { prospectId: id },
	});
	expect(job.status).toBe("HELD");
	expect(job.leaseUntil).toBeNull();
	expect(job.candidates).toBeNull();
});
