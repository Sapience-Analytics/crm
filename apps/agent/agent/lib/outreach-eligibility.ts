import { randomUUID } from "node:crypto";
import {
	db,
	type OutreachCampaignModel,
	type OutreachProspectModel,
	Prisma,
} from "@crm/db";
import {
	consentSchema,
	evidenceSchema,
	OUTREACH,
	templatesSchema,
} from "@crm/validation/outreach";
import { campaignHash } from "@crm/validation/outreach-draft-state";
import {
	incomingReferralSchema,
	OUTREACH_AUTOMATION,
} from "@crm/validation/outreach-referrals";
import { assessPublishedEligibility } from "./outreach-eligibility-source";
import { checkProspectSources } from "./outreach-research";

export function isExplicitFleetRequest(text: string) {
	return (
		/\b(?:geotab|fleet tracking|vehicle tracking)\b/i.test(text) &&
		/\b(?:please (?:contact|call|email)|can you (?:contact|call|email)|(?:i|we) would like (?:a demo|a quote|to discuss))\b/i.test(
			text,
		) &&
		!/unsubscribe|do not|don't|no longer|not interested/i.test(text)
	);
}

function approved(campaign: OutreachCampaignModel) {
	const templates = templatesSchema.safeParse(campaign.templates);
	return (
		campaign.senderEmail === OUTREACH.sender &&
		["PILOT", "ACTIVE"].includes(campaign.status) &&
		templates.success &&
		campaign.approvedHash === campaignHash(templates.data)
	);
}

function snapshot(row: OutreachProspectModel) {
	return JSON.stringify({
		email: row.email,
		domain: row.domain,
		companyId: row.companyId,
		contactId: row.contactId,
		evidence: row.evidence,
		consent: row.consent,
		manual: row.manual,
		pilotSlot: row.pilotSlot,
		referredFromId: row.referredFromId,
		referralDepth: row.referralDepth,
	});
}

async function available(
	tx: Prisma.TransactionClient,
	row: OutreachProspectModel,
	ownerId: string,
) {
	const evidence = evidenceSchema.safeParse(row.evidence);
	const now = new Date();
	if (
		row.status !== "HELD" ||
		row.consent ||
		row.initialSentAt ||
		row.stoppedAt ||
		!row.companyId ||
		!row.contactId ||
		!row.email ||
		!evidence.success ||
		!evidence.data.verified ||
		evidence.data.domain !== row.domain ||
		evidence.data.email !== row.email ||
		evidence.data.contactTarget?.email !== row.email ||
		(row.sourceVerificationLeaseUntil &&
			row.sourceVerificationLeaseUntil > now) ||
		(row.emailDraftLeaseUntil && row.emailDraftLeaseUntil > now) ||
		(await tx.outreachDelivery.count({ where: { prospectId: row.id } })) ||
		(await tx.outreachContactResearch.count({
			where: { prospectId: row.id, leaseUntil: { gt: now } },
		}))
	)
		return false;
	const company = await tx.company.findUnique({ where: { id: row.companyId } });
	const contact = await tx.contact.findUnique({ where: { id: row.contactId } });
	if (
		!company ||
		company.archivedAt ||
		company.ownerId !== ownerId ||
		company.domain !== row.domain ||
		!contact ||
		contact.archivedAt ||
		contact.ownerId !== ownerId ||
		contact.companyId !== company.id ||
		contact.email?.toLowerCase() !== row.email
	)
		return false;
	if (
		(await tx.suppressedContact.findFirst({
			where: { email: { equals: row.email, mode: "insensitive" } },
		})) ||
		(await tx.outreachSuppression.findFirst({
			where: { email: { equals: row.email, mode: "insensitive" } },
		})) ||
		(await tx.suppressedDomain.findFirst({
			where: {
				domain: {
					in: [row.domain, row.email.split("@")[1] ?? row.domain],
					mode: "insensitive",
				},
			},
		})) ||
		(await tx.outreachProspect.findFirst({
			where: {
				id: { not: row.id },
				email: { equals: row.email, mode: "insensitive" },
			},
		}))
	)
		return false;
	if (row.referredFromId) {
		const parent = await tx.outreachProspect.findUnique({
			where: { id: row.referredFromId },
		});
		if (
			!parent ||
			parent.campaignId !== row.campaignId ||
			parent.companyId !== row.companyId ||
			parent.domain !== row.domain ||
			parent.status !== "REPLIED" ||
			!parent.stoppedAt ||
			parent.manual !== row.manual ||
			row.referralDepth !== parent.referralDepth + 1 ||
			row.referralDepth > OUTREACH_AUTOMATION.maxReferralDepth ||
			row.pilotSlot !== null
		)
			return false;
	} else if (row.referralDepth !== 0) return false;
	return true;
}

