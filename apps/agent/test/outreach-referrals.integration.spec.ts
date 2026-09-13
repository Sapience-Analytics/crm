import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { db } from "@crm/db";
import {
	DEFAULT_TEMPLATES,
	evidenceSchema,
	OUTREACH,
} from "@crm/validation/outreach";
import { contactResearchCandidateSchema } from "@crm/validation/outreach-contact-target";
import { campaignHash } from "@crm/validation/outreach-draft-state";
import { DRAFTING } from "@crm/validation/outreach-drafts";
import {
	incomingReferralSchema,
	OUTREACH_AUTOMATION,
} from "@crm/validation/outreach-referrals";
import { gatewayText } from "../agent/lib/outreach-ai";
import { runOutreachReferrals } from "../agent/lib/outreach-referrals";
import * as sources from "../agent/lib/outreach-research";
import { RESEARCH_PROVIDER } from "../agent/lib/outreach-research-config";

const domain = "referral-worker-spec.test";
const ownerId = "referral-worker-owner";
const email = `team@${domain}`;
const targetEmail = `alex@${domain}`;
const body = `Please contact Alex Smith at ${targetEmail} about fleet reporting.`;
const candidate = contactResearchCandidateSchema.parse({
	kind: "named",
	name: "Alex Smith",
	role: "operations",
	roleTitle: "Operations Manager",
	email: targetEmail,
	sourceUrl: `https://${domain}/contact`,
	associationQuote: `Alex Smith Operations Manager ${targetEmail}`,
	employmentQuote: "Alex Smith Operations Manager",
});
const evidence = evidenceSchema.parse({
	company: "Referral Test Transport",
	domain,
	email,
	industry: "transport",
	fleetBand: "unknown",
	fleetEvidence: "unknown",
	fit: "Road vehicles provide freight transport across Western Australia.",
	sourceUrl: `https://${domain}/`,
	sourceQuote: "We operate delivery vehicles across Perth.",
	waQuote: "Perth, Western Australia",
	verified: true,
	checkedAt: new Date().toISOString(),
	contactTarget: {
		id: "a".repeat(64),
		kind: "department",
		name: null,
		role: "department",
		roleTitle: "Published company inbox",
		email,
		sourceUrl: `https://${domain}/contact`,
		associationQuote: `Company operations contact ${email}`,
		employmentQuote: `Company operations contact ${email}`,
		verified: true,
		checkedAt: new Date().toISOString(),
	},
});
const message = incomingReferralSchema.parse({
	messageId: "inbound-message",
	threadId: "campaign-thread",
	fromEmail: email,
	toEmails: [OUTREACH.sender],
	rfcMessageId: `reply@${domain}`,
	receivedAt: new Date(Date.now() - OUTREACH.minuteMs).toISOString(),
	body,
	authenticated: true,
	inCampaignThread: true,
});
const decision = {
	kind: "referral",
	email: targetEmail,
	name: "Alex Smith",
	quote: body,
};
const aiBudget = `ai:${new Date().toISOString().slice(0, 7)}`;
const researchBudget = `research:${new Date().toISOString().slice(0, 7)}`;
const fetchSpy = spyOn(globalThis, "fetch");
const generate = spyOn(gatewayText, "generate");
const sourceSpy = spyOn(sources, "readSource");
const verifySpy = spyOn(sources, "checkProspectSources");
const originalEnv = process.env.VERCEL_ENV;
const originalKey = process.env.PERPLEXITY_API_KEY;
let parentId = "";
let jobId = "";
let companyId = "";
let ownsFixtures = false;
let researchBodies: string[] = [];

function researchResponse(candidates = [candidate]) {
	return Response.json({
		model: RESEARCH_PROVIDER.model,
		service_tier: "default",
		status: "completed",
		usage: { cost: { currency: "USD", total_cost: 0.004 } },
		output: [
			{
				type: "message",
				role: "assistant",
				status: "completed",
				content: [
					{ type: "output_text", text: JSON.stringify({ candidates }) },
				],
			},
		],
	});
}

async function getJob() {
	return db.outreachReferral.findUniqueOrThrow({ where: { id: jobId } });
}

async function children() {
	return db.outreachProspect.findMany({ where: { referredFromId: parentId } });
}

