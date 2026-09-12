import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { db } from "@crm/db";
import { DEFAULT_TEMPLATES, OUTREACH } from "@crm/validation/outreach";
import { runOutreachResearch } from "../agent/lib/outreach-research";
import { RESEARCH_PROVIDER } from "../agent/lib/outreach-research-config";

const fetchSpy = spyOn(globalThis, "fetch");
const originalEnvironment = process.env.VERCEL_ENV;
const originalKey = process.env.PERPLEXITY_API_KEY;
const budgetId = `research:${new Date().toISOString().slice(0, 7)}`;
let ownsFixtures = false;

async function clear() {
	if (!ownsFixtures) return;
	await db.outreachProspect.deleteMany({ where: { campaignId: OUTREACH.id } });
	await db.outreachCampaign.deleteMany({ where: { id: OUTREACH.id } });
	await db.outreachBudget.deleteMany({ where: { id: budgetId } });
	await db.company.deleteMany({
		where: { domain: "research-provider-spec.test" },
	});
	ownsFixtures = false;
}

beforeEach(async () => {
	expect(
		await db.outreachCampaign.findUnique({ where: { id: OUTREACH.id } }),
	).toBeNull();
	expect(
		await db.outreachBudget.findUnique({ where: { id: budgetId } }),
	).toBeNull();
	expect(
		await db.company.findFirst({
			where: { domain: "research-provider-spec.test" },
		}),
	).toBeNull();
	ownsFixtures = true;
	process.env.VERCEL_ENV = "production";
	process.env.PERPLEXITY_API_KEY = "controlled-research-test";
	await db.outreachCampaign.create({
		data: {
			id: OUTREACH.id,
			ownerId: "research-spec-owner",
			senderEmail: OUTREACH.sender,
			templates: DEFAULT_TEMPLATES,
			status: "PAUSED",
			researchEnabled: true,
			researchDueAt: new Date(Date.now() - 1000),
		},
	});
});

afterEach(async () => {
	fetchSpy.mockReset();
	if (originalEnvironment === undefined) delete process.env.VERCEL_ENV;
	else process.env.VERCEL_ENV = originalEnvironment;
	if (originalKey === undefined) delete process.env.PERPLEXITY_API_KEY;
	else process.env.PERPLEXITY_API_KEY = originalKey;
	await clear();
});
afterAll(() => fetchSpy.mockRestore());

function response(cost: number, model: string = RESEARCH_PROVIDER.model) {
	return Response.json({
		model,
		status: "completed",
		service_tier: "default",
		usage: { cost: { currency: "USD", total_cost: cost } },
		output: [
			{
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: '{"prospects":[]}' }],
			},
		],
	});
}

test("reserves before dispatch and settles actual usage while keeping outreach paused", async () => {
	fetchSpy.mockImplementation(async () => {
		const budget = await db.outreachBudget.findUniqueOrThrow({
			where: { id: budgetId },
		});
		expect(budget.reservedMicroUsd).toBe(50_000);
		return response(0.00347);
	});
	await runOutreachResearch();
	const budget = await db.outreachBudget.findUniqueOrThrow({
		where: { id: budgetId },
	});
	expect(budget).toMatchObject({
		reservedMicroUsd: 3470,
		actualMicroUsd: 3470,
		calls: 1,
	});
	const campaign = await db.outreachCampaign.findUniqueOrThrow({
		where: { id: OUTREACH.id },
	});
	expect(campaign).toMatchObject({
		status: "PAUSED",
		researchEnabled: true,
		researchLease: null,
		lastResearchError: null,
	});
	expect(campaign.lastResearchAt).not.toBeNull();
});

test("budget exhaustion prevents any provider request", async () => {
	await db.outreachBudget.create({
		data: { id: budgetId, reservedMicroUsd: OUTREACH.monthlyMicroUsd },
	});
	await runOutreachResearch();
	expect(fetchSpy).not.toHaveBeenCalled();
	const campaign = await db.outreachCampaign.findUniqueOrThrow({
		where: { id: OUTREACH.id },
	});
	expect(campaign.lastResearchError).toContain("US$10 research budget reached");
});

