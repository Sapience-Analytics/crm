import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { db } from "@crm/db";
import {
	DEFAULT_TEMPLATES,
	evidenceSchema,
	OUTREACH,
} from "@crm/validation/outreach";
import { currentDraft } from "@crm/validation/outreach-draft-state";
import { DRAFTING } from "@crm/validation/outreach-drafts";
import { gatewayText, outreachAiText } from "../agent/lib/outreach-ai";
import { draftOutreachSequence } from "../agent/lib/outreach-drafts";
import { draftOutreachReply } from "../agent/lib/outreach-replies";

const budgetId = `ai:${new Date().toISOString().slice(0, 7)}`;
const originalEnvironment = process.env.VERCEL_ENV;
const fetchSpy = spyOn(globalThis, "fetch");
const generate = spyOn(gatewayText, "generate");
const quote =
	"Using our side tipper, truck and pig or six wheeler trucks we have the right solution to your carting or bulk haulage needs.";
const evidence = evidenceSchema.parse({
	company: "Draft Test",
	domain: "drafting.example.test",
	email: "fleet@drafting.example.test",
	industry: "transport",
	fleetBand: "unknown",
	fleetEvidence: "unknown",
	fit: "A Western Australian haulage operation using road vehicles.",
	sourceUrl: "https://drafting.example.test/",
	sourceQuote: quote,
	waQuote: "Western Australia",
	verified: true,
	checkedAt: new Date().toISOString(),
});
const consent = {
	kind: "express",
	evidence: "Requested information about Geotab and fleet vehicle reporting.",
	source: "controlled-fixture-request",
	roleRelevant: true,
	noRestriction: true,
	verifiedBy: "draft-test-owner",
	verifiedAt: new Date().toISOString(),
};
const sequence = {
	stages: [0, 1, 2].map((stage) => ({
		stage,
		opening: stage
			? "Following up on your carting and bulk haulage work."
			: "I noticed your carting and bulk haulage services.",
		question:
			stage === 2
				? "Is vehicle reporting useful for that work, or should I leave it here?"
				: "Is there anything you would like to improve about vehicle visibility for that work?",
		openingSourceQuote: quote,
		questionSourceQuote: quote,
	})),
};
const review = {
	grounded: true,
	intentPreserved: true,
	noUnsupportedClaims: true,
	stages: [0, 1, 2].map(() => ({
		opening: true,
		question: true,
		intent: true,
	})),
};
let ownsFixtures = false;
let id = "";

async function record() {
	return db.outreachProspect.findUniqueOrThrow({ where: { id } });
}
async function budget() {
	return db.outreachBudget.findUniqueOrThrow({ where: { id: budgetId } });
}
async function due() {
	await db.outreachProspect.update({
		where: { id },
		data: { emailDraftDueAt: new Date(0) },
	});
}

beforeEach(async () => {
	expect(
		await db.outreachCampaign.findUnique({ where: { id: OUTREACH.id } }),
	).toBeNull();
	expect(
		await db.outreachBudget.findUnique({ where: { id: budgetId } }),
	).toBeNull();
	ownsFixtures = true;
	process.env.VERCEL_ENV = "production";
	await db.outreachCampaign.create({
		data: {
			id: OUTREACH.id,
			ownerId: "draft-test-owner",
			senderEmail: OUTREACH.sender,
			templates: DEFAULT_TEMPLATES,
			status: "PAUSED",
		},
	});
	id = (
		await db.outreachProspect.create({
			data: {
				campaignId: OUTREACH.id,
				domain: evidence.domain,
				email: evidence.email,
				evidence,
				consent,
				status: "READY",
				emailDraftDueAt: new Date(0),
			},
		})
	).id;
	fetchSpy.mockImplementation(async () =>
		Response.json({
			data: [
				{
					id: DRAFTING.model,
					pricing: { input: "0.00000075", output: "0.0000045" },
				},
			],
		}),
	);
	generate.mockImplementation(async (request) => ({
		text: JSON.stringify(
			request.maxOutputTokens === DRAFTING.reviewOutputTokens
				? review
				: sequence,
		),
		costMicroUsd: 3000,
		finishReason: "stop",
	}));
});

afterEach(async () => {
	fetchSpy.mockReset();
	generate.mockReset();
	if (originalEnvironment === undefined) delete process.env.VERCEL_ENV;
	else process.env.VERCEL_ENV = originalEnvironment;
	if (!ownsFixtures) return;
	await db.outreachProspect.deleteMany({ where: { campaignId: OUTREACH.id } });
	await db.outreachCampaign.deleteMany({
		where: { id: OUTREACH.id, ownerId: "draft-test-owner" },
	});
	await db.outreachBudget.deleteMany({ where: { id: budgetId } });
	ownsFixtures = false;
});
afterAll(() => {
	fetchSpy.mockRestore();
	generate.mockRestore();
});

