import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { db, Prisma } from "@crm/db";
import {
	DEFAULT_TEMPLATES,
	evidenceSchema,
	OUTREACH,
} from "@crm/validation/outreach";
import {
	campaignHash,
	draftInputHash,
	draftReviewHash,
} from "@crm/validation/outreach-draft-state";
import {
	DRAFTING,
	draftArtifactSchema,
	groundedSequence,
	PERSONALISATION,
} from "@crm/validation/outreach-drafts";
import { MailboxTokenService } from "../src/mailbox/mailbox-token.service";
import { OutreachService } from "../src/outreach/outreach.service";

const suffix = crypto.randomUUID();
const ownerId = `regenerate-owner-${suffix}`;
const otherId = `regenerate-other-${suffix}`;
const budgetId = `regenerate-budget-${suffix}`;
const domain = `fleet-${suffix}.example.test`;
const mailboxDomain = `parent-${suffix}.example.test`;
const email = `fleet@${mailboxDomain}`;
const now = new Date("2026-09-14T03:00:00.000Z");
const service = new OutreachService(db, new MailboxTokenService(db));
const source = evidenceSchema.parse({
	company: "Regeneration Fleet",
	domain,
	email,
	contactTarget: {
		id: "a".repeat(64),
		kind: "named",
		name: "Alex Example",
		role: "operations",
		roleTitle: "Operations Manager",
		email,
		sourceUrl: `https://${domain}/contact/`,
		associationQuote: `Alex Example, Operations Manager, ${email}`,
		employmentQuote:
			"Alex Example is the Operations Manager at Regeneration Fleet.",
		verified: true,
		checkedAt: now.toISOString(),
	},
	industry: "transport",
	fleetBand: "unknown",
	fleetEvidence: "unknown",
	fit: "Operates delivery vehicles in Western Australia",
	sourceUrl: `https://${domain}`,
	sourceQuote: "We operate delivery vehicles across Perth.",
	waQuote: "Perth",
	checkedAt: now.toISOString(),
	verified: true,
});
let owned = false;
const restores: (() => void)[] = [];

beforeAll(async () => {
	if (
		(await db.outreachCampaign.count()) ||
		(await db.user.findFirst({ where: { email: OUTREACH.sender } }))
	)
		throw new Error("Requires an empty isolated outreach test workspace.");
	await db.user.createMany({
		data: [
			{ id: ownerId, name: "Owner", email: OUTREACH.sender },
			{ id: otherId, name: "Other", email: `other-${suffix}@example.test` },
		],
	});
	owned = true;
});

beforeEach(async () => {
	setSystemTime(now);
	const network = spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("External network is forbidden in regeneration tests"),
	);
	restores.push(() => network.mockRestore());
	await service.initialize(ownerId);
	await db.outreachCampaign.update({
		where: { id: OUTREACH.id },
		data: {
			status: "PILOT",
			approvedHash: campaignHash(DEFAULT_TEMPLATES),
			approvedAt: now,
			readiness: { evidence: "Preserve controlled launch evidence" },
			researchEnabled: true,
		},
	});
	await db.outreachBudget.create({
		data: {
			id: budgetId,
			reservedMicroUsd: 75_000,
			actualMicroUsd: 125_000,
			calls: 3,
		},
	});
});

afterEach(async () => {
	for (const restore of restores.splice(0)) restore();
	setSystemTime();
	if (!owned) return;
	await db.outreachDelivery.deleteMany({
		where: { prospect: { campaignId: OUTREACH.id } },
	});
	await db.outreachProspect.deleteMany({ where: { campaignId: OUTREACH.id } });
	await db.outreachCampaign.deleteMany({
		where: { id: OUTREACH.id, ownerId },
	});
	await db.contact.deleteMany({
		where: { OR: [{ ownerId }, { ownerId: otherId }] },
	});
	await db.company.deleteMany({
		where: { OR: [{ ownerId }, { ownerId: otherId }] },
	});
	await db.outreachSuppression.deleteMany({ where: { email } });
	await db.suppressedContact.deleteMany({ where: { email } });
	await db.suppressedDomain.deleteMany({
		where: { domain: { in: [domain, mailboxDomain] } },
	});
	await db.outreachBudget.deleteMany({ where: { id: budgetId } });
});

afterAll(async () => {
	if (owned)
		await db.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
	await db.$disconnect();
});