test("ambiguous network failure retains its reservation without immediate retry", async () => {
	fetchSpy.mockRejectedValue(new Error("Controlled network timeout"));
	await runOutreachResearch();
	await runOutreachResearch();
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	const budget = await db.outreachBudget.findUniqueOrThrow({
		where: { id: budgetId },
	});
	expect(budget).toMatchObject({
		reservedMicroUsd: 50_000,
		actualMicroUsd: 0,
		calls: 1,
	});
});

test("observed price overrun settles and disables future research", async () => {
	fetchSpy.mockResolvedValue(response(0.06));
	await runOutreachResearch();
	const budget = await db.outreachBudget.findUniqueOrThrow({
		where: { id: budgetId },
	});
	expect(budget).toMatchObject({
		reservedMicroUsd: 60_000,
		actualMicroUsd: 60_000,
	});
	const campaign = await db.outreachCampaign.findUniqueOrThrow({
		where: { id: OUTREACH.id },
	});
	expect(campaign.researchEnabled).toBe(false);
	expect(campaign.lastResearchError).toContain("cost exceeds its reservation");
	await runOutreachResearch();
	expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("unexpected model disables future research without saving prospects", async () => {
	fetchSpy.mockResolvedValue(response(0.003, "unexpected/model"));
	await runOutreachResearch();
	const campaign = await db.outreachCampaign.findUniqueOrThrow({
		where: { id: OUTREACH.id },
	});
	expect(campaign.researchEnabled).toBe(false);
	expect(campaign.lastResearchError).toContain("changed the requested model");
	expect(await db.outreachProspect.count()).toBe(0);
});

test("preview does not claim or dispatch cloud research", async () => {
	process.env.VERCEL_ENV = "preview";
	await runOutreachResearch();
	expect(fetchSpy).not.toHaveBeenCalled();
	expect(await db.outreachBudget.count({ where: { id: budgetId } })).toBe(0);
});

test("discovery holds unverifiable contacts and never stores an unverified fleet count or overwrites company fields", async () => {
	const company = await db.company.create({
		data: { name: "Human company name", domain: "research-provider-spec.test" },
	});
	const candidate = {
		company: "AI company name",
		domain: "research-provider-spec.test",
		email: null,
		industry: "transport",
		fleetBand: "11–50",
		fleetEvidence: "They operate 17 road vehicles.",
		fit: "A Western Australian delivery fleet for further investigation",
		sourceUrl: "https://127.0.0.1/fleet",
		sourceQuote: "We operate delivery vehicles across Perth.",
		waQuote: "Perth, Western Australia",
	};
	fetchSpy.mockResolvedValue(
		Response.json({
			model: RESEARCH_PROVIDER.model,
			status: "completed",
			service_tier: "default",
			usage: { cost: { currency: "USD", total_cost: 0.003 } },
			output: [
				{
					type: "message",
					role: "assistant",
					status: "completed",
					content: [
						{
							type: "output_text",
							text: JSON.stringify({ prospects: [candidate] }),
						},
					],
				},
			],
		}),
	);
	await runOutreachResearch();
	const saved = await db.outreachProspect.findUniqueOrThrow({
		where: { domain: candidate.domain },
	});
	expect(saved).toMatchObject({
		status: "HELD",
		consent: null,
		pilotSlot: null,
		companyId: company.id,
	});
	expect(saved.evidence).toMatchObject({
		verified: false,
		fleetBand: "unknown",
		fleetEvidence: "unknown",
	});
	expect(
		(await db.company.findUniqueOrThrow({ where: { id: company.id } })).name,
	).toBe("Human company name");
	expect(fetchSpy).toHaveBeenCalledTimes(1);
});