beforeEach(async () => {
	expect(
		await db.outreachCampaign.findUnique({ where: { id: OUTREACH.id } }),
	).toBeNull();
	expect(
		await db.outreachBudget.count({
			where: { id: { in: [aiBudget, researchBudget] } },
		}),
	).toBe(0);
	expect(await db.company.findFirst({ where: { domain } })).toBeNull();
	ownsFixtures = true;
	researchBodies = [];
	process.env.VERCEL_ENV = "production";
	process.env.PERPLEXITY_API_KEY = "synthetic-referral-key-never-sent";
	await db.user.create({
		data: {
			id: ownerId,
			name: "Referral test",
			email: `owner@${domain}`,
			emailVerified: true,
		},
	});
	await db.outreachCampaign.create({
		data: {
			id: OUTREACH.id,
			ownerId,
			senderEmail: OUTREACH.sender,
			templates: DEFAULT_TEMPLATES,
			approvedHash: campaignHash(DEFAULT_TEMPLATES),
			approvedAt: new Date(),
			status: "PILOT",
			researchEnabled: true,
		},
	});
	companyId = (
		await db.company.create({
			data: { domain, name: evidence.company, ownerId },
		})
	).id;
	const contact = await db.contact.create({
		data: { email, firstName: "Operations", companyId, ownerId },
	});
	parentId = (
		await db.outreachProspect.create({
			data: {
				campaignId: OUTREACH.id,
				domain,
				email,
				companyId,
				contactId: contact.id,
				evidence,
				status: "REPLIED",
				stoppedAt: new Date(message.receivedAt),
				replyText: body,
				initialSentAt: new Date(Date.now() - OUTREACH.dayMs),
				pilotSlot: 3,
				consent: {
					kind: "express",
					evidence:
						"Parent-only evidence must never be copied into a referred child.",
				},
			},
		})
	).id;
	await db.outreachDelivery.create({
		data: {
			prospectId: parentId,
			stage: 0,
			status: "SENT",
			rfcMessageId: `sent@${domain}`,
			gmailMessageId: "sent-message",
			gmailThreadId: message.threadId,
			subject: "Fleet reporting",
			body: "Previously sent immutable snapshot.",
			approvalHash: "original-approval",
			sentAt: new Date(Date.now() - OUTREACH.dayMs),
			loggedAt: new Date(),
		},
	});
	await db.outreachInbound.create({
		data: {
			prospectId: parentId,
			messageId: message.messageId,
			message,
			classification: "REPLIED",
		},
	});
	jobId = (
		await db.outreachReferral.create({
			data: { prospectId: parentId, messageId: message.messageId, message },
		})
	).id;
	generate.mockImplementation(async (request) => {
		expect(request.phase).toBe("referral");
		expect(
			(await db.outreachBudget.findUniqueOrThrow({ where: { id: aiBudget } }))
				.reservedMicroUsd,
		).toBeGreaterThanOrEqual(OUTREACH.aiReserveMicroUsd);
		return {
			text: JSON.stringify(decision),
			finishReason: "stop",
			costMicroUsd: 1000,
		};
	});
	fetchSpy.mockImplementation(async (url, init) => {
		if (String(url) === "https://ai-gateway.vercel.sh/v1/models")
			return Response.json({
				data: [
					{
						id: DRAFTING.model,
						pricing: { input: "0.00000075", output: "0.0000045" },
					},
				],
			});
		expect(String(url)).toBe("https://api.perplexity.ai/v1/agent");
		expect(
			(
				await db.outreachBudget.findUniqueOrThrow({
					where: { id: researchBudget },
				})
			).reservedMicroUsd,
		).toBeGreaterThanOrEqual(OUTREACH.researchReserveMicroUsd);
		researchBodies.push(String(init?.body));
		return researchResponse();
	});
	sourceSpy.mockResolvedValue({
		text: `<section><h2>Alex Smith</h2><p>Operations Manager</p><p>${targetEmail}</p></section>`,
		url: new URL(candidate.sourceUrl),
	});
	verifySpy.mockResolvedValue(true);
});

