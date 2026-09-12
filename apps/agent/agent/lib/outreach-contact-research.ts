import { randomUUID } from "node:crypto";
import { db, type OutreachProspectModel, Prisma } from "@crm/db";
import {
	reserveOutreachBudget,
	settleOutreachBudget,
} from "@crm/db/outreach-budget";
import { evidenceSchema, OUTREACH } from "@crm/validation/outreach";
import { contactResearchInputHash } from "@crm/validation/outreach-contact-state";
import {
	contactResearchCandidateSchema,
	type VerifiedContactCandidate,
} from "@crm/validation/outreach-contact-target";
import { CONTACT_RESEARCH } from "@crm/validation/outreach-contacts";
import { verifyContactCandidate } from "./outreach-contact-source";
import { readSource } from "./outreach-research";
import {
	fetchContactResearch,
	ResearchProviderError,
	researchRequest,
} from "./outreach-research-provider";

function available(row: OutreachProspectModel, now: Date) {
	return (
		["HELD", "READY", "MANUAL"].includes(row.status) &&
		!row.initialSentAt &&
		!row.stoppedAt &&
		!(row.emailDraftLeaseUntil && row.emailDraftLeaseUntil > now) &&
		!(
			row.sourceVerificationLeaseUntil && row.sourceVerificationLeaseUntil > now
		)
	);
}

async function suppressed(
	tx: Prisma.TransactionClient,
	domain: string,
	email: string | null,
) {
	return Boolean(
		(await tx.suppressedDomain.findFirst({
			where: {
				domain: {
					in: [domain, email?.split("@")[1] ?? domain],
					mode: "insensitive",
				},
			},
		})) ||
			(email &&
				((await tx.outreachSuppression.findFirst({
					where: { email: { equals: email, mode: "insensitive" } },
				})) ||
					(await tx.suppressedContact.findFirst({
						where: { email: { equals: email, mode: "insensitive" } },
					})))),
	);
}

async function companyAvailable(
	tx: Prisma.TransactionClient,
	row: OutreachProspectModel,
	ownerId: string,
) {
	if (!row.companyId) return false;
	const company = await tx.company.findUnique({ where: { id: row.companyId } });
	return Boolean(
		company &&
			!company.archivedAt &&
			company.ownerId === ownerId &&
			company.domain === row.domain,
	);
}

async function adoptNewContact(
	tx: Prisma.TransactionClient,
	row: OutreachProspectModel,
	candidates: VerifiedContactCandidate[],
	ownerId: string,
) {
	const evidence = evidenceSchema.parse(row.evidence);
	if (
		row.status !== "HELD" ||
		row.pilotSlot !== null ||
		row.manual ||
		row.consent ||
		evidence.contactTarget ||
		!evidence.verified ||
		!row.companyId ||
		(await tx.emailThread.count({
			where: { companyId: row.companyId, messageCount: { gt: 0 } },
		}))
	)
		return false;
	for (const candidate of candidates) {
		if (
			!candidate.email ||
			(await suppressed(tx, row.domain, candidate.email)) ||
			(await tx.outreachProspect.findFirst({
				where: {
					id: { not: row.id },
					email: { equals: candidate.email, mode: "insensitive" },
				},
			}))
		)
			continue;
		const contacts = await tx.contact.findMany({
			where: { email: { equals: candidate.email, mode: "insensitive" } },
		});
		if (
			contacts.length > 1 ||
			contacts.some(
				(contact) =>
					contact.archivedAt ||
					contact.ownerId !== ownerId ||
					contact.companyId !== row.companyId,
			)
		)
			continue;
		await tx.outreachProspect.update({
			where: { id: row.id },
			data: {
				email: candidate.email,
				contactId: candidate.email === row.email ? row.contactId : null,
				evidence: {
					...evidence,
					email: candidate.email,
					contactSourceUrl: candidate.sourceUrl,
					contactRoleQuote: candidate.associationQuote,
					contactTarget: candidate,
					verified: false,
				},
				consent: Prisma.DbNull,
				sourceVerificationAttempts: 0,
				sourceVerificationDueAt: new Date(),
				emailDrafts: Prisma.DbNull,
				emailDraftHash: null,
				emailDraftReviewedHash: null,
				emailDraftReviewedAt: null,
				emailDraftStatus: "PENDING",
				emailDraftAttempts: 0,
				emailDraftDueAt: new Date(),
				stopReason:
					"Selected contact requires source verification and separate contact eligibility.",
			},
		});
		return true;
	}
	return false;
}

export function contactResearchPrompt(company: string, domain: string) {
	return `Find up to three current operational contacts for ${company}, official company domain ${domain}. Prioritize Fleet Manager, Transport Manager, Operations Manager, then an appropriate owner, Managing Director, Branch Manager or General Manager. Prefer a named work contact whose full name, current role and exact published work email appear together in one official contact card. Return a verbatim associationQuote containing the full contiguous contact block, including any intervening phone or location lines. employmentQuote must contain the person's name and exact role from that current company card. Same-page names and a footer email are not an association. Never infer names from email handles. A named person without an explicitly associated email can be a research-only candidate with email null. A department fallback needs kind department, name null, role department, roleTitle Published company inbox, and the exact published company inbox within its associationQuote and employmentQuote. Use only current official company contact or team pages. Exclude customer testimonials, external customers, former employees, historic policies, archives and another organization's role email. A copyright footer year alone does not date a current contact card. Return exact full roleTitle text and one allowed role category. Do not guess emails or infer consent, buying authority, tracking systems or fleet needs. Return an empty candidates array when no supported contact exists.`;
}

