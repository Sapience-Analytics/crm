import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { db } from "@crm/db";
import {
	DEFAULT_TEMPLATES,
	evidenceSchema,
	OUTREACH,
} from "@crm/validation/outreach";
import { campaignHash } from "@crm/validation/outreach-draft-state";
import { qualifyRequestedProspect } from "../agent/lib/outreach-eligibility";
import * as sources from "../agent/lib/outreach-research";

const now = new Date("2026-09-14T03:00:00.000Z");
const ownerId = "eligibility-integration-owner";
const domain = "eligibility-integration.test";
const sourceSpy = spyOn(sources, "readSource");
const fetchSpy = spyOn(globalThis, "fetch");
const previousEnvironment = process.env.VERCEL_ENV;
let ownsFixtures = false;
let id = "";
let companyId = "";
let contactId = "";

function evidence(email = `alex@${domain}`) {
	return evidenceSchema.parse({
		company: "Example Transport",
		domain,
		email,
		industry: "transport",
		fleetBand: "unknown",
		fleetEvidence: "unknown",
		fit: "Delivery trucks serve customers across Western Australia.",
		sourceUrl: `https://${domain}/`,
		sourceQuote: "We operate delivery trucks across Perth.",
		waQuote: "Perth, Western Australia",
		checkedAt: now.toISOString(),
		verified: true,
		contactSourceUrl: `https://${domain}/contact`,
		contactRoleQuote: `Alex Smith Operations Manager ${email}`,
		contactTarget: {
			id: "a".repeat(64),
			kind: "named",
			name: "Alex Smith",
			role: "operations",
			roleTitle: "Operations Manager",
			email,
			sourceUrl: `https://${domain}/contact`,
			associationQuote: `Alex Smith Operations Manager ${email}`,
			employmentQuote: "Alex Smith Operations Manager",
			verified: true,
			checkedAt: now.toISOString(),
		},
	});
}

function publicSource(url: string, email = `alex@${domain}`) {
	return {
		text: url.endsWith("/contact")
			? `<section><h2>Alex Smith</h2><p>Operations Manager</p><p>${email}</p></section>`
			: `<main><p>${evidence().sourceQuote}</p><p>${evidence().waQuote}</p></main>`,
		url: new URL(url),
	};
}

async function row() {
	return db.outreachProspect.findUniqueOrThrow({ where: { id } });
}

async function fillPilot() {
	await db.outreachProspect.createMany({
		data: Array.from({ length: OUTREACH.pilotSize }, (_, index) => ({
			campaignId: OUTREACH.id,
			domain: `allocated-${index}.test`,
			email: `team@allocated-${index}.test`,
			evidence: evidence(),
			pilotSlot: index + 1,
			manual: index < OUTREACH.manualSize,
			status: index < OUTREACH.manualSize ? "MANUAL" : "READY",
		})),
	});
}

beforeEach(async () => {
	setSystemTime(now);
	expect(
		await db.outreachCampaign.findUnique({ where: { id: OUTREACH.id } }),
	).toBeNull();
	expect(await db.user.findUnique({ where: { id: ownerId } })).toBeNull();
	await db.user.create({
		data: {
			id: ownerId,
			name: "Eligibility test",
			email: "owner@eligibility-integration.test",
			emailVerified: true,
		},
	});
	ownsFixtures = true;
	await db.outreachCampaign.create({
		data: {
			id: OUTREACH.id,
			ownerId,
			senderEmail: OUTREACH.sender,
			templates: DEFAULT_TEMPLATES,
			approvedHash: campaignHash(DEFAULT_TEMPLATES),
			status: "PILOT",
			researchEnabled: true,
		},
	});
	const company = await db.company.create({
		data: { domain, name: evidence().company, ownerId },
	});
	companyId = company.id;
	const contact = await db.contact.create({
		data: {
			email: evidence().email,
			firstName: "Alex",
			lastName: "Smith",
			companyId,
			ownerId,
		},
	});
	contactId = contact.id;
	const prospect = await db.outreachProspect.create({
		data: {
			campaignId: OUTREACH.id,
			domain,
			email: evidence().email,
			evidence: evidence(),
			companyId,
			contactId,
			eligibilityDueAt: now,
		},
	});
	id = prospect.id;
	process.env.VERCEL_ENV = "production";
	sourceSpy.mockReset();
	sourceSpy.mockImplementation(async (url) => publicSource(url));
	fetchSpy.mockReset();
	fetchSpy.mockRejectedValue(
		new Error("External provider calls are forbidden in eligibility tests."),
	);
});