afterEach(async () => {
	fetchSpy.mockReset();
	generate.mockReset();
	sourceSpy.mockReset();
	verifySpy.mockReset();
	if (originalEnv === undefined) delete process.env.VERCEL_ENV;
	else process.env.VERCEL_ENV = originalEnv;
	if (originalKey === undefined) delete process.env.PERPLEXITY_API_KEY;
	else process.env.PERPLEXITY_API_KEY = originalKey;
	if (!ownsFixtures) return;
	await db.outreachDelivery.deleteMany({
		where: { prospect: { campaignId: OUTREACH.id } },
	});
	await db.outreachProspect.deleteMany({
		where: { campaignId: OUTREACH.id, referredFromId: { not: null } },
	});
	await db.outreachProspect.deleteMany({ where: { campaignId: OUTREACH.id } });
	await db.outreachCampaign.deleteMany({ where: { id: OUTREACH.id } });
	await db.outreachBudget.deleteMany({
		where: { id: { in: [aiBudget, researchBudget] } },
	});
	await db.suppressedDomain.deleteMany({ where: { domain } });
	await db.outreachSuppression.deleteMany({ where: { email: targetEmail } });
	await db.emailThread.deleteMany({ where: { companyId } });
	await db.contact.deleteMany({ where: { companyId } });
	await db.company.deleteMany({ where: { id: companyId } });
	await db.user.deleteMany({ where: { id: ownerId } });
	ownsFixtures = false;
});

afterAll(() => {
	fetchSpy.mockRestore();
	generate.mockRestore();
	sourceSpy.mockRestore();
	verifySpy.mockRestore();
});

test("creates one separately held verified child, preserves parent snapshots and settles both ledgers", async () => {
	const original = await db.outreachProspect.findUniqueOrThrow({
		where: { id: parentId },
	});
	await runOutreachReferrals();
	expect((await getJob()).status).toBe("CREATED");
	const rows = await children();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		email: targetEmail,
		companyId,
		status: "HELD",
		manual: false,
		pilotSlot: null,
		consent: null,
		referralDepth: 1,
		emailDrafts: null,
		initialSentAt: null,
	});
	expect(rows[0]?.contactId).not.toBeNull();
	expect(evidenceSchema.parse(rows[0]?.evidence)).toMatchObject({
		email: targetEmail,
		verified: true,
		contactTarget: { name: "Alex Smith", email: targetEmail },
	});
	expect(
		await db.outreachProspect.findUnique({ where: { id: parentId } }),
	).toEqual(original);
	expect(await db.outreachDelivery.count()).toBe(1);
	expect(
		(await db.outreachBudget.findUniqueOrThrow({ where: { id: aiBudget } }))
			.actualMicroUsd,
	).toBe(1000);
	expect(
		(
			await db.outreachBudget.findUniqueOrThrow({
				where: { id: researchBudget },
			})
		).actualMicroUsd,
	).toBe(4000);
	expect(researchBodies[0]).toContain(targetEmail);
	expect(researchBodies[0]).not.toContain(body);
	await runOutreachReferrals();
	expect(await children()).toHaveLength(1);
	expect(generate).toHaveBeenCalledTimes(1);
});

test("concurrent workers produce one child and one pair of paid reservations", async () => {
	await Promise.all([runOutreachReferrals(), runOutreachReferrals()]);
	expect(await children()).toHaveLength(1);
	expect(generate).toHaveBeenCalledTimes(1);
	expect(researchBodies).toHaveLength(1);
});

for (const status of ["PAUSED", "DRAFT"])
	test(`${status} campaign makes no paid calls`, async () => {
		await db.outreachCampaign.update({
			where: { id: OUTREACH.id },
			data: { status },
		});
		await runOutreachReferrals();
		expect(generate).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await children()).toHaveLength(0);
	});

test("stale campaign approval makes no paid calls", async () => {
	await db.outreachCampaign.update({
		where: { id: OUTREACH.id },
		data: { approvedHash: "old-policy" },
	});
	await runOutreachReferrals();
	expect(fetchSpy).not.toHaveBeenCalled();
});

for (const data of [
	{ manual: true },
	{ status: "SUPPRESSED" },
	{ referralDepth: 1 },
	{ replyText: "Please wait instead." },
])
	test(`parent guard blocks ${JSON.stringify(data)} before paid calls`, async () => {
		await db.outreachProspect.update({ where: { id: parentId }, data });
		await runOutreachReferrals();
		expect((await getJob()).status).toBe("HELD");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await children()).toHaveLength(0);
	});