test("reserves before both paid calls and atomically persists three natural drafts while paused", async () => {
	generate.mockImplementation(async (request) => {
		expect((await budget()).reservedMicroUsd).toBeGreaterThanOrEqual(
			OUTREACH.aiReserveMicroUsd,
		);
		expect((await record()).emailDrafts).toBeNull();
		return {
			text: JSON.stringify(
				request.maxOutputTokens === DRAFTING.reviewOutputTokens
					? review
					: sequence,
			),
			costMicroUsd: 3000,
			finishReason: "stop",
		};
	});
	await draftOutreachSequence();
	const row = await record();
	expect(currentDraft(row, DEFAULT_TEMPLATES)?.stages).toHaveLength(3);
	expect(row).toMatchObject({
		emailDraftStatus: "READY",
		emailDraftAttempts: 1,
		emailDraftLease: null,
		pilotSlot: null,
		initialSentAt: null,
		emailDraftReviewedAt: null,
	});
	expect(await budget()).toMatchObject({
		calls: 2,
		reservedMicroUsd: 6000,
		actualMicroUsd: 6000,
	});
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
	await due();
	await draftOutreachSequence();
	expect(generate).toHaveBeenCalledTimes(2);
});

test("manual prospects receive the same three drafts without changing exclusion or allocating slots", async () => {
	await db.outreachProspect.update({
		where: { id },
		data: { manual: true, status: "MANUAL", pilotSlot: 1 },
	});
	await draftOutreachSequence();
	expect(await record()).toMatchObject({
		manual: true,
		status: "MANUAL",
		pilotSlot: 1,
		emailDraftStatus: "READY",
		initialSentAt: null,
	});
});

test("concurrent cloud ticks claim one generation; an expired restart lease is recoverable", async () => {
	await db.outreachProspect.update({
		where: { id },
		data: { emailDraftLease: "abandoned", emailDraftLeaseUntil: new Date(0) },
	});
	await Promise.all([draftOutreachSequence(), draftOutreachSequence()]);
	expect(generate).toHaveBeenCalledTimes(2);
	expect((await record()).emailDraftStatus).toBe("READY");
});

for (const drift of [
	"source",
	"recipient",
	"templates",
	"lease",
	"suppressed",
	"ai-pause",
] as const) {
	test(`${drift} drift during generation cannot commit ready drafts`, async () => {
		generate.mockImplementation(async (request) => {
			if (request.maxOutputTokens === DRAFTING.reviewOutputTokens) {
				if (drift === "templates")
					await db.outreachCampaign.update({
						where: { id: OUTREACH.id },
						data: {
							templates: { ...DEFAULT_TEMPLATES, subject: "Changed intent" },
						},
					});
				else if (drift === "ai-pause")
					await db.outreachCampaign.update({
						where: { id: OUTREACH.id },
						data: { aiPausedReason: "Controlled cost review" },
					});
				else
					await db.outreachProspect.update({
						where: { id },
						data:
							drift === "source"
								? {
										evidence: {
											...evidence,
											sourceQuote: `${quote} Changed evidence.`,
										},
									}
								: drift === "recipient"
									? { email: "changed@drafting.example.test" }
									: drift === "lease"
										? { emailDraftLeaseUntil: new Date(0) }
										: { status: "SUPPRESSED" },
					});
			}
			return {
				text: JSON.stringify(
					request.maxOutputTokens === DRAFTING.reviewOutputTokens
						? review
						: sequence,
				),
				costMicroUsd: 3000,
				finishReason: "stop",
			};
		});
		await draftOutreachSequence();
		expect((await record()).emailDraftStatus).not.toBe("READY");
		expect((await record()).emailDrafts).toBeNull();
	});
}

test("independent grounding rejection holds all stages without template fallback", async () => {
	generate.mockImplementation(async (request) => ({
		text: JSON.stringify(
			request.maxOutputTokens === DRAFTING.reviewOutputTokens
				? {
						...review,
						stages: [
							{ opening: false, question: true, intent: true },
							...review.stages.slice(1),
						],
					}
				: sequence,
		),
		costMicroUsd: 3000,
		finishReason: "stop",
	}));
	await draftOutreachSequence();
	expect(await record()).toMatchObject({
		emailDraftStatus: "HELD",
		emailDrafts: null,
	});
	expect((await record()).emailDraftError).toContain("grounding review");
});

test("unsupported claim fails before the second paid review", async () => {
	generate.mockResolvedValue({
		text: JSON.stringify({
			stages: sequence.stages.map((stage) => ({
				...stage,
				opening: "You have twenty vehicles and can save $100.",
			})),
		}),
		costMicroUsd: 3000,
		finishReason: "stop",
	});
	await draftOutreachSequence();
	expect(generate).toHaveBeenCalledTimes(1);
	expect((await record()).emailDraftStatus).toBe("HELD");
});