afterEach(async () => {
	sourceSpy.mockReset();
	fetchSpy.mockReset();
	if (previousEnvironment === undefined) delete process.env.VERCEL_ENV;
	else process.env.VERCEL_ENV = previousEnvironment;
	setSystemTime();
	if (!ownsFixtures) return;
	await db.outreachProspect.deleteMany({
		where: { campaignId: OUTREACH.id, referredFromId: { not: null } },
	});
	await db.outreachProspect.deleteMany({ where: { campaignId: OUTREACH.id } });
	await db.outreachCampaign.delete({ where: { id: OUTREACH.id } });
	await db.emailThread.deleteMany({ where: { companyId } });
	await db.suppressedContact.deleteMany({
		where: { email: { endsWith: domain } },
	});
	await db.outreachSuppression.deleteMany({
		where: { email: { endsWith: domain } },
	});
	await db.suppressedDomain.deleteMany({ where: { domain } });
	await db.contact.deleteMany({ where: { ownerId } });
	await db.company.deleteMany({ where: { ownerId } });
	await db.user.delete({ where: { id: ownerId } });
	ownsFixtures = false;
});

afterAll(() => {
	sourceSpy.mockRestore();
	fetchSpy.mockRestore();
});

test("approved source-backed qualification records its own assessment and preserves the first manual slot", async () => {
	await qualifyRequestedProspect();
	const result = await row();
	expect(result.status).toBe("MANUAL");
	expect(result.manual).toBe(true);
	expect(result.pilotSlot).toBe(1);
	expect(result.consent).toMatchObject({
		kind: "published-business-role",
		verifiedBy: "automatic-published-role-assessment",
	});
	expect(result.eligibilityAssessment).toMatchObject({
		email: evidence().email,
		roleTitle: "Operations Manager",
	});
	expect(result.eligibilityLease).toBeNull();
	expect(result.eligibilityDueAt).toBeNull();
	expect(result.lastCheckedAt).toBeNull();
	expect(fetchSpy).not.toHaveBeenCalled();
	const calls = sourceSpy.mock.calls.length;
	await qualifyRequestedProspect();
	expect(sourceSpy.mock.calls).toHaveLength(calls);
});

test("new steady-state prospects stay unallocated after the twelve original pilot slots", async () => {
	await fillPilot();
	await qualifyRequestedProspect();
	expect(await row()).toMatchObject({
		status: "READY",
		manual: false,
		pilotSlot: null,
	});
	expect(
		await db.outreachProspect.count({ where: { pilotSlot: { not: null } } }),
	).toBe(12);
});

test("an existing manual flag remains permanent outside the first two slots", async () => {
	await db.outreachProspect.update({
		where: { id },
		data: { manual: true, pilotSlot: 5 },
	});
	await qualifyRequestedProspect();
	expect(await row()).toMatchObject({
		status: "MANUAL",
		manual: true,
		pilotSlot: 5,
	});
});

test("concurrent workers perform one assessment and one qualification", async () => {
	await Promise.all([qualifyRequestedProspect(), qualifyRequestedProspect()]);
	expect((await row()).status).toBe("MANUAL");
	expect(sourceSpy.mock.calls).toHaveLength(2);
});

test.each(["PAUSED", "DRAFT"])(
	"%s campaigns do not fetch or qualify",
	async (status) => {
		await db.outreachCampaign.update({
			where: { id: OUTREACH.id },
			data: { status },
		});
		await qualifyRequestedProspect();
		expect((await row()).consent).toBeNull();
		expect(sourceSpy).not.toHaveBeenCalled();
	},
);

test("unapproved policies and nonproduction workers cannot qualify", async () => {
	await db.outreachCampaign.update({
		where: { id: OUTREACH.id },
		data: { approvedHash: "stale" },
	});
	await qualifyRequestedProspect();
	await db.outreachCampaign.update({
		where: { id: OUTREACH.id },
		data: { approvedHash: campaignHash(DEFAULT_TEMPLATES) },
	});
	process.env.VERCEL_ENV = "preview";
	await qualifyRequestedProspect();
	expect((await row()).consent).toBeNull();
	expect(sourceSpy).not.toHaveBeenCalled();
});

