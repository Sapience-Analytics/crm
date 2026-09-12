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
import { evidenceSchema, OUTREACH } from "@crm/validation/outreach";
import { contactResearchInputHash } from "@crm/validation/outreach-contact-state";
import { verifiedContactCandidateSchema } from "@crm/validation/outreach-contact-target";
import {
	CONTACT_RESEARCH,
	queueContactResearchInput,
	selectContactInput,
} from "@crm/validation/outreach-contacts";
import { z } from "zod";
import { MailboxTokenService } from "../src/mailbox/mailbox-token.service";
import { OutreachService } from "../src/outreach/outreach.service";
import { OutreachContactsService } from "../src/outreach/outreach-contacts.service";

const suffix = crypto.randomUUID();
const ownerId = `contact-research-owner-${suffix}`;
const otherId = `contact-research-other-${suffix}`;
const domain = `fleet-${suffix}.example.test`;
const oldDomain = `old-${suffix}.example.test`;
const newDomain = `new-${suffix}.example.test`;
const email = `fleet@${oldDomain}`;
const selectedEmail = `operations@${newDomain}`;
const now = new Date("2026-09-14T03:00:00.000Z");
const outreach = new OutreachService(db, new MailboxTokenService(db));
const service = new OutreachContactsService(db, outreach);
const restores: (() => void)[] = [];
let owned = false;

function target(address: string | null = selectedEmail) {
	return verifiedContactCandidateSchema.parse({
		id: "a".repeat(64),
		kind: "named",
		name: "Alex Example",
		role: "operations",
		roleTitle: "Operations Manager",
		email: address,
		sourceUrl: `https://${domain}/team`,
		associationQuote: `Alex Example, Operations Manager, ${address ?? "no published email"}`,
		employmentQuote: "Alex Example is our current Operations Manager.",
		verified: true,
		checkedAt: now.toISOString(),
	});
}

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
		new Error("External network is forbidden in contact API tests"),
	);
	restores.push(() => network.mockRestore());
	await outreach.initialize(ownerId);
	await db.outreachCampaign.update({
		where: { id: OUTREACH.id },
		data: { status: "PILOT", approvedHash: "approved-rules", approvedAt: now },
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
	await db.contact.deleteMany({
		where: { ownerId: { in: [ownerId, otherId] } },
	});
	await db.company.deleteMany({
		where: { ownerId: { in: [ownerId, otherId] } },
	});
	await db.outreachSuppression.deleteMany({
		where: { email: { in: [email, selectedEmail] } },
	});
	await db.suppressedContact.deleteMany({
		where: { email: { in: [email, selectedEmail] } },
	});
	await db.suppressedDomain.deleteMany({
		where: { domain: { in: [domain, oldDomain, newDomain] } },
	});
});

afterAll(async () => {
	if (owned)
		await db.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
	await db.$disconnect();
});

async function fixture(manual = false) {
	const company = await db.company.create({
		data: { name: "Example Fleet", domain, ownerId },
	});
	const contact = await db.contact.create({
		data: { firstName: email, email, companyId: company.id, ownerId },
	});
	return db.outreachProspect.create({
		data: {
			campaignId: OUTREACH.id,
			domain,
			email,
			companyId: company.id,
			contactId: contact.id,
			status: manual ? "MANUAL" : "READY",
			manual,
			pilotSlot: manual ? 1 : 3,
			evidence: {
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
				checkedAt: now.toISOString(),
				verified: true,
				researchNotes: { keep: true },
			},
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
			emailDrafts: { saved: "existing draft artifact" },
			emailDraftHash: "b".repeat(64),
			emailDraftStatus: "READY",
			emailDraftReviewedHash: "c".repeat(64),
			emailDraftReviewedAt: now,
		},
	});
}

async function ready(id: string, candidate = target()) {
	const prospect = await db.outreachProspect.findUniqueOrThrow({
		where: { id },
	});
	return db.outreachContactResearch.create({
		data: {
			prospectId: id,
			status: "READY",
			inputHash: contactResearchInputHash(prospect),
			candidates: [candidate],
			completedAt: now,
			dueAt: null,
		},
	});
}