test("unknown cost remains reserved, shared reply drafting uses the same monthly ledger", async () => {
	generate.mockImplementation(async (request) => ({
		text:
			request.maxOutputTokens === DRAFTING.replyOutputTokens
				? "Thank you. Which reporting needs would you like to discuss?"
				: JSON.stringify(
						request.maxOutputTokens === DRAFTING.reviewOutputTokens
							? review
							: sequence,
					),
		costMicroUsd: null,
		finishReason: "stop",
	}));
	await draftOutreachSequence();
	await db.outreachProspect.update({
		where: { id },
		data: {
			status: "REPLIED",
			replyText: "Can we discuss fleet reporting?",
			replyDraftDueAt: new Date(0),
		},
	});
	await draftOutreachReply();
	expect(await budget()).toMatchObject({
		calls: 3,
		reservedMicroUsd: 3 * OUTREACH.aiReserveMicroUsd,
		actualMicroUsd: 0,
	});
	expect((await record()).replyDraft).toContain("reporting");
});

test("exhausted budget holds generation without a paid call", async () => {
	await db.outreachBudget.create({
		data: { id: budgetId, reservedMicroUsd: OUTREACH.monthlyMicroUsd },
	});
	await draftOutreachSequence();
	expect(generate).not.toHaveBeenCalled();
	expect((await record()).emailDraftError).toContain("allowance is exhausted");
});

test("actual overrun is reconciled and pauses both sequence and reply AI", async () => {
	generate.mockResolvedValue({
		text: JSON.stringify(sequence),
		costMicroUsd: OUTREACH.aiReserveMicroUsd + 1,
		finishReason: "stop",
	});
	await draftOutreachSequence();
	expect(await budget()).toMatchObject({
		actualMicroUsd: OUTREACH.aiReserveMicroUsd + 1,
		reservedMicroUsd: OUTREACH.aiReserveMicroUsd + 1,
	});
	await due();
	await draftOutreachSequence();
	expect(generate).toHaveBeenCalledTimes(1);
	expect(
		(
			await db.outreachCampaign.findUniqueOrThrow({
				where: { id: OUTREACH.id },
			})
		).aiPausedReason,
	).toContain("cost exceeded");
});

test("failed calls keep reservations and stop after two bounded attempts without leaking errors", async () => {
	generate.mockRejectedValue(new Error("secret request bearer abc-private"));
	await draftOutreachSequence();
	await draftOutreachSequence();
	expect(generate).toHaveBeenCalledTimes(1);
	await due();
	await draftOutreachSequence();
	await due();
	await draftOutreachSequence();
	expect(generate).toHaveBeenCalledTimes(2);
	expect((await record()).emailDraftError).not.toContain("abc-private");
	expect((await record()).emailDraftAttempts).toBe(2);
	expect((await budget()).reservedMicroUsd).toBe(
		2 * OUTREACH.aiReserveMicroUsd,
	);
});

test("truncated output settles cost and reports a fixed output-limit hold", async () => {
	generate.mockResolvedValue({
		text: "{partial",
		costMicroUsd: 3000,
		finishReason: "length",
	});
	await draftOutreachSequence();
	expect((await record()).emailDraftError).toContain("output limit");
	expect((await budget()).actualMicroUsd).toBe(3000);
});

test("input and price bounds reject requests before any reservation", async () => {
	const result = await outreachAiText({
		instructions: "x".repeat(DRAFTING.maxInputBytes + 1),
		prompt: "",
		maxOutputTokens: 100,
	}).then(
		() => "unexpected",
		(error: Error) => error.message,
	);
	expect(result).toContain("bounded");
	expect(fetchSpy).not.toHaveBeenCalled();
	fetchSpy.mockResolvedValue(
		Response.json({
			data: [{ id: DRAFTING.model, pricing: { input: "1", output: "1" } }],
		}),
	);
	await draftOutreachSequence();
	expect(generate).not.toHaveBeenCalled();
	expect(await db.outreachBudget.count({ where: { id: budgetId } })).toBe(0);
});

test("preview environments and unverified prospects cannot make paid calls", async () => {
	process.env.VERCEL_ENV = "preview";
	await draftOutreachSequence();
	process.env.VERCEL_ENV = "production";
	await db.outreachProspect.update({
		where: { id },
		data: { evidence: { ...evidence, verified: false } },
	});
	await draftOutreachSequence();
	expect(fetchSpy).not.toHaveBeenCalled();
	expect(generate).not.toHaveBeenCalled();
});

test("changed inputs after initial delivery hold follow-ups without rewriting the existing draft snapshot", async () => {
	await draftOutreachSequence();
	const prior = await record();
	await db.outreachProspect.update({
		where: { id },
		data: {
			initialSentAt: new Date(),
			status: "ACTIVE",
			email: "changed@drafting.example.test",
			evidence: { ...evidence, email: "changed@drafting.example.test" },
			emailDraftDueAt: new Date(0),
		},
	});
	await draftOutreachSequence();
	expect(generate).toHaveBeenCalledTimes(2);
	expect((await record()).emailDraftStatus).toBe("HELD");
	expect((await record()).emailDrafts).toEqual(prior.emailDrafts);
});