test("missing optional Perplexity capability makes no AI or research call", async () => {
	delete process.env.PERPLEXITY_API_KEY;
	await runOutreachReferrals();
	expect((await getJob()).error).toContain("Connect Perplexity");
	expect(generate).not.toHaveBeenCalled();
	expect(fetchSpy).not.toHaveBeenCalled();
});

test("a durable original-message mismatch holds before paid calls", async () => {
	await db.outreachInbound.update({
		where: {
			prospectId_messageId: {
				prospectId: parentId,
				messageId: message.messageId,
			},
		},
		data: { message: { ...message, authenticated: false } },
	});
	await runOutreachReferrals();
	expect((await getJob()).status).toBe("HELD");
	expect(fetchSpy).not.toHaveBeenCalled();
});

test("a thread with no confirmed campaign delivery cannot create a child", async () => {
	await db.outreachDelivery.updateMany({
		where: { prospectId: parentId },
		data: { gmailThreadId: "unrelated-thread" },
	});
	await runOutreachReferrals();
	expect(fetchSpy).not.toHaveBeenCalled();
	expect(await children()).toHaveLength(0);
});

test("non-referral decisions create no research request or child", async () => {
	generate.mockResolvedValue({
		text: JSON.stringify({ kind: "none", reason: "no-explicit-referral" }),
		finishReason: "stop",
		costMicroUsd: 1000,
	});
	await runOutreachReferrals();
	expect((await getJob()).status).toBe("IGNORED");
	expect(researchBodies).toHaveLength(0);
});

test("a model-invented referral address is rejected before research", async () => {
	generate.mockResolvedValue({
		text: JSON.stringify({ ...decision, email: `someone-else@${domain}` }),
		finishReason: "stop",
		costMicroUsd: 1000,
	});
	await runOutreachReferrals();
	expect((await getJob()).status).toBe("HELD");
	expect(researchBodies).toHaveLength(0);
});

test("lost lease after extraction starts no further paid requests", async () => {
	generate.mockImplementation(async () => {
		await db.outreachReferral.update({
			where: { id: jobId },
			data: { leaseUntil: new Date(0) },
		});
		return {
			text: JSON.stringify(decision),
			finishReason: "stop",
			costMicroUsd: 1000,
		};
	});
	await runOutreachReferrals();
	expect(researchBodies).toHaveLength(0);
	expect(await children()).toHaveLength(0);
});

test("unknown AI failures retain the reservation and expose no provider prose", async () => {
	generate.mockRejectedValue(new Error("private-credential-and-provider-body"));
	await runOutreachReferrals();
	expect((await getJob()).status).toBe("HELD");
	expect((await getJob()).error).not.toContain("private");
	expect(
		(await db.outreachBudget.findUniqueOrThrow({ where: { id: aiBudget } }))
			.reservedMicroUsd,
	).toBe(OUTREACH.aiReserveMicroUsd);
	expect(researchBodies).toHaveLength(0);
});

test("a full research ledger holds without issuing a research request", async () => {
	await db.outreachBudget.create({
		data: { id: researchBudget, reservedMicroUsd: OUTREACH.monthlyMicroUsd },
	});
	await runOutreachReferrals();
	expect((await getJob()).error).toContain("US$10");
	expect(researchBodies).toHaveLength(0);
});

test("a contact association failure leaves the parent and target unchanged", async () => {
	sourceSpy.mockResolvedValue({
		text: `<footer>Alex Smith unrelated customer ${targetEmail}</footer>`,
		url: new URL(candidate.sourceUrl),
	});
	await runOutreachReferrals();
	expect((await getJob()).status).toBe("HELD");
	expect(await children()).toHaveLength(0);
	expect(
		await db.contact.findFirst({ where: { email: targetEmail } }),
	).toBeNull();
});

test("source failure schedules a bounded retry and keeps no child", async () => {
	sourceSpy.mockResolvedValue(null);
	await runOutreachReferrals();
	expect((await getJob()).status).toBe("PENDING");
	expect((await getJob()).dueAt.getTime()).toBeGreaterThan(Date.now());
	expect(await children()).toHaveLength(0);
	await runOutreachReferrals();
	expect(generate).toHaveBeenCalledTimes(1);
});