async function explicitRequest(
	tx: Prisma.TransactionClient,
	prospect: OutreachProspectModel,
	owner: OutreachCampaignModel,
) {
	const event = await tx.outreachInbound.findFirst({
		where: { prospectId: prospect.id },
		orderBy: { createdAt: "desc" },
	});
	if (event?.classification !== "REPLIED") return null;
	const parsed = incomingReferralSchema.safeParse(event.message);
	if (!parsed.success) return null;
	const inbound = parsed.data;
	const received = Date.parse(inbound.receivedAt);
	if (
		!inbound.authenticated ||
		!inbound.inCampaignThread ||
		!inbound.rfcMessageId ||
		inbound.messageId !== event.messageId ||
		inbound.fromEmail !== prospect.email ||
		inbound.toEmails.length !== 1 ||
		inbound.toEmails[0] !== owner.senderEmail ||
		received > Date.now() ||
		received < Date.now() - OUTREACH_AUTOMATION.referralMaxAgeMs ||
		!isExplicitFleetRequest(inbound.body) ||
		(await tx.emailMessage.count({
			where: {
				direction: "OUTBOUND",
				syncedByUserId: owner.ownerId,
				sentAt: { gte: new Date(received) },
				thread: { contactId: prospect.contactId },
			},
		}))
	)
		return null;
	return { event, inbound };
}

async function explicitAssessment(
	prospect: OutreachProspectModel,
	owner: OutreachCampaignModel,
) {
	const request = await explicitRequest(db, prospect, owner);
	if (!request) return null;
	const { event, inbound } = request;
	const evidence = evidenceSchema.parse(prospect.evidence);
	if (!(await checkProspectSources(evidence))) return null;
	const checkedAt = new Date().toISOString();
	return {
		ok: true as const,
		assessment: {
			version: OUTREACH_AUTOMATION.version,
			kind: "express",
			checkedAt,
			inboundEventId: event.id,
			messageId: inbound.messageId,
			rfcMessageId: inbound.rfcMessageId,
			email: inbound.fromEmail,
		},
		consent: consentSchema.parse({
			kind: "express",
			evidence:
				"A recent authenticated and unanswered inbound campaign message explicitly requests contact about Geotab or vehicle tracking. The immutable inbound event retains the request and sender evidence.",
			source: `Campaign inbound event ${event.id}`,
			roleRelevant: true,
			noRestriction: true,
			verifiedBy: "authenticated-inbound-request",
			verifiedAt: checkedAt,
		}),
	};
}