test("source failures remain held with a durable retry and no model spend", async () => {
	sourceSpy.mockResolvedValue(null);
	await qualifyRequestedProspect();
	const result = await row();
	expect(result.status).toBe("HELD");
	expect(result.consent).toBeNull();
	expect(result.eligibilityError).toContain("unavailable");
	expect(result.eligibilityDueAt?.getTime()).toBe(
		now.getTime() + OUTREACH.dayMs,
	);
	expect(fetchSpy).not.toHaveBeenCalled();
});

test("current source verification work is not penalized with an early daily eligibility delay", async () => {
	await db.outreachProspect.update({
		where: { id },
		data: {
			evidence: { ...evidence(), verified: false },
			sourceVerificationLeaseUntil: new Date(now.getTime() + OUTREACH.leaseMs),
		},
	});
	await qualifyRequestedProspect();
	expect((await row()).eligibilityDueAt).toEqual(now);
	expect((await row()).lastCheckedAt).toBeNull();
	expect(sourceSpy).not.toHaveBeenCalled();
});

test("a bounded batch of invalid bindings defers so later eligible prospects progress next tick", async () => {
	await db.outreachProspect.createMany({
		data: Array.from({ length: 20 }, (_, index) => ({
			campaignId: OUTREACH.id,
			domain: `invalid-${index}.test`,
			email: `manager@invalid-${index}.test`,
			evidence: evidence(),
			eligibilityDueAt: new Date(now.getTime() - 1),
		})),
	});
	await qualifyRequestedProspect();
	expect((await row()).consent).toBeNull();
	expect(sourceSpy).not.toHaveBeenCalled();
	expect(
		await db.outreachProspect.count({
			where: { eligibilityError: { not: null }, eligibilityDueAt: { gt: now } },
		}),
	).toBe(20);
	await qualifyRequestedProspect();
	expect((await row()).status).toBe("MANUAL");
});

test("source drift during reading cannot commit an assessment", async () => {
	sourceSpy.mockImplementationOnce(async (url) => {
		await db.outreachProspect.update({
			where: { id },
			data: {
				evidence: {
					...evidence(),
					sourceQuote: "Our different operation has changed.",
				},
			},
		});
		return publicSource(url);
	});
	await qualifyRequestedProspect();
	expect((await row()).consent).toBeNull();
	expect((await row()).eligibilityAssessment).toBeNull();
});

test("pause during reading prevents the eligibility commit", async () => {
	sourceSpy.mockImplementationOnce(async (url) => {
		await db.outreachCampaign.update({
			where: { id: OUTREACH.id },
			data: { status: "PAUSED" },
		});
		return publicSource(url);
	});
	await qualifyRequestedProspect();
	expect((await row()).consent).toBeNull();
});

test("suppression added during reading prevents qualification", async () => {
	sourceSpy.mockImplementationOnce(async (url) => {
		await db.outreachSuppression.create({
			data: { email: evidence().email ?? "", reason: "unsubscribe" },
		});
		return publicSource(url);
	});
	await qualifyRequestedProspect();
	expect((await row()).consent).toBeNull();
});

test("an expired prior eligibility lease recovers and a live lease excludes overlapping work", async () => {
	await db.outreachProspect.update({
		where: { id },
		data: {
			eligibilityLease: "prior",
			eligibilityLeaseUntil: new Date(now.getTime() + OUTREACH.leaseMs),
		},
	});
	await qualifyRequestedProspect();
	expect(sourceSpy).not.toHaveBeenCalled();
	await db.outreachProspect.update({
		where: { id },
		data: { eligibilityLeaseUntil: new Date(now.getTime() - 1) },
	});
	await qualifyRequestedProspect();
	expect((await row()).status).toBe("MANUAL");
	expect((await row()).eligibilityLease).toBeNull();
});

test("a worker that outlives its lease cannot commit", async () => {
	sourceSpy.mockImplementationOnce(async (url) => {
		setSystemTime(new Date(now.getTime() + OUTREACH.leaseMs + 1));
		return publicSource(url);
	});
	await qualifyRequestedProspect();
	expect((await row()).consent).toBeNull();
	expect((await row()).eligibilityLease).toBeNull();
});