async function candidate(manual = false) {
	const company = await db.company.create({
		data: { name: source.company, domain, ownerId },
	});
	const contact = await db.contact.create({
		data: { firstName: email, email, companyId: company.id, ownerId },
	});
	const row = await db.outreachProspect.create({
		data: {
			campaignId: OUTREACH.id,
			companyId: company.id,
			contactId: contact.id,
			domain,
			email,
			evidence: source,
			consent: {
				kind: "express",
				evidence:
					"Explicit request for information about Geotab fleet tracking.",
				source: "test-fixture-request",
				roleRelevant: true,
				noRestriction: true,
				verifiedBy: ownerId,
				verifiedAt: now.toISOString(),
			},
			status: manual ? "MANUAL" : "READY",
			manual,
			pilotSlot: manual ? 1 : 3,
		},
	});
	const hash = draftInputHash(row, DEFAULT_TEMPLATES);
	const artifact = {
		version: PERSONALISATION.version,
		inputHash: hash,
		campaignHash: campaignHash(DEFAULT_TEMPLATES),
		model: DRAFTING.model,
		groundingReviewed: true,
		stages: groundedSequence(
			{
				stages: [0, 1, 2].map((stage) => ({
					stage,
					opening:
						stage === 1
							? "For your delivery work, Geotab trip reports show vehicle journeys."
							: "I noticed your delivery operations across Perth.",
					question:
						stage === 2
							? "Is vehicle visibility useful to discuss for your delivery work, or should I leave it here?"
							: "Is vehicle visibility useful to discuss for your delivery work?",
					openingSourceQuote: source.sourceQuote,
					questionSourceQuote: source.sourceQuote,
				})),
			},
			DEFAULT_TEMPLATES,
			source,
		),
	};
	return db.outreachProspect.update({
		where: { id: row.id },
		data: {
			emailDrafts: artifact,
			emailDraftHash: hash,
			emailDraftStatus: "READY",
			emailDraftAttempts: 2,
			emailDraftError: "Previous safe diagnostic",
		},
	});
}

async function state(id: string) {
	return {
		campaign: await db.outreachCampaign.findUniqueOrThrow({
			where: { id: OUTREACH.id },
		}),
		prospect: await db.outreachProspect.findUniqueOrThrow({ where: { id } }),
		budget: await db.outreachBudget.findUniqueOrThrow({
			where: { id: budgetId },
		}),
		deliveries: await db.outreachDelivery.findMany({
			where: { prospectId: id },
		}),
	};
}

async function rejectsUnchanged(id: string, message: string, userId = ownerId) {
	const before = await state(id);
	const outcome = await service.retryDrafts(userId, id).then(
		() => "Unexpected success",
		(error: Error) => error.message,
	);
	expect(outcome).toContain(message);
	expect(await state(id)).toEqual(before);
}