function rank(candidate: VerifiedContactCandidate) {
	if (candidate.kind === "department") return 20;
	if (!candidate.email) return 30;
	return [
		"fleet",
		"transport",
		"operations",
		"owner",
		"managing-director",
		"branch-manager",
		"general-manager",
	].indexOf(candidate.role);
}

async function runCandidate(id: string) {
	const lease = randomUUID();
	const claimed = await db.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${OUTREACH.id} FOR UPDATE`;
		await tx.$queryRaw`SELECT id FROM "outreachProspect" WHERE id = ${id} FOR UPDATE`;
		const campaign = await tx.outreachCampaign.findUnique({
			where: { id: OUTREACH.id },
		});
		const row = await tx.outreachProspect.findUnique({ where: { id } });
		const job = await tx.outreachContactResearch.findUnique({
			where: { prospectId: id },
		});
		const now = new Date();
		if (
			!campaign ||
			campaign.senderEmail !== OUTREACH.sender ||
			!row ||
			row.campaignId !== campaign.id ||
			!job ||
			!available(row, now) ||
			!["PENDING", "RESEARCHING"].includes(job.status) ||
			!job.dueAt ||
			job.dueAt > now ||
			job.attempts >= CONTACT_RESEARCH.maxAttempts ||
			(job.leaseUntil && job.leaseUntil > now) ||
			(await tx.outreachDelivery.count({ where: { prospectId: id } }))
		)
			return null;
		if (campaign.sendLeaseUntil && campaign.sendLeaseUntil > now) return null;
		if (
			(await suppressed(tx, row.domain, row.email)) ||
			!(await companyAvailable(tx, row, campaign.ownerId))
		) {
			await tx.outreachContactResearch.update({
				where: { prospectId: id },
				data: {
					status: "HELD",
					dueAt: null,
					error:
						"The company binding or suppression state blocks contact research.",
				},
			});
			return null;
		}
		if (!job.submittedCandidates) {
			if (!campaign.researchEnabled || !process.env.PERPLEXITY_API_KEY) {
				await tx.outreachContactResearch.update({
					where: { prospectId: id },
					data: {
						status: "HELD",
						dueAt: null,
						error:
							"Enable cloud research and connect Perplexity before searching for people.",
					},
				});
				return null;
			}
			if (campaign.researchLeaseUntil && campaign.researchLeaseUntil > now)
				return null;
			await tx.outreachCampaign.update({
				where: { id: campaign.id },
				data: {
					researchLease: lease,
					researchLeaseUntil: new Date(now.getTime() + OUTREACH.leaseMs),
				},
			});
		}
		await tx.outreachContactResearch.update({
			where: { prospectId: id },
			data: {
				status: "RESEARCHING",
				inputHash: contactResearchInputHash(row),
				attempts: { increment: 1 },
				lease,
				leaseUntil: new Date(now.getTime() + OUTREACH.leaseMs),
				dueAt: new Date(now.getTime() + CONTACT_RESEARCH.retryMs),
				error: null,
			},
		});
		return { row, job };
	});
	if (!claimed) return;
	const { row, job } = claimed;
	try {
		let candidates = job.submittedCandidates
			? contactResearchCandidateSchema
					.array()
					.max(CONTACT_RESEARCH.maxCandidates)
					.parse(job.submittedCandidates)
			: null;
		if (!candidates) {
			const evidence = evidenceSchema.parse(row.evidence);
			const body = researchRequest(
				contactResearchPrompt(evidence.company, row.domain),
				"contacts",
			);
			const key = process.env.PERPLEXITY_API_KEY;
			if (!key)
				throw new ResearchProviderError(
					"Connect Perplexity before searching for people.",
				);
			const budgetId = `research:${new Date().toISOString().slice(0, 7)}`;
			if (
				!(await reserveOutreachBudget(
					db,
					budgetId,
					OUTREACH.researchReserveMicroUsd,
					OUTREACH.monthlyMicroUsd,
				))
			)
				throw new ResearchProviderError(
					"Monthly US$10 research budget reached.",
				);
			const result = await fetchContactResearch(body, key, async (actual) => {
				await settleOutreachBudget(
					db,
					budgetId,
					OUTREACH.researchReserveMicroUsd,
					actual,
				);
			});
			candidates = result.candidates;
		}
		const verified: VerifiedContactCandidate[] = [];
		let unavailableSources = 0;
		let rejectedAssociations = 0;
		for (const candidate of candidates) {
			const source = await readSource(candidate.sourceUrl);
			if (!source) {
				unavailableSources += 1;
				continue;
			}
			const result = verifyContactCandidate(
				candidate,
				row.domain,
				row.email,
				source.text,
				source.url,
			);
			if (!result) rejectedAssociations += 1;
			if (result && !verified.some((item) => item.id === result.id))
				verified.push(result);
		}
		verified.sort((left, right) => rank(left) - rank(right));
		await db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${OUTREACH.id} FOR UPDATE`;
			await tx.$queryRaw`SELECT id FROM "outreachProspect" WHERE id = ${id} FOR UPDATE`;
			const current = await tx.outreachProspect.findUniqueOrThrow({
				where: { id },
			});
			const currentJob = await tx.outreachContactResearch.findUniqueOrThrow({
				where: { prospectId: id },
			});
			const campaign = await tx.outreachCampaign.findUniqueOrThrow({
				where: { id: OUTREACH.id },
			});
			if (
				(campaign.sendLeaseUntil && campaign.sendLeaseUntil > new Date()) ||
				(await suppressed(tx, current.domain, current.email)) ||
				!(await companyAvailable(tx, current, campaign.ownerId))
			)
				return;
			if (
				currentJob.lease !== lease ||
				!currentJob.leaseUntil ||
				currentJob.leaseUntil <= new Date() ||
				!available(current, new Date()) ||
				current.status !== row.status ||
				current.manual !== row.manual ||
				current.pilotSlot !== row.pilotSlot ||
				current.companyId !== row.companyId ||
				current.contactId !== row.contactId ||
				contactResearchInputHash(current) !== contactResearchInputHash(row) ||
				(await tx.outreachDelivery.count({ where: { prospectId: id } })) ||
				(!job.submittedCandidates &&
					(!campaign.researchEnabled || campaign.researchLease !== lease))
			)
				return;
			const adopted =
				!job.submittedCandidates &&
				(await adoptNewContact(tx, current, verified, campaign.ownerId));
			await tx.outreachContactResearch.update({
				where: { prospectId: id },
				data: {
					status: adopted ? "SELECTED" : verified.length ? "READY" : "HELD",
					candidates: verified,
					submittedCandidates: Prisma.DbNull,
					completedAt: new Date(),
					dueAt: null,
					error: verified.length
						? null
						: `Candidates from ${job.submittedCandidates ? "owner input" : "research provider"}: ${candidates.length}. Sources unavailable: ${unavailableSources}. Associations rejected: ${rejectedAssociations}. No current official contact association passed verification. Existing contact remains unchanged.`,
				},
			});
		});
	} catch (error) {
		const safe =
			error instanceof ResearchProviderError
				? error.message
				: "Contact source verification failed. Existing contact remains unchanged.";
		await db.outreachContactResearch.updateMany({
			where: { prospectId: id, lease },
			data: { status: "HELD", dueAt: null, error: safe },
		});
		if (error instanceof ResearchProviderError && error.pauseResearch)
			await db.outreachCampaign.updateMany({
				where: { id: OUTREACH.id, researchLease: lease },
				data: { researchEnabled: false, lastResearchError: safe },
			});
	} finally {
		await db.outreachContactResearch.updateMany({
			where: { prospectId: id, lease, status: "RESEARCHING" },
			data: {
				status: "HELD",
				dueAt: null,
				error:
					"Prospect state changed during contact verification. Review before retrying.",
			},
		});
		await db.outreachContactResearch.updateMany({
			where: { prospectId: id, lease },
			data: { lease: null, leaseUntil: null },
		});
		await db.outreachCampaign.updateMany({
			where: { id: OUTREACH.id, researchLease: lease },
			data: { researchLease: null, researchLeaseUntil: null },
		});
	}
}