test("missing company ownership and suppressed mailbox domains block before network calls", async () => {
	await db.company.update({
		where: { id: companyId },
		data: { ownerId: null },
	});
	await qualifyRequestedProspect();
	expect(sourceSpy).not.toHaveBeenCalled();
	await db.company.update({ where: { id: companyId }, data: { ownerId } });
	await db.suppressedDomain.create({ data: { domain } });
	await qualifyRequestedProspect();
	expect(sourceSpy).not.toHaveBeenCalled();
	expect((await row()).consent).toBeNull();
});

async function inbound(authenticated: boolean) {
	return db.outreachInbound.create({
		data: {
			prospectId: id,
			messageId: "request-message",
			classification: "REPLIED",
			message: {
				messageId: "request-message",
				threadId: "request-thread",
				fromEmail: evidence().email,
				toEmails: [OUTREACH.sender],
				rfcMessageId: "request@example.test",
				receivedAt: now.toISOString(),
				body: "Please contact me about Geotab.",
				authenticated,
				inCampaignThread: true,
			},
		},
	});
}

test("an authenticated exact inbound request receives a separate express assessment", async () => {
	const event = await inbound(true);
	await db.outreachProspect.update({
		where: { id },
		data: { manual: true, pilotSlot: 7 },
	});
	await qualifyRequestedProspect();
	expect(await row()).toMatchObject({
		manual: true,
		pilotSlot: 7,
		status: "MANUAL",
		consent: { kind: "express", verifiedBy: "authenticated-inbound-request" },
		eligibilityAssessment: { inboundEventId: event.id },
	});
});

test("unsigned inbound text never grants express consent or falls through to a cold contact", async () => {
	await inbound(false);
	await qualifyRequestedProspect();
	expect((await row()).consent).toBeNull();
	expect(sourceSpy).not.toHaveBeenCalled();
});

test("a newer inbound event during source checking invalidates the express request", async () => {
	await inbound(true);
	sourceSpy.mockImplementationOnce(async (url) => {
		await db.outreachInbound.create({
			data: {
				prospectId: id,
				messageId: "newer-message",
				classification: "SUPPRESSED",
				message: {},
				createdAt: new Date(now.getTime() + 1),
			},
		});
		return publicSource(url);
	});
	await qualifyRequestedProspect();
	expect((await row()).consent).toBeNull();
});

test("existing CRM correspondence does not become an automatic cold consent basis", async () => {
	await db.emailThread.create({
		data: {
			rootMessageId: "existing-message@example.test",
			companyId,
			contactId,
			firstMessageAt: now,
			lastMessageAt: now,
			messageCount: 1,
		},
	});
	await qualifyRequestedProspect();
	expect((await row()).consent).toBeNull();
	expect((await row()).eligibilityError).toContain(
		"Existing company correspondence",
	);
	expect(sourceSpy).not.toHaveBeenCalled();
});

test("same-company referral children receive their own basis without a pilot slot or parent consent copying", async () => {
	const parentId = id;
	await db.outreachProspect.update({
		where: { id: parentId },
		data: {
			status: "REPLIED",
			stoppedAt: now,
			initialSentAt: now,
			pilotSlot: 3,
			consent: {
				kind: "express",
				evidence: "Parent consent must not copy to the referred recipient.",
				source: "parent-only",
				roleRelevant: true,
				noRestriction: true,
				verifiedBy: "owner",
				verifiedAt: now.toISOString(),
			},
		},
	});
	const childEmail = `other@${domain}`;
	const contact = await db.contact.create({
		data: {
			email: childEmail,
			firstName: "Alex",
			lastName: "Smith",
			ownerId,
			companyId,
		},
	});
	const child = await db.outreachProspect.create({
		data: {
			campaignId: OUTREACH.id,
			domain,
			email: childEmail,
			evidence: evidence(childEmail),
			companyId,
			contactId: contact.id,
			referredFromId: parentId,
			referralDepth: 1,
			eligibilityDueAt: now,
		},
	});
	id = child.id;
	sourceSpy.mockImplementation(async (url) => publicSource(url, childEmail));
	await qualifyRequestedProspect();
	expect(await row()).toMatchObject({
		status: "READY",
		pilotSlot: null,
		manual: false,
		consent: { kind: "published-business-role" },
	});
	expect(
		(await db.outreachProspect.findUniqueOrThrow({ where: { id: parentId } }))
			.status,
	).toBe("REPLIED");
});
