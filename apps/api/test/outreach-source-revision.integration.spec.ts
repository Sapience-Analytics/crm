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
import { db, type Prisma } from "@crm/db";
import { DEFAULT_TEMPLATES, OUTREACH } from "@crm/validation/outreach";
import { campaignHash } from "@crm/validation/outreach-draft-state";
import {
	OUTREACH_INTAKE,
	reviseSourceQuoteInput,
} from "@crm/validation/outreach-intake";
import { MailboxTokenService } from "../src/mailbox/mailbox-token.service";
import { OutreachService } from "../src/outreach/outreach.service";
import { OutreachIntakeService } from "../src/outreach/outreach-intake.service";

const suffix = crypto.randomUUID();
const ownerId = `quote-owner-${suffix}`;
const otherId = `quote-other-${suffix}`;
const budgetId = `quote-budget-${suffix}`;
const domain = `fleet-${suffix}.example.test`;
const mailboxDomain = `parent-${suffix}.example.test`;
const email = `fleet@${mailboxDomain}`;
const now = new Date("2026-09-14T03:00:00.000Z");
const revisedQuote =
	"We provide road haulage and delivery services across Perth.";
const outreach = new OutreachService(db, new MailboxTokenService(db));
const service = new OutreachIntakeService(db, outreach);
const restores: (() => void)[] = [];
let owned = false;

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
		new Error("External network is forbidden in source revision tests"),
	);
	restores.push(() => network.mockRestore());
	await outreach.initialize(ownerId);
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
			actualMicroUsd: 50_000,
			calls: 2,
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
	await db.outreachCampaign.deleteMany({ where: { id: OUTREACH.id, ownerId } });
	await db.contact.deleteMany({ where: { ownerId } });
	await db.company.deleteMany({ where: { ownerId } });
	await db.outreachBudget.deleteMany({ where: { id: budgetId } });
	await db.outreachSuppression.deleteMany({ where: { email } });
	await db.suppressedContact.deleteMany({ where: { email } });
	await db.suppressedDomain.deleteMany({
		where: { domain: { in: [domain, mailboxDomain] } },
	});
});

afterAll(async () => {
	if (owned)
		await db.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
	await db.$disconnect();
});

async function candidate(manual = false, verified = true) {
	const company = await db.company.create({
		data: { name: "Quote Fleet", domain, ownerId },
	});
	const contact = await db.contact.create({
		data: { firstName: email, email, companyId: company.id, ownerId },
	});
	const evidence = {
		company: company.name,
		domain,
		email,
		industry: "transport",
		fleetBand: "unknown",
		fleetEvidence: "No verified vehicle count",
		fit: "Operates road vehicles in Western Australia",
		sourceUrl: `https://${domain}/services`,
		sourceQuote: "We operate delivery vehicles across Perth.",
		waQuote: "Perth",
		contactSourceUrl: `https://${domain}/contact`,
		contactRoleQuote: "Fleet Manager",
		checkedAt: "2026-09-13T03:00:00.000Z",
		verified,
		researchNotes: { preserved: true, source: "existing-research" },
	};
	const prospect = await db.outreachProspect.create({
		data: {
			campaignId: OUTREACH.id,
			companyId: company.id,
			contactId: contact.id,
			domain,
			email,
			evidence,
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
			sourceVerificationAttempts: 3,
			sourceVerificationDueAt: null,
			sourceVerificationLease: "expired-source-lease",
			sourceVerificationLeaseUntil: new Date(now.getTime() - 1),
			emailDrafts: {
				stages: [0, 1, 2].map((stage) => ({
					stage,
					subject: "Existing preview",
					body: "Existing reviewed preview",
				})),
			},
			emailDraftHash: "a".repeat(64),
			emailDraftStatus: "READY",
			emailDraftAttempts: 2,
			emailDraftLease: "expired-draft-lease",
			emailDraftLeaseUntil: new Date(now.getTime() - 1),
			emailDraftError: "Previous safe diagnostic",
			emailDraftModel: OUTREACH.replyModel,
			emailDraftGeneratedAt: now,
			emailDraftReviewedHash: "b".repeat(64),
			emailDraftReviewedAt: now,
			stopReason: "Previous verification result",
		},
	});
	return { prospect, evidence };
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
		companies: await db.company.findMany({ where: { ownerId } }),
		contacts: await db.contact.findMany({ where: { ownerId } }),
	};
}

async function rejectsUnchanged(id: string, message: string, userId = ownerId) {
	const before = await state(id);
	const outcome = await service
		.reviseSourceQuote(userId, { id, sourceQuote: revisedQuote })
		.then(
			() => "Unexpected success",
			(error: Error) => error.message,
		);
	expect(outcome).toContain(message);
	expect(await state(id)).toEqual(before);
}