describe("owner draft regeneration", () => {
	test.each([false, true])(
		"pauses sending and preserves eligibility, assignment and budget for manual=%s",
		async (manual) => {
			const row = await candidate(manual);
			const before = await state(row.id);
			const result = await service.retryDrafts(ownerId, row.id);
			expect(result).toEqual({ ok: true });
			const after = await state(row.id);
			expect(after.campaign).toEqual({ ...before.campaign, status: "PAUSED" });
			expect(after.budget).toEqual(before.budget);
			expect(after.deliveries).toEqual([]);
			expect(after.prospect).toEqual({
				...before.prospect,
				emailDraftStatus: "PENDING",
				emailDraftHash: null,
				emailDrafts: null,
				emailDraftAttempts: 0,
				emailDraftDueAt: now,
				emailDraftError: null,
			});
		},
	);

	test("refuses another signed-in user", async () => {
		const row = await candidate();
		await rejectsUnchanged(row.id, "Only the campaign sender", otherId);
	});

	test("refuses current reviewed previews", async () => {
		const row = await candidate();
		const preview = (await service.prospects(ownerId, 0)).rows[0];
		if (!preview?.draft.reviewHash)
			throw new Error("Expected current previews");
		await service.reviewDrafts(ownerId, row.id, preview.draft.reviewHash);
		await rejectsUnchanged(row.id, "Only unreviewed ready drafts");
	});

	test("regenerates a previously reviewed READY artifact rejected by the new offer guard", async () => {
		const row = await candidate();
		const artifact = draftArtifactSchema.parse(row.emailDrafts);
		const first = artifact.stages[0];
		if (!first) throw new Error("Expected first stage");
		const opening = `${first.opening} I’m Danny from Sapience Analytics.`;
		first.body = first.body.replace(first.opening, opening);
		first.opening = opening;
		await db.outreachProspect.update({
			where: { id: row.id },
			data: {
				emailDrafts: artifact,
				emailDraftReviewedHash: draftReviewHash(artifact),
				emailDraftReviewedAt: now,
			},
		});
		const preview = (await service.prospects(ownerId, 0)).rows[0];
		expect(preview?.draft).toMatchObject({ status: "STALE", reviewedAt: null });
		await service.retryDrafts(ownerId, row.id);
		expect((await state(row.id)).prospect).toMatchObject({
			emailDraftStatus: "PENDING",
			emailDraftReviewedHash: null,
			emailDraftReviewedAt: null,
		});
	});

	test.each(["READY", "HELD", "STALE"])(
		"revokes stale review metadata while retrying %s drafts",
		async (emailDraftStatus) => {
			const row = await candidate();
			await db.outreachProspect.update({
				where: { id: row.id },
				data: {
					emailDraftStatus,
					emailDraftReviewedHash: "0".repeat(64),
					emailDraftReviewedAt: now,
				},
			});
			await service.retryDrafts(ownerId, row.id);
			expect((await state(row.id)).prospect).toMatchObject({
				emailDraftStatus: "PENDING",
				emailDraftReviewedHash: null,
				emailDraftReviewedAt: null,
			});
		},
	);

	test.each([0, 60_000])(
		"refuses an active lease at now + %s",
		async (offset) => {
			const row = await candidate();
			await db.outreachProspect.update({
				where: { id: row.id },
				data: {
					emailDraftLease: "leased-worker",
					emailDraftLeaseUntil: new Date(now.getTime() + offset),
				},
			});
			await rejectsUnchanged(
				row.id,
				"without a delivery or active draft lease",
			);
		},
	);

	test("clears an expired worker lease", async () => {
		const row = await candidate();
		await db.outreachProspect.update({
			where: { id: row.id },
			data: {
				emailDraftLease: "expired-worker",
				emailDraftLeaseUntil: new Date(now.getTime() - 1),
			},
		});
		await service.retryDrafts(ownerId, row.id);
		expect((await state(row.id)).prospect).toMatchObject({
			emailDraftLease: null,
			emailDraftLeaseUntil: null,
		});
	});

	const stopped: [string, Prisma.OutreachProspectUpdateInput][] = [
		["sent", { initialSentAt: now }],
		["active", { status: "ACTIVE" }],
		["suppressed", { status: "SUPPRESSED" }],
		["held eligibility", { status: "HELD" }],
	];
	test.each(stopped)("refuses %s prospects", async (_name, data) => {
		const row = await candidate();
		await db.outreachProspect.update({ where: { id: row.id }, data });
		await rejectsUnchanged(row.id, "Only unsent eligible prospects");
	});

	test.each(["SENDING", "UNKNOWN", "SENT"])(
		"preserves a %s delivery snapshot and blocks regeneration",
		async (status) => {
			const row = await candidate();
			await db.outreachDelivery.create({
				data: {
					prospectId: row.id,
					stage: 0,
					status,
					rfcMessageId: `${crypto.randomUUID()}@example.test`,
					subject: "Immutable delivery subject",
					body: "Immutable delivery body",
					approvalHash: "1".repeat(64),
				},
			});
			await rejectsUnchanged(
				row.id,
				"without a delivery or active draft lease",
			);
		},
	);

	const invalid: [string, Prisma.OutreachProspectUpdateInput][] = [
		["unverified source", { evidence: { ...source, verified: false } }],
		["missing consent", { consent: Prisma.DbNull }],
		["missing binding", { contactId: null }],
		["changed email", { evidence: { ...source, email: "other@example.test" } }],
	];
	test.each(invalid)("refuses %s", async (_name, data) => {
		const row = await candidate();
		await db.outreachProspect.update({ where: { id: row.id }, data });
		await rejectsUnchanged(row.id, "required");
	});

	test.each(["archived", "other owner", "other company"])(
		"refuses a contact with %s binding",
		async (problem) => {
			const row = await candidate();
			if (!row.contactId) throw new Error("Expected contact binding");
			await db.contact.update({
				where: { id: row.contactId },
				data:
					problem === "archived"
						? { archivedAt: now }
						: problem === "other owner"
							? { ownerId: otherId }
							: { companyId: null },
			});
			await rejectsUnchanged(row.id, "no longer matches");
		},
	);

	test.each(["outreach", "contact", "company domain", "mailbox domain"])(
		"refuses %s suppression",
		async (kind) => {
			const row = await candidate();
			if (kind === "outreach")
				await db.outreachSuppression.create({
					data: { email, reason: "SUPPRESSED" },
				});
			else if (kind === "contact")
				await db.suppressedContact.create({ data: { email } });
			else
				await db.suppressedDomain.create({
					data: { domain: kind === "company domain" ? domain : mailboxDomain },
				});
			await rejectsUnchanged(row.id, "This address is suppressed");
		},
	);
});