export async function qualifyRequestedProspect() {
	if (process.env.VERCEL_ENV !== "production") return;
	const campaign = await db.outreachCampaign.findUnique({
		where: { id: OUTREACH.id },
	});
	if (!campaign || !approved(campaign)) return;
	const now = new Date();
	const candidates = await db.outreachProspect.findMany({
		where: {
			campaignId: campaign.id,
			status: "HELD",
			consent: { equals: Prisma.DbNull },
			email: { not: null },
			initialSentAt: null,
			stoppedAt: null,
			deliveries: { none: {} },
			evidence: { path: ["verified"], equals: true },
			eligibilityDueAt: { lte: now },
			OR: [
				{ eligibilityLeaseUntil: null },
				{ eligibilityLeaseUntil: { lt: now } },
			],
		},
		orderBy: [{ eligibilityDueAt: "asc" }, { createdAt: "asc" }],
		take: OUTREACH_AUTOMATION.eligibility.scanLimit,
	});
	for (const prospect of candidates) {
		const lease = randomUUID();
		const claimed = await db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${campaign.id} FOR UPDATE`;
			await tx.$queryRaw`SELECT id FROM "outreachProspect" WHERE id = ${prospect.id} FOR UPDATE`;
			const currentCampaign = await tx.outreachCampaign.findUniqueOrThrow({
				where: { id: campaign.id },
			});
			const current = await tx.outreachProspect.findUniqueOrThrow({
				where: { id: prospect.id },
			});
			if (
				!approved(currentCampaign) ||
				currentCampaign.approvedHash !== campaign.approvedHash ||
				snapshot(current) !== snapshot(prospect) ||
				!current.eligibilityDueAt ||
				current.eligibilityDueAt > new Date() ||
				(current.eligibilityLeaseUntil &&
					current.eligibilityLeaseUntil > new Date())
			)
				return false;
			if (!(await available(tx, current, currentCampaign.ownerId))) {
				await tx.outreachProspect.updateMany({
					where: {
						id: current.id,
						status: "HELD",
						initialSentAt: null,
						stoppedAt: null,
						consent: { equals: Prisma.DbNull },
					},
					data: {
						eligibilityDueAt: new Date(Date.now() + OUTREACH.leaseMs),
						eligibilityError:
							"Contact binding, suppression or another active task prevents automatic eligibility.",
					},
				});
				return false;
			}
			await tx.outreachProspect.update({
				where: { id: current.id },
				data: {
					eligibilityLease: lease,
					eligibilityLeaseUntil: new Date(Date.now() + OUTREACH.leaseMs),
					eligibilityError: null,
				},
			});
			return true;
		});
		if (!claimed) continue;
		try {
			const explicit = await explicitAssessment(prospect, campaign);
			const priorConversation =
				(await db.outreachInbound.count({
					where: { prospectId: prospect.id },
				})) ||
				(!prospect.referredFromId &&
					(await db.emailThread.count({
						where: { companyId: prospect.companyId, messageCount: { gt: 0 } },
					})));
			const assessment =
				explicit ??
				(priorConversation
					? {
							ok: false as const,
							reason:
								"Existing company correspondence requires a separate contact eligibility assessment.",
						}
					: await assessPublishedEligibility(
							evidenceSchema.parse(prospect.evidence),
						));
			await db.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${campaign.id} FOR UPDATE`;
				await tx.$queryRaw`SELECT id FROM "outreachProspect" WHERE id = ${prospect.id} FOR UPDATE`;
				const currentCampaign = await tx.outreachCampaign.findUniqueOrThrow({
					where: { id: campaign.id },
				});
				const current = await tx.outreachProspect.findUniqueOrThrow({
					where: { id: prospect.id },
				});
				if (
					!approved(currentCampaign) ||
					currentCampaign.approvedHash !== campaign.approvedHash ||
					current.eligibilityLease !== lease ||
					!current.eligibilityLeaseUntil ||
					current.eligibilityLeaseUntil <= new Date() ||
					snapshot(current) !== snapshot(prospect) ||
					!(await available(tx, current, currentCampaign.ownerId))
				)
					return;
				if (!assessment.ok) {
					await tx.outreachProspect.update({
						where: { id: current.id },
						data: {
							eligibilityDueAt: new Date(
								Date.now() + OUTREACH_AUTOMATION.eligibility.retryMs,
							),
							eligibilityError: assessment.reason,
							stopReason: assessment.reason,
						},
					});
					return;
				}
				if (
					Date.now() - Date.parse(assessment.assessment.checkedAt) >
					OUTREACH_AUTOMATION.eligibility.maxAgeMs
				)
					return;
				if ("inboundEventId" in assessment.assessment) {
					const request = await explicitRequest(tx, current, currentCampaign);
					if (request?.event.id !== assessment.assessment.inboundEventId)
						return;
				} else if (
					(await tx.outreachInbound.count({
						where: { prospectId: current.id },
					})) ||
					(!current.referredFromId &&
						(await tx.emailThread.count({
							where: { companyId: current.companyId, messageCount: { gt: 0 } },
						})))
				)
					return;
				const allocated = await tx.outreachProspect.findMany({
					where: { campaignId: campaign.id, pilotSlot: { not: null } },
					select: { pilotSlot: true },
				});
				const used = new Set(allocated.map((item) => item.pilotSlot));
				const slot =
					current.pilotSlot ??
					(current.referredFromId
						? null
						: (Array.from(
								{ length: OUTREACH.pilotSize },
								(_, index) => index + 1,
							).find((value) => !used.has(value)) ?? null));
				const manual =
					current.manual || (slot !== null && slot <= OUTREACH.manualSize);
				await tx.outreachProspect.update({
					where: { id: current.id },
					data: {
						consent: assessment.consent,
						eligibilityAssessment: assessment.assessment,
						eligibilityDueAt: null,
						eligibilityError: null,
						pilotSlot: slot,
						manual,
						status: manual ? "MANUAL" : "READY",
						stopReason: null,
						emailDraftDueAt: new Date(),
					},
				});
			});
		} catch {
			await db.outreachProspect.updateMany({
				where: { id: prospect.id, status: "HELD", eligibilityLease: lease },
				data: {
					eligibilityDueAt: new Date(
						Date.now() + OUTREACH_AUTOMATION.eligibility.retryMs,
					),
					eligibilityError:
						"Automatic contact eligibility could not be verified. The prospect stays held.",
					stopReason:
						"Automatic contact eligibility could not be verified. The prospect stays held.",
				},
			});
		} finally {
			await db.outreachProspect.updateMany({
				where: { id: prospect.id, eligibilityLease: lease },
				data: { eligibilityLease: null, eligibilityLeaseUntil: null },
			});
		}
		return;
	}
}