test("source retries reuse the extracted decision after a restart", async () => {
	await db.outreachReferral.update({
		where: { id: jobId },
		data: {
			status: "PROCESSING",
			attempts: 1,
			lease: "dead-worker",
			leaseUntil: new Date(0),
			dueAt: new Date(0),
			decision,
		},
	});
	await runOutreachReferrals();
	expect(generate).not.toHaveBeenCalled();
	expect(await children()).toHaveLength(1);
});

test("exhausted interrupted jobs retire without paid requests", async () => {
	await db.outreachReferral.update({
		where: { id: jobId },
		data: {
			status: "PROCESSING",
			attempts: OUTREACH_AUTOMATION.referralMaxAttempts,
			leaseUntil: null,
		},
	});
	await runOutreachReferrals();
	expect((await getJob()).status).toBe("HELD");
	expect(fetchSpy).not.toHaveBeenCalled();
});

test("late suppression blocks the atomic child commit", async () => {
	verifySpy.mockImplementation(async () => {
		await db.outreachSuppression.create({
			data: { email: targetEmail, reason: "Unsubscribe" },
		});
		return true;
	});
	await runOutreachReferrals();
	expect(await children()).toHaveLength(0);
	expect((await getJob()).status).toBe("HELD");
});

test("revoked approval during source verification blocks the atomic child commit", async () => {
	verifySpy.mockImplementation(async () => {
		await db.outreachCampaign.update({
			where: { id: OUTREACH.id },
			data: { approvedHash: null, status: "PAUSED" },
		});
		return true;
	});
	await runOutreachReferrals();
	expect(await children()).toHaveLength(0);
});

test("prior recipient correspondence holds the referral before paid research", async () => {
	await db.emailThread.create({
		data: {
			rootMessageId: "existing-target-thread",
			companyId,
			firstMessageAt: new Date(),
			lastMessageAt: new Date(),
			messageCount: 1,
			messages: {
				create: {
					rfcMessageId: "existing-target-reply",
					syncedByUserId: ownerId,
					fromEmail: targetEmail,
					direction: "INBOUND",
					recipients: [{ kind: "to", email: OUTREACH.sender, name: null }],
					sentAt: new Date(),
					body: "Existing conversation",
				},
			},
		},
	});
	await runOutreachReferrals();
	expect(researchBodies).toHaveLength(0);
	expect(await children()).toHaveLength(0);
});

test("an archived contact binding rolls back child creation", async () => {
	await db.contact.create({
		data: {
			email: targetEmail,
			firstName: "Archived",
			companyId,
			ownerId,
			archivedAt: new Date(),
		},
	});
	await runOutreachReferrals();
	expect(await children()).toHaveLength(0);
	expect((await getJob()).status).toBe("HELD");
});

test("an archived parent contact blocks a claim before either paid request", async () => {
	await db.contact.updateMany({
		where: { email },
		data: { archivedAt: new Date() },
	});
	await runOutreachReferrals();
	expect((await getJob()).status).toBe("HELD");
	expect(generate).not.toHaveBeenCalled();
	expect(researchBodies).toHaveLength(0);
	expect(await children()).toHaveLength(0);
});

test("a changed parent contact email during verification blocks the atomic child commit", async () => {
	verifySpy.mockImplementationOnce(async () => {
		await db.contact.updateMany({
			where: { email },
			data: { email: `changed@${domain}` },
		});
		return true;
	});
	await runOutreachReferrals();
	expect((await getJob()).status).toBe("HELD");
	expect(await children()).toHaveLength(0);
	expect(
		await db.contact.findFirst({ where: { email: targetEmail } }),
	).toBeNull();
});

test("a second per-message referral job cannot duplicate an existing child", async () => {
	await runOutreachReferrals();
	const second = incomingReferralSchema.parse({
		...message,
		messageId: "later-inbound",
		rfcMessageId: "later-rfc",
	});
	await db.outreachInbound.create({
		data: {
			prospectId: parentId,
			messageId: second.messageId,
			message: second,
			classification: "REPLIED",
		},
	});
	jobId = (
		await db.outreachReferral.create({
			data: {
				prospectId: parentId,
				messageId: second.messageId,
				message: second,
			},
		})
	).id;
	await runOutreachReferrals();
	expect((await getJob()).status).toBe("HELD");
	expect(await children()).toHaveLength(1);
	expect(generate).toHaveBeenCalledTimes(1);
});