async function state(id: string) {
	return {
		campaign: await db.outreachCampaign.findUniqueOrThrow({
			where: { id: OUTREACH.id },
		}),
		prospect: await db.outreachProspect.findUniqueOrThrow({ where: { id } }),
		job: await db.outreachContactResearch.findUnique({
			where: { prospectId: id },
		}),
		contacts: await db.contact.findMany({
			where: { ownerId: { in: [ownerId, otherId] } },
		}),
		companies: await db.company.findMany({
			where: { ownerId: { in: [ownerId, otherId] } },
		}),
		deliveries: await db.outreachDelivery.findMany({
			where: { prospectId: id },
		}),
	};
}

async function rejectsUnchanged(
	id: string,
	action: "research" | "select",
	message: string,
	userId = ownerId,
) {
	const before = await state(id);
	const outcome = await (action === "research"
		? service.research(userId, { id })
		: service.select(userId, { id, candidateId: target().id })
	).then(
		() => "Unexpected success",
		(error: Error) => error.message,
	);
	expect(outcome).toContain(message);
	expect(await state(id)).toEqual(before);
}

describe("owner contact research and selection", () => {
	test("status reads do not create research or change the prospect", async () => {
		const prospect = await fixture();
		const before = await state(prospect.id);
		expect(await service.status(ownerId, { id: prospect.id })).toEqual({
			status: "NOT_STARTED",
			candidates: [],
			completedAt: null,
			error: null,
		});
		expect(await state(prospect.id)).toEqual(before);
	});
	test("queues durable research without altering existing identity, consent or previews", async () => {
		const prospect = await fixture(true);
		const before = await state(prospect.id);
		await service.research(ownerId, { id: prospect.id });
		const after = await state(prospect.id);
		expect(after.prospect).toEqual(before.prospect);
		expect(after.contacts).toEqual(before.contacts);
		expect(after.companies).toEqual(before.companies);
		expect(after.campaign.status).toBe("PAUSED");
		expect(after.campaign.approvedHash).toBe(before.campaign.approvedHash);
		expect(after.job?.status).toBe("PENDING");
		expect(after.job?.inputHash).toBe(contactResearchInputHash(prospect));
		expect(after.job?.candidates).toBeNull();
	});

	test("rejects contact research before initial company source verification", async () => {
		const prospect = await fixture();
		await db.outreachProspect.update({
			where: { id: prospect.id },
			data: { companyId: null, contactId: null },
		});
		await rejectsUnchanged(
			prospect.id,
			"research",
			"Verify the company source",
		);
	});

	test("allows recovery research for an unverified HELD contact with an existing company binding", async () => {
		const prospect = await fixture();
		await db.outreachProspect.update({
			where: { id: prospect.id },
			data: {
				status: "HELD",
				evidence: {
					...evidenceSchema.parse(prospect.evidence),
					verified: false,
				},
			},
		});
		const before = await state(prospect.id);
		await service.research(ownerId, { id: prospect.id });
		const after = await state(prospect.id);
		expect(after.prospect).toEqual(before.prospect);
		expect(after.job?.status).toBe("PENDING");
	});

	test("owner supplied candidates stay unverified and cannot be selected", async () => {
		const prospect = await fixture();
		const input = queueContactResearchInput.parse({
			id: prospect.id,
			candidates: [
				{
					kind: "named",
					name: "Alex Example",
					role: "operations",
					roleTitle: "Operations Manager",
					email,
					sourceUrl: `https://${domain}/team`,
					associationQuote: "Alex Example is our Operations Manager.",
					employmentQuote: "Alex Example works at Example Fleet.",
				},
			],
		});
		await service.research(ownerId, input);
		const after = await state(prospect.id);
		expect(after.job?.submittedCandidates).toEqual(input.candidates);
		expect(after.job?.candidates).toBeNull();
		await rejectsUnchanged(
			prospect.id,
			"select",
			"Current completed contact research",
		);
	});

	test.each([false, true])(
		"changed email clears consent but preserves manual=%s and pilot assignment",
		async (manual) => {
			const prospect = await fixture(manual);
			await ready(prospect.id);
			const before = await state(prospect.id);
			await service.select(ownerId, {
				id: prospect.id,
				candidateId: target().id,
			});
			const after = await state(prospect.id);
			expect(after.prospect.email).toBe(selectedEmail);
			expect(after.job?.status).toBe("SELECTED");
			expect(after.job?.candidates).toEqual(before.job?.candidates);
			const status = await service.status(ownerId, { id: prospect.id });
			expect(status.status).toBe("SELECTED");
			expect(status.error).toBeNull();
			expect(after.prospect.contactId).toBeNull();
			expect(after.prospect.companyId).toBe(prospect.companyId);
			expect(after.prospect.consent).toBeNull();
			expect(after.prospect.status).toBe("HELD");
			expect(after.prospect.manual).toBe(manual);
			expect(after.prospect.pilotSlot).toBe(prospect.pilotSlot);
			expect(after.prospect.emailDrafts).toBeNull();
			expect(after.prospect.emailDraftReviewedHash).toBeNull();
			expect(after.prospect.sourceVerificationDueAt).toEqual(now);
			expect(after.prospect.evidence).toEqual({
				...evidenceSchema.catchall(z.json()).parse(prospect.evidence),
				email: selectedEmail,
				contactTarget: target(),
				verified: false,
				contactSourceUrl: target().sourceUrl,
				contactRoleQuote: target().associationQuote,
			});
			expect(after.contacts).toEqual(before.contacts);
			expect(after.companies).toEqual(before.companies);
			expect(after.deliveries).toEqual([]);
		},
	);

	test.each([false, true])(
		"same-email named enrichment keeps consent and manual=%s status",
		async (manual) => {
			const prospect = await fixture(manual);
			await ready(prospect.id, target(email));
			await service.select(ownerId, {
				id: prospect.id,
				candidateId: target().id,
			});
			const after = await state(prospect.id);
			expect(after.prospect.consent).toEqual(prospect.consent);
			expect(after.job?.status).toBe("SELECTED");
			expect((await service.status(ownerId, { id: prospect.id })).status).toBe(
				"SELECTED",
			);
			expect(after.prospect.status).toBe(prospect.status);
			expect(after.prospect.contactId).toBe(prospect.contactId);
			expect(after.prospect.emailDrafts).toBeNull();
			expect(after.prospect.emailDraftReviewedHash).toBeNull();
			expect(evidenceSchema.parse(after.prospect.evidence).verified).toBe(
				false,
			);
		},
	);

	test.each(["research", "select"] as const)(
		"%s is owner-only",
		async (action) => {
			const prospect = await fixture();
			await ready(prospect.id);
			await rejectsUnchanged(
				prospect.id,
				action,
				"Only the campaign sender",
				otherId,
			);
			const denied = await service.status(otherId, { id: prospect.id }).then(
				() => false,
				() => true,
			);
			expect(denied).toBe(true);
		},
	);

	const blocked: [string, Prisma.OutreachProspectUpdateInput][] = [
		["sent", { initialSentAt: now }],
		["stopped", { stoppedAt: now }],
		["active", { status: "ACTIVE" }],
		["suppressed", { status: "SUPPRESSED" }],
		["replied", { status: "REPLIED" }],
		["bounced", { status: "BOUNCED" }],
		["booked", { status: "BOOKED" }],
		["complete", { status: "COMPLETE" }],
		["source lease", { sourceVerificationLeaseUntil: now }],
		["draft lease", { emailDraftLeaseUntil: now }],
	];
	test.each(blocked)(
		"blocks %s for queue and selection",
		async (_name, data) => {
			const prospect = await fixture();
			await ready(prospect.id);
			await db.outreachProspect.update({ where: { id: prospect.id }, data });
			await rejectsUnchanged(prospect.id, "research", "without a stop");
			await rejectsUnchanged(prospect.id, "select", "without a stop");
		},
	);

	test.each(["send", "contact"])("blocks active %s lease", async (kind) => {
		const prospect = await fixture();
		await ready(prospect.id);
		if (kind === "send")
			await db.outreachCampaign.update({
				where: { id: OUTREACH.id },
				data: { sendLeaseUntil: now },
			});
		else
			await db.outreachContactResearch.update({
				where: { prospectId: prospect.id },
				data: { leaseUntil: now },
			});
		await rejectsUnchanged(prospect.id, "research", "active send");
		await rejectsUnchanged(prospect.id, "select", "active send");
	});

	test.each(["SENDING", "UNKNOWN", "SENT"])(
		"preserves %s delivery snapshots",
		async (status) => {
			const prospect = await fixture();
			await ready(prospect.id);
			await db.outreachDelivery.create({
				data: {
					prospectId: prospect.id,
					stage: 0,
					status,
					rfcMessageId: `${crypto.randomUUID()}@example.test`,
					subject: "Immutable subject",
					body: "Immutable body",
					approvalHash: "d".repeat(64),
				},
			});
			await rejectsUnchanged(prospect.id, "research", "delivery");
			await rejectsUnchanged(prospect.id, "select", "delivery");
		},
	);

	test.each([
		"old email",
		"new email",
		"company domain",
		"old mailbox domain",
		"new mailbox domain",
	])("blocks %s suppression", async (kind) => {
		const prospect = await fixture();
		await ready(prospect.id);
		if (kind.endsWith("email"))
			await db.outreachSuppression.create({
				data: {
					email: kind === "old email" ? email : selectedEmail,
					reason: "SUPPRESSED",
				},
			});
		else
			await db.suppressedDomain.create({
				data: {
					domain:
						kind === "company domain"
							? domain
							: kind === "old mailbox domain"
								? oldDomain
								: newDomain,
				},
			});
		await rejectsUnchanged(prospect.id, "select", "suppressed");
	});

	test.each([email, selectedEmail])(
		"blocks CRM suppressed contact %s",
		async (address) => {
			const prospect = await fixture();
			await ready(prospect.id);
			await db.suppressedContact.create({ data: { email: address } });
			await rejectsUnchanged(prospect.id, "select", "suppressed");
		},
	);

	test.each(["PENDING", "RESEARCHING", "HELD"])(
		"rejects unfinished %s research",
		async (status) => {
			const prospect = await fixture();
			await ready(prospect.id);
			await db.outreachContactResearch.update({
				where: { prospectId: prospect.id },
				data: { status },
			});
			await rejectsUnchanged(prospect.id, "select", "Current completed");
		},
	);

	test.each([
		"job age",
		"candidate age",
		"input drift",
		"future job",
		"future candidate",
	])("rejects %s", async (kind) => {
		const prospect = await fixture();
		await ready(prospect.id);
		const old = new Date(now.getTime() - CONTACT_RESEARCH.candidateFreshMs - 1);
		if (kind === "input drift")
			await db.outreachContactResearch.update({
				where: { prospectId: prospect.id },
				data: { inputHash: "wrong" },
			});
		else if (kind === "job age" || kind === "future job")
			await db.outreachContactResearch.update({
				where: { prospectId: prospect.id },
				data: {
					completedAt: kind === "job age" ? old : new Date(now.getTime() + 1),
				},
			});
		else
			await db.outreachContactResearch.update({
				where: { prospectId: prospect.id },
				data: {
					candidates: [
						{
							...target(),
							checkedAt: (kind === "candidate age"
								? old
								: new Date(now.getTime() + 1)
							).toISOString(),
						},
					],
				},
			});
		await rejectsUnchanged(prospect.id, "select", "research");
	});

	test("null-email research notes display but cannot be selected", async () => {
		const prospect = await fixture();
		await ready(prospect.id, target(null));
		const result = await service.status(ownerId, { id: prospect.id });
		expect(result.candidates[0]?.email).toBeNull();
		await rejectsUnchanged(prospect.id, "select", "published work email");
	});

	test("concurrent selection commits once and rejects the second request", async () => {
		const prospect = await fixture();
		await ready(prospect.id);
		const results = await Promise.allSettled([
			service.select(ownerId, { id: prospect.id, candidateId: target().id }),
			service.select(ownerId, { id: prospect.id, candidateId: target().id }),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		const after = await state(prospect.id);
		expect(after.prospect.email).toBe(selectedEmail);
		expect(after.job?.status).toBe("SELECTED");
		expect(after.job?.candidates).toEqual([target()]);
		await rejectsUnchanged(
			prospect.id,
			"select",
			"Current completed contact research",
		);
		expect(after.prospect.consent).toBeNull();
		expect(after.contacts).toHaveLength(1);
		expect(after.deliveries).toHaveLength(0);
	});

	test("a matching existing CRM contact remains unchanged until the worker binds it", async () => {
		const prospect = await fixture();
		await ready(prospect.id);
		await db.contact.create({
			data: {
				firstName: "Alex",
				email: selectedEmail,
				companyId: prospect.companyId,
				ownerId,
			},
		});
		const before = await state(prospect.id);
		await service.select(ownerId, {
			id: prospect.id,
			candidateId: target().id,
		});
		const after = await state(prospect.id);
		expect(after.contacts).toEqual(before.contacts);
		expect(after.prospect.contactId).toBeNull();
	});

	test.each(["archived", "wrong owner"])(
		"blocks an %s existing company",
		async (kind) => {
			const prospect = await fixture();
			await ready(prospect.id);
			if (!prospect.companyId) throw new Error("Expected company binding");
			await db.company.update({
				where: { id: prospect.companyId },
				data: {
					archivedAt: kind === "archived" ? now : null,
					ownerId: kind === "wrong owner" ? otherId : ownerId,
				},
			});
			await rejectsUnchanged(
				prospect.id,
				"research",
				"company binding is unavailable",
			);
			await rejectsUnchanged(
				prospect.id,
				"select",
				"company binding is unavailable",
			);
		},
	);

	test("rejects duplicate prospect email", async () => {
		const prospect = await fixture();
		await ready(prospect.id);
		await db.outreachProspect.create({
			data: {
				campaignId: OUTREACH.id,
				domain: `other-${domain}`,
				email: selectedEmail,
				evidence: {},
			},
		});
		await rejectsUnchanged(prospect.id, "select", "another prospect");
	});

	test.each(["wrong owner", "wrong company", "archived"])(
		"rejects a %s CRM contact binding",
		async (kind) => {
			const prospect = await fixture();
			await ready(prospect.id);
			await db.contact.create({
				data: {
					firstName: "Existing person",
					email: selectedEmail,
					ownerId: kind === "wrong owner" ? otherId : ownerId,
					companyId: kind === "wrong company" ? null : prospect.companyId,
					archivedAt: kind === "archived" ? now : null,
				},
			});
			await rejectsUnchanged(prospect.id, "select", "conflicting or archived");
		},
	);

	test.each([false, true])(
		"requalification preserves existing pilot slot and manual=%s",
		async (manual) => {
			const prospect = await fixture(manual);
			await db.outreachProspect.update({
				where: { id: prospect.id },
				data: { status: "HELD" },
			});
			await outreach.qualify(ownerId, {
				id: prospect.id,
				consent: {
					kind: "express",
					evidence:
						"Fresh explicit request for information about the verified selected contact.",
					source: "new-test-request",
					roleRelevant: true,
					noRestriction: true,
				},
			});
			const result = await db.outreachProspect.findUniqueOrThrow({
				where: { id: prospect.id },
			});
			expect(result.pilotSlot).toBe(prospect.pilotSlot);
			expect(result.manual).toBe(manual);
			expect(result.status).toBe(manual ? "MANUAL" : "READY");
		},
	);

	test("rejects arbitrary candidates and trusted verification fields at input boundaries", () => {
		expect(
			selectContactInput.safeParse({
				id: "test",
				candidateId: target().id,
				candidate: target(),
			}).success,
		).toBe(false);
		expect(
			queueContactResearchInput.safeParse({
				id: "test",
				candidates: [target()],
			}).success,
		).toBe(false);
	});
});