describe("owner source quote revision", () => {
	test.each([
		{ manual: false, verified: true },
		{ manual: true, verified: true },
		{ manual: false, verified: false },
		{ manual: true, verified: false },
	])(
		"preserves assignment and identity while queuing a recheck: %j",
		async ({ manual, verified }) => {
			const { prospect, evidence } = await candidate(manual, verified);
			const before = await state(prospect.id);
			const result = await service.reviseSourceQuote(ownerId, {
				id: prospect.id,
				sourceQuote: revisedQuote,
			});
			expect(result).toEqual({ ok: true });
			const after = await state(prospect.id);
			expect(after).toEqual({
				...before,
				campaign: { ...before.campaign, status: "PAUSED" },
				prospect: {
					...before.prospect,
					evidence: { ...evidence, sourceQuote: revisedQuote, verified: false },
					stopReason: OUTREACH_INTAKE.revisionReason,
					sourceVerificationAttempts: 0,
					sourceVerificationDueAt: now,
					sourceVerificationLease: null,
					sourceVerificationLeaseUntil: null,
					emailDrafts: null,
					emailDraftHash: null,
					emailDraftStatus: "PENDING",
					emailDraftAttempts: 0,
					emailDraftDueAt: now,
					emailDraftLease: null,
					emailDraftLeaseUntil: null,
					emailDraftError: null,
					emailDraftModel: null,
					emailDraftGeneratedAt: null,
					emailDraftReviewedHash: null,
					emailDraftReviewedAt: null,
				},
			});
		},
	);

	test("refuses another signed-in user", async () => {
		const { prospect } = await candidate();
		await rejectsUnchanged(prospect.id, "Only the campaign sender", otherId);
	});

	const blocked: [string, Prisma.OutreachProspectUpdateInput][] = [
		["sent", { initialSentAt: now }],
		["stopped READY", { stoppedAt: now }],
		["stopped MANUAL", { status: "MANUAL", manual: true, stoppedAt: now }],
		["active", { status: "ACTIVE" }],
		["suppressed", { status: "SUPPRESSED" }],
		["replied", { status: "REPLIED" }],
		["bounced", { status: "BOUNCED" }],
		["completed", { status: "COMPLETED" }],
		["unqualified", { status: "HELD" }],
		[
			"active source lease",
			{ sourceVerificationLeaseUntil: new Date(now.getTime() + 60_000) },
		],
		["source lease boundary", { sourceVerificationLeaseUntil: now }],
		[
			"active draft lease",
			{ emailDraftLeaseUntil: new Date(now.getTime() + 60_000) },
		],
		["draft lease boundary", { emailDraftLeaseUntil: now }],
	];
	test.each(blocked)(
		"refuses %s without altering data",
		async (_name, data) => {
			const { prospect } = await candidate();
			await db.outreachProspect.update({ where: { id: prospect.id }, data });
			await rejectsUnchanged(prospect.id, "Only unsent eligible prospects");
		},
	);

	test.each(["SENDING", "UNKNOWN", "SENT"])(
		"preserves a %s delivery snapshot",
		async (status) => {
			const { prospect } = await candidate();
			await db.outreachDelivery.create({
				data: {
					prospectId: prospect.id,
					stage: 0,
					status,
					rfcMessageId: `${crypto.randomUUID()}@example.test`,
					subject: "Immutable delivery subject",
					body: "Immutable delivery body",
					approvalHash: "c".repeat(64),
				},
			});
			await rejectsUnchanged(prospect.id, "without a stop, delivery");
		},
	);

	test.each(["outreach", "contact", "company domain", "mailbox domain"])(
		"refuses %s suppression",
		async (kind) => {
			const { prospect } = await candidate();
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
			await rejectsUnchanged(prospect.id, "This address is suppressed");
		},
	);

	test.each(["domain", "email"])(
		"refuses an existing %s identity mismatch",
		async (field) => {
			const { prospect, evidence } = await candidate();
			await db.outreachProspect.update({
				where: { id: prospect.id },
				data: {
					evidence: {
						...evidence,
						[field]:
							field === "domain" ? "other.example.test" : "other@example.test",
					},
				},
			});
			await rejectsUnchanged(prospect.id, "existing source record must match");
		},
	);

	test("rejects arbitrary evidence and identity changes at the action boundary", async () => {
		const { prospect } = await candidate();
		const before = await state(prospect.id);
		const injected = {
			id: prospect.id,
			sourceQuote: revisedQuote,
			sourceUrl: "https://other.example.test",
			verified: true,
			contactId: "other-contact",
		};
		const outcome = await service.reviseSourceQuote(ownerId, injected).then(
			() => "unexpected",
			() => "rejected",
		);
		expect(outcome).toBe("rejected");
		expect(await state(prospect.id)).toEqual(before);
	});

	test("keeps the source quote bounds and trims surrounding whitespace", () => {
		for (const sourceQuote of ["short", " ".repeat(25), "x".repeat(601)])
			expect(
				reviseSourceQuoteInput.safeParse({ id: "test", sourceQuote }).success,
			).toBe(false);
		expect(
			reviseSourceQuoteInput.parse({
				id: "test",
				sourceQuote: `  ${revisedQuote}  `,
			}).sourceQuote,
		).toBe(revisedQuote);
	});
});
