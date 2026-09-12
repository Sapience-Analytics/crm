import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { db } from "@crm/db";
import {
	DEFAULT_TEMPLATES,
	evidenceSchema,
	OUTREACH,
} from "@crm/validation/outreach";
import { currentDraft } from "@crm/validation/outreach-draft-state";
import {
	DEPARTMENT_QUESTIONS,
	DRAFTING,
	OUTREACH_PRODUCT_CAPABILITIES,
	persistedStageSchema,
} from "@crm/validation/outreach-drafts";
import { z } from "zod";
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
	contactTarget: {
		id: "a".repeat(64),
		kind: "named",
		name: "Alex Example",
		role: "operations",
		roleTitle: "Operations Manager",
		email: "fleet@drafting.example.test",
		sourceUrl: "https://drafting.example.test/contact/",
		associationQuote:
			"Alex Example, Operations Manager, fleet@drafting.example.test",
		employmentQuote: "Alex Example is the Operations Manager at Draft Test.",
		verified: true,
		checkedAt: new Date().toISOString(),
	},
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
		opening:
			stage === 1
				? "For your carting and bulk haulage work, Geotab trip reports show vehicle journeys."
				: stage === 2
					? "One last follow-up about reporting for your carting and bulk haulage work."
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
		text: JSON.stringify(request.phase === "review" ? review : sequence),
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
		if (request.phase === "review") {
			expect(request.maxOutputTokens).toBe(DRAFTING.reviewOutputTokens);
			expect(request.maxOutputTokens).toBe(DRAFTING.maxOutputTokens);
			expect(JSON.parse(request.prompt)).toMatchObject({
				company: evidence.company,
				verifiedSourceQuote: quote,
				approvedTemplates: DEFAULT_TEMPLATES,
			});
		}
		return {
			text: JSON.stringify(request.phase === "review" ? review : sequence),
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

test("generation separates verified recipient, selected contact and approved product evidence", async () => {
	generate.mockImplementation(async (request) => {
		const input = JSON.parse(request.prompt);
		expect(input.approvedProductCapabilities).toEqual(
			OUTREACH_PRODUCT_CAPABILITIES,
		);
		expect(input.selectedContact).toEqual({
			kind: "named",
			name: "Alex Example",
			role: "operations",
			roleTitle: "Operations Manager",
		});
		expect(input.verifiedSourceQuote).toBe(quote);
		if (request.phase === "generation") {
			expect(input.approvedTemplates).toBeUndefined();
			expect(input.policy).toBeUndefined();
			expect(input.departmentQuestions).toBeNull();
			expect(input.generatedSlots).toHaveLength(4);
			expect(input.stageIntents).toHaveLength(3);
			expect(input.stageIntents[1]).toContain(
				"literal phrase trip reports, trip history or maintenance reminders",
			);
			expect(request.instructions).toContain(
				"Attribute company operational facts explicitly to the company by its supplied name",
			);
			expect(request.instructions).toContain(
				"Never turn a company fact into personal control, ownership or companywide responsibility",
			);
			expect(request.instructions).toContain(
				"Never claim prior contact or use phrases such as you shared, you mentioned",
			);
			expect(request.instructions).toContain(
				"Product capabilities come only from approvedProductCapabilities",
			);
			expect(request.instructions).toContain(
				"Trailer-only evidence cannot support engine, fuel or idling use cases",
			);
		} else {
			expect(input.approvedTemplates).toEqual(DEFAULT_TEMPLATES);
			expect(input.stages[0].body).toStartWith("Hi Alex,");
			expect(input.stages[1].body).toContain("Geotab trip reports");
			expect(request.instructions).toContain(
				"A product capability does not require matching recipient-source text",
			);
			expect(request.instructions).toContain(
				"Company operational facts must explicitly name the company",
			);
			expect(request.instructions).toContain(
				"A published job title alone cannot support companywide authority; reject that attribution",
			);
			expect(request.instructions).toContain(
				"Reject any claimed conversation or phrases such as you shared, you mentioned",
			);
			expect(request.instructions).toContain(
				"uses an explicit capability phrase such as trip reports, trip history or maintenance reminders",
			);
		}
		return {
			text: JSON.stringify(request.phase === "review" ? review : sequence),
			costMicroUsd: 3000,
			finishReason: "stop",
		};
	});
	await draftOutreachSequence();
	expect((await record()).emailDraftStatus).toBe("READY");
	expect(generate).toHaveBeenCalledTimes(2);
});

test("department preparation persists the same routing copy that currentDraft validates", async () => {
	const department = evidenceSchema.parse({
		...evidence,
		contactTarget: {
			...evidence.contactTarget,
			kind: "department",
			name: null,
			role: "department",
			roleTitle: "Operations team",
		},
	});
	await db.outreachProspect.update({
		where: { id },
		data: { evidence: department },
	});
	const generated = {
		stages: sequence.stages.map((stage) => ({
			...stage,
			question: DEPARTMENT_QUESTIONS[stage.stage],
		})),
	};
	generate.mockImplementation(async (request) => {
		const input = JSON.parse(request.prompt);
		expect(input.selectedContact.name).toBeNull();
		if (request.phase === "generation")
			expect(input.departmentQuestions).toEqual(DEPARTMENT_QUESTIONS);
		return {
			text: JSON.stringify(request.phase === "review" ? review : generated),
			costMicroUsd: 3000,
			finishReason: "stop",
		};
	});
	await draftOutreachSequence();
	const row = await record();
	const draft = currentDraft(row, DEFAULT_TEMPLATES);
	expect(draft).not.toBeNull();
	for (const stage of draft?.stages ?? []) {
		expect(stage.body).toStartWith("Hi team,\n\n");
		expect(stage.question).toBe(DEPARTMENT_QUESTIONS[stage.stage]);
		expect(stage.body).toContain(stage.question);
	}
	expect(row.emailDrafts).toEqual(draft);
});

async function selectDepartmentForDraftTest() {
	const department = evidenceSchema.parse({
		...evidence,
		contactTarget: {
			...evidence.contactTarget,
			kind: "department",
			name: null,
			role: "department",
			roleTitle: "Operations team",
			associationQuote: "Operations team fleet@drafting.example.test",
			employmentQuote: "Operations team fleet@drafting.example.test",
		},
	});
	await db.outreachProspect.update({
		where: { id },
		data: { evidence: department },
	});
}

const reviewCopySchema = z.object({
	stages: z.array(persistedStageSchema).length(3),
});

test.each(["question", "openingSourceQuote", "questionSourceQuote"])(
	"department assembly rejects malformed generated %s before replacing owned fields",
	async (field) => {
		await selectDepartmentForDraftTest();
		generate.mockResolvedValue({
			text: JSON.stringify({
				stages: sequence.stages.map((stage) => ({ ...stage, [field]: null })),
			}),
			costMicroUsd: 3000,
			finishReason: "stop",
		});
		await draftOutreachSequence();
		expect(generate).toHaveBeenCalledTimes(1);
		expect(await record()).toMatchObject({
			emailDraftStatus: "HELD",
			emailDrafts: null,
			emailDraftError:
				"AI drafting or validation failed. Drafts stay held; no template fallback occurs.",
		});
		expect(await budget()).toMatchObject({
			calls: 1,
			actualMicroUsd: 3000,
			reservedMicroUsd: 3000,
		});
	},
);

test("department generated questions and source placeholders are replaced before review and exact persistence", async () => {
	await selectDepartmentForDraftTest();
	const generated = {
		stages: sequence.stages.map((stage) => ({
			...stage,
			question: `Unused generated question for stage ${stage.stage}.`,
			openingSourceQuote: "Application-bound source reference",
			questionSourceQuote: "A misquoted description of overseas services.",
		})),
	};
	let reviewedStages: z.infer<typeof persistedStageSchema>[] = [];
	generate.mockImplementation(async (request) => {
		if (request.phase === "review") {
			reviewedStages = reviewCopySchema.parse(
				JSON.parse(request.prompt),
			).stages;
			for (const stage of reviewedStages) {
				expect(stage.question).toBe(DEPARTMENT_QUESTIONS[stage.stage]);
				expect(stage.opening).toBe(sequence.stages[stage.stage]?.opening);
				expect(stage.openingSourceQuote).toBe(quote);
				expect(stage.questionSourceQuote).toBe(quote);
				expect(stage.body).toStartWith("Hi team,\n\n");
				expect(stage.body.split("\n\n")).toContain(
					DEPARTMENT_QUESTIONS[stage.stage],
				);
				expect(stage.body).not.toContain("Unused generated question");
			}
		}
		return {
			text: JSON.stringify(request.phase === "review" ? review : generated),
			costMicroUsd: 3000,
			finishReason: "stop",
		};
	});
	await draftOutreachSequence();
	const row = await record();
	const draft = currentDraft(row, DEFAULT_TEMPLATES);
	expect(reviewedStages).toHaveLength(3);
	expect(draft?.stages).toEqual(reviewedStages);
	expect(row.emailDrafts).toEqual(draft);
	expect(row.emailDraftStatus).toBe("READY");
	expect(generate).toHaveBeenCalledTimes(2);
	expect(await budget()).toMatchObject({
		calls: 2,
		actualMicroUsd: 6000,
		reservedMicroUsd: 6000,
	});
});

test.each([0, 1, 2])(
	"department question replacement does not repair a prohibited stage %s opening",
	async (invalidStage) => {
		await selectDepartmentForDraftTest();
		generate.mockResolvedValue({
			text: JSON.stringify({
				stages: sequence.stages.map((stage) => ({
					...stage,
					opening:
						stage.stage === invalidStage
							? "Your vehicles can save $100 every month."
							: stage.opening,
					question: "Unused generated question placeholder.",
					openingSourceQuote: "Application-bound source reference",
					questionSourceQuote: "Application-bound source reference",
				})),
			}),
			costMicroUsd: 3000,
			finishReason: "stop",
		});
		await draftOutreachSequence();
		expect(generate).toHaveBeenCalledTimes(1);
		expect(await record()).toMatchObject({
			emailDraftStatus: "HELD",
			emailDrafts: null,
		});
		expect((await record()).emailDraftError).toContain(
			`Stage ${invalidStage}: AI draft includes a prohibited number`,
		);
		expect(await budget()).toMatchObject({
			calls: 1,
			actualMicroUsd: 3000,
			reservedMicroUsd: 3000,
		});
	},
);

test("named questions stay unchanged while misquoted source references bind to exact verified evidence", async () => {
	const generated = {
		stages: sequence.stages.map((stage) => ({
			...stage,
			openingSourceQuote: "The model supplied an inaccurate source excerpt.",
			questionSourceQuote: "Application-bound source reference",
		})),
	};
	let reviewedStages: z.infer<typeof persistedStageSchema>[] = [];
	generate.mockImplementation(async (request) => {
		if (request.phase === "review") {
			reviewedStages = reviewCopySchema.parse(
				JSON.parse(request.prompt),
			).stages;
			for (const stage of reviewedStages) {
				expect(stage.question).toBe(sequence.stages[stage.stage]?.question);
				expect(stage.openingSourceQuote).toBe(quote);
				expect(stage.questionSourceQuote).toBe(quote);
				expect(stage.body).toStartWith("Hi Alex,\n\n");
			}
		}
		return {
			text: JSON.stringify(request.phase === "review" ? review : generated),
			costMicroUsd: 3000,
			finishReason: "stop",
		};
	});
	await draftOutreachSequence();
	expect(reviewedStages).toHaveLength(3);
	expect(currentDraft(await record(), DEFAULT_TEMPLATES)?.stages).toEqual(
		reviewedStages,
	);
	expect((await record()).emailDraftStatus).toBe("READY");
	expect(generate).toHaveBeenCalledTimes(2);
});

test.each([0, 1, 2])(
	"invalid named stage %s question remains held before semantic review",
	async (invalidStage) => {
		generate.mockResolvedValue({
			text: JSON.stringify({
				stages: sequence.stages.map((stage) => ({
					...stage,
					question:
						stage.stage === invalidStage
							? "This generated question has no ending question mark."
							: stage.question,
					openingSourceQuote: "Application-bound source reference",
					questionSourceQuote: "Application-bound source reference",
				})),
			}),
			costMicroUsd: 3000,
			finishReason: "stop",
		});
		await draftOutreachSequence();
		expect(generate).toHaveBeenCalledTimes(1);
		expect(await record()).toMatchObject({
			emailDraftStatus: "HELD",
			emailDrafts: null,
		});
		expect((await record()).emailDraftError).toContain(
			`Stage ${invalidStage}:`,
		);
		expect((await record()).emailDraftError).toContain(
			"Question must end with '?'",
		);
		expect(await budget()).toMatchObject({
			calls: 1,
			actualMicroUsd: 3000,
			reservedMicroUsd: 3000,
		});
	},
);

test("department semantic rejection still holds the final assembled copy after question and source binding", async () => {
	await selectDepartmentForDraftTest();
	const unsupportedOpening =
		"Draft Test operates trucks in distant overseas markets.";
	const generated = {
		stages: sequence.stages.map((stage) => ({
			...stage,
			opening: stage.stage === 0 ? unsupportedOpening : stage.opening,
			question: "Unused generated question placeholder.",
			openingSourceQuote: "Application-bound source reference",
			questionSourceQuote: "Application-bound source reference",
		})),
	};
	const rejectedReview = {
		...review,
		grounded: false,
		noUnsupportedClaims: false,
		stages: review.stages.map((stage, index) =>
			index === 0 ? { ...stage, opening: false } : stage,
		),
	};
	let reviewedStages: z.infer<typeof persistedStageSchema>[] = [];
	generate.mockImplementation(async (request) => {
		if (request.phase === "review") {
			reviewedStages = reviewCopySchema.parse(
				JSON.parse(request.prompt),
			).stages;
			expect(reviewedStages[0]?.body).toContain(unsupportedOpening);
			for (const stage of reviewedStages) {
				expect(stage.question).toBe(DEPARTMENT_QUESTIONS[stage.stage]);
				expect(stage.body).toContain(stage.question);
				expect(stage.body).not.toContain("Unused generated question");
				expect(stage.openingSourceQuote).toBe(quote);
				expect(stage.questionSourceQuote).toBe(quote);
			}
		}
		return {
			text: JSON.stringify(
				request.phase === "review" ? rejectedReview : generated,
			),
			costMicroUsd: 3000,
			finishReason: "stop",
		};
	});
	const writes = spyOn(process.stderr, "write").mockReturnValue(true);
	try {
		await draftOutreachSequence();
	} finally {
		writes.mockRestore();
	}
	expect(reviewedStages).toHaveLength(3);
	expect(generate).toHaveBeenCalledTimes(2);
	expect(await record()).toMatchObject({
		emailDraftStatus: "HELD",
		emailDrafts: null,
		emailDraftReviewedAt: null,
	});
	expect((await record()).emailDraftError).toBe(
		"AI grounding review rejected: source grounding, unsupported claims, stage 0 opening. Sending stays held.",
	);
	expect(await budget()).toMatchObject({
		calls: 2,
		actualMicroUsd: 6000,
		reservedMicroUsd: 6000,
	});
	expect(await db.outreachDelivery.count({ where: { prospectId: id } })).toBe(
		0,
	);
});

test("missing or mismatched selected contact prevents paid drafting", async () => {
	for (const contactTarget of [
		undefined,
		{ ...evidence.contactTarget, email: "other@drafting.example.test" },
	]) {
		const candidate = evidenceSchema.parse({ ...evidence, contactTarget });
		await db.outreachProspect.update({
			where: { id },
			data: { evidence: candidate, emailDraftDueAt: new Date(0) },
		});
		await draftOutreachSequence();
		expect((await record()).emailDraftStatus).toBe("HELD");
		expect((await record()).emailDrafts).toBeNull();
	}
	expect(generate).not.toHaveBeenCalled();
	expect(
		await db.outreachBudget.findUnique({ where: { id: budgetId } }),
	).toBeNull();
});

test("changed selected contact invalidates exact persisted copy and its preview review", async () => {
	await draftOutreachSequence();
	const row = await record();
	expect(currentDraft(row, DEFAULT_TEMPLATES)).not.toBeNull();
	const changed = evidenceSchema.parse({
		...evidence,
		contactTarget: {
			...evidence.contactTarget,
			name: "Jordan Example",
			associationQuote:
				"Jordan Example, Operations Manager, fleet@drafting.example.test",
		},
	});
	expect(
		currentDraft({ ...row, evidence: changed }, DEFAULT_TEMPLATES),
	).toBeNull();
	const draft = currentDraft(row, DEFAULT_TEMPLATES);
	if (!draft) throw new Error("Expected persisted draft");
	draft.stages[0].body = draft.stages[0].body.replace(
		"Hi Alex,",
		"Hi Someone,",
	);
	expect(
		currentDraft({ ...row, emailDrafts: draft }, DEFAULT_TEMPLATES),
	).toBeNull();
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
			if (request.phase === "review") {
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
				text: JSON.stringify(request.phase === "review" ? review : sequence),
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
			request.phase === "review"
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
	expect((await record()).emailDraftError).toBe(
		"AI grounding review rejected: stage 0 opening. Sending stays held.",
	);
});

test("grounding diagnostics name every rejected fixed flag and preserve the paid-call ledger", async () => {
	generate.mockImplementation(async (request) => ({
		text: JSON.stringify(
			request.phase === "review"
				? {
						grounded: false,
						intentPreserved: false,
						noUnsupportedClaims: false,
						stages: review.stages.map(() => ({
							opening: false,
							question: false,
							intent: false,
						})),
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
		emailDraftError:
			"AI grounding review rejected: source grounding, approved intent, unsupported claims, stage 0 opening, stage 0 question, stage 0 intent, stage 1 opening, stage 1 question, stage 1 intent, stage 2 opening, stage 2 question, stage 2 intent. Sending stays held.",
	});
	expect(await budget()).toMatchObject({
		calls: 2,
		reservedMicroUsd: 6000,
		actualMicroUsd: 6000,
	});
});

test("unrecognized review prose stays hidden instead of entering safe flag diagnostics", async () => {
	generate.mockImplementation(async (request) => ({
		text: JSON.stringify(
			request.phase === "review"
				? { ...review, reason: "private provider prose with Bearer secret" }
				: sequence,
		),
		costMicroUsd: 3000,
		finishReason: "stop",
	}));
	await draftOutreachSequence();
	const row = await record();
	expect(row.emailDraftStatus).toBe("HELD");
	expect(row.emailDraftError).toBe(
		"AI drafting or validation failed. Drafts stay held; no template fallback occurs.",
	);
	expect(row.emailDrafts).toBeNull();
});

test("grounding rejection logs only bounded validated copy and redacts source contact addresses", async () => {
	const sourceQuote = `${quote} Contact private@example.test at https://drafting.example.test/private.`;
	await db.outreachProspect.update({
		where: { id },
		data: { evidence: { ...evidence, sourceQuote } },
	});
	const rejectedReview = { ...review, grounded: false };
	const rejectedSequence = {
		stages: sequence.stages.map((stage) => ({
			...stage,
			openingSourceQuote: sourceQuote,
			questionSourceQuote: sourceQuote,
		})),
	};
	generate.mockImplementation(async (request) => ({
		text: JSON.stringify(
			request.phase === "review" ? rejectedReview : rejectedSequence,
		),
		costMicroUsd: 3000,
		finishReason: "stop",
	}));
	const writes = spyOn(process.stderr, "write").mockReturnValue(true);
	try {
		await draftOutreachSequence();
		expect(writes).toHaveBeenCalledTimes(1);
		const output = String(writes.mock.calls[0][0]);
		const event = JSON.parse(output);
		expect(Object.keys(event).sort()).toEqual([
			"event",
			"inputHash",
			"prospectId",
			"review",
			"stages",
		]);
		expect(event).toMatchObject({
			event: "outreach.grounding_rejected",
			prospectId: id,
			review: rejectedReview,
		});
		expect(event.stages).toHaveLength(3);
		expect(event.stages[0].opening).toBe(sequence.stages[0].opening);
		expect(event.stages[0].question).toBe(sequence.stages[0].question);
		expect(output).not.toContain("private@example.test");
		expect(output).not.toContain("https://drafting.example.test/private");
		expect(output).not.toContain(OUTREACH.sender);
		expect(output).toContain("[redacted]");
		expect(output.length).toBeLessThan(8000);
		expect(await record()).toMatchObject({
			emailDraftStatus: "HELD",
			emailDrafts: null,
			emailDraftReviewedAt: null,
		});
	} finally {
		writes.mockRestore();
	}
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
			request.phase === "reply"
				? "Thank you. Which reporting needs would you like to discuss?"
				: JSON.stringify(request.phase === "review" ? review : sequence),
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

test("non-text catalog entries do not block selected-model drafting or reservation accounting", async () => {
	fetchSpy.mockImplementation(async () =>
		Response.json({
			data: [
				{ id: "image-model", pricing: {} },
				{
					id: "video-model",
					pricing: { video_duration_pricing: [{ duration: 5, price: "0.25" }] },
				},
				{
					id: DRAFTING.model,
					pricing: { input: "0.00000075", output: "0.0000045" },
				},
			],
		}),
	);
	await draftOutreachSequence();
	expect((await record()).emailDraftStatus).toBe("READY");
	expect(await budget()).toMatchObject({
		calls: 2,
		reservedMicroUsd: 6000,
		actualMicroUsd: 6000,
	});
});

test("invalid selected-model pricing blocks calls and cannot create a zero-priced reservation", async () => {
	fetchSpy.mockResolvedValue(
		Response.json({
			data: [
				{ id: DRAFTING.model, pricing: { input: null, output: "0.0000045" } },
			],
		}),
	);
	await draftOutreachSequence();
	expect(generate).not.toHaveBeenCalled();
	expect(await db.outreachBudget.count({ where: { id: budgetId } })).toBe(0);
	expect((await record()).emailDraftError).toContain(
		"token pricing is unavailable",
	);
});

test("catalog HTTP errors expose status only and keep drafting unpaid", async () => {
	fetchSpy.mockResolvedValue(
		new Response("private-body bearer test-secret", { status: 503 }),
	);
	await draftOutreachSequence();
	expect((await record()).emailDraftError).toBe(
		"AI model catalog returned HTTP 503. Drafts stay on hold.",
	);
	expect(generate).not.toHaveBeenCalled();
	expect(await db.outreachBudget.count({ where: { id: budgetId } })).toBe(0);
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

for (const phase of ["generation", "review"] as const)
	test(`truncated ${phase} settles cost and holds all drafts without a resend`, async () => {
		generate.mockImplementation(async (request) => ({
			text:
				request.phase === phase
					? "{partial private provider copy"
					: JSON.stringify(sequence),
			costMicroUsd: 3000,
			finishReason: request.phase === phase ? "length" : "stop",
		}));
		await draftOutreachSequence();
		const calls = phase === "generation" ? 1 : 2;
		expect(await record()).toMatchObject({
			emailDraftError: `AI ${phase} output did not finish normally (length). Drafts stay held.`,
			emailDraftStatus: "HELD",
			emailDrafts: null,
			initialSentAt: null,
			emailDraftLease: null,
		});
		expect(await budget()).toMatchObject({
			calls,
			actualMicroUsd: calls * 3000,
			reservedMicroUsd: calls * 3000,
		});
		expect(await db.outreachDelivery.count({ where: { prospectId: id } })).toBe(
			0,
		);
		await draftOutreachSequence();
		expect(generate).toHaveBeenCalledTimes(calls);
	});

test("other finish reasons expose only the allowed reason and phase, never provider copy", async () => {
	generate.mockImplementation(async (request) => ({
		text:
			request.phase === "review"
				? "Private provider prose with Bearer secret"
				: JSON.stringify(sequence),
		costMicroUsd: 3000,
		finishReason: request.phase === "review" ? "other" : "stop",
	}));
	await draftOutreachSequence();
	expect(await record()).toMatchObject({
		emailDraftError:
			"AI review output did not finish normally (other). Drafts stay held.",
		emailDraftStatus: "HELD",
		emailDrafts: null,
		initialSentAt: null,
	});
	expect(await budget()).toMatchObject({
		calls: 2,
		actualMicroUsd: 6000,
		reservedMicroUsd: 6000,
	});
	expect(await db.outreachDelivery.count({ where: { prospectId: id } })).toBe(
		0,
	);
});

test("input and price bounds reject requests before any reservation", async () => {
	const result = await outreachAiText({
		phase: "generation",
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