export async function runOutreachContactResearch() {
	if (process.env.VERCEL_ENV !== "production") return;
	const now = new Date();
	await db.outreachContactResearch.updateMany({
		where: {
			status: "RESEARCHING",
			attempts: { gte: CONTACT_RESEARCH.maxAttempts },
			OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
		},
		data: {
			status: "HELD",
			dueAt: null,
			lease: null,
			leaseUntil: null,
			error:
				"Contact research attempts exhausted after an interrupted run. Review before retrying.",
		},
	});
	const jobs = await db.outreachContactResearch.findMany({
		where: {
			status: { in: ["PENDING", "RESEARCHING"] },
			dueAt: { lte: now },
			attempts: { lt: CONTACT_RESEARCH.maxAttempts },
			OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
			prospect: {
				campaignId: OUTREACH.id,
				status: { in: ["HELD", "READY", "MANUAL"] },
				initialSentAt: null,
				stoppedAt: null,
				deliveries: { none: {} },
				companyId: { not: null },
				AND: [
					{
						OR: [
							{ emailDraftLeaseUntil: null },
							{ emailDraftLeaseUntil: { lte: now } },
						],
					},
					{
						OR: [
							{ sourceVerificationLeaseUntil: null },
							{ sourceVerificationLeaseUntil: { lte: now } },
						],
					},
				],
			},
		},
		orderBy: [
			{ prospect: { pilotSlot: { sort: "asc", nulls: "last" } } },
			{ dueAt: "asc" },
		],
		take: CONTACT_RESEARCH.perTick,
	});
	for (const job of jobs) await runCandidate(job.prospectId);
}
