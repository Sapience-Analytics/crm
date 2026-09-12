import { db } from "@crm/db";
import {
	consentSchema,
	evidenceSchema,
	OUTREACH,
} from "@crm/validation/outreach";

export function isExplicitFleetRequest(text: string) {
	return (
		/\b(?:geotab|fleet tracking|vehicle tracking)\b/i.test(text) &&
		/\b(?:please (?:contact|call|email)|can you (?:contact|call|email)|(?:i|we) would like (?:a demo|a quote|to discuss))\b/i.test(
			text,
		) &&
		!/unsubscribe|do not|don't|no longer|not interested/i.test(text)
	);
}

export async function qualifyRequestedProspect() {
	if (process.env.VERCEL_ENV !== "production") return;
	const campaign = await db.outreachCampaign.findUnique({
		where: { id: OUTREACH.id },
	});
	if (!campaign?.researchEnabled) return;
	const prospect = await db.outreachProspect.findFirst({
		where: {
			campaignId: campaign.id,
			status: "HELD",
			email: { not: null },
			OR: [
				{ lastCheckedAt: null },
				{ lastCheckedAt: { lt: new Date(Date.now() - OUTREACH.dayMs) } },
			],
		},
		orderBy: { lastCheckedAt: { sort: "asc", nulls: "first" } },
	});
	if (!prospect?.email) return;
	await db.outreachProspect.update({
		where: { id: prospect.id },
		data: { lastCheckedAt: new Date() },
	});
	const evidence = evidenceSchema.parse(prospect.evidence);
	if (
		!evidence.verified ||
		!evidence.contactTarget ||
		evidence.contactTarget.email !== prospect.email
	)
		return;
	const inbound = await db.emailMessage.findFirst({
		where: {
			fromEmail: { equals: prospect.email, mode: "insensitive" },
			direction: "INBOUND",
			syncedByUserId: campaign.ownerId,
			sentAt: {
				gte: new Date(
					Date.now() - OUTREACH.dayMs * OUTREACH.consentLookbackDays,
				),
			},
		},
		orderBy: { sentAt: "desc" },
	});
	if (
		!inbound?.body ||
		!isExplicitFleetRequest(inbound.body.split(/\nOn .+wrote:|\n>/)[0] ?? "")
	)
		return;
	const answered = await db.emailMessage.count({
		where: {
			threadId: inbound.threadId,
			direction: "OUTBOUND",
			sentAt: { gte: inbound.sentAt },
		},
	});
	if (answered) return;
	const consent = consentSchema.parse({
		kind: "express",
		evidence:
			"Recent unanswered inbound request explicitly asks for contact about Geotab or fleet tracking.",
		source: `CRM email ${inbound.id}`,
		roleRelevant: true,
		noRestriction: true,
		verifiedBy: "crm-explicit-request",
		verifiedAt: new Date().toISOString(),
	});
	await db.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${campaign.id} FOR UPDATE`;
		await tx.$queryRaw`SELECT id FROM "outreachProspect" WHERE id = ${prospect.id} FOR UPDATE`;
		const current = await tx.outreachProspect.findUniqueOrThrow({
			where: { id: prospect.id },
		});
		if (
			current.status !== "HELD" ||
			current.email !== prospect.email ||
			current.initialSentAt ||
			current.stoppedAt ||
			JSON.stringify(evidenceSchema.parse(current.evidence)) !==
				JSON.stringify(evidence) ||
			(await tx.outreachDelivery.count({
				where: { prospectId: current.id },
			})) ||
			(await tx.suppressedContact.findFirst({
				where: { email: { equals: prospect.email ?? "", mode: "insensitive" } },
			})) ||
			(await tx.suppressedDomain.findFirst({
				where: {
					domain: {
						in: [
							prospect.domain,
							prospect.email?.split("@")[1] ?? prospect.domain,
						],
						mode: "insensitive",
					},
				},
			})) ||
			(await tx.outreachSuppression.findUnique({
				where: { email: prospect.email ?? "" },
			}))
		)
			return;
		const slots = await tx.outreachProspect.count({
			where: { pilotSlot: { not: null } },
		});
		const slot =
			current.pilotSlot ?? (slots < OUTREACH.pilotSize ? slots + 1 : null);
		const manual =
			current.pilotSlot !== null
				? current.manual
				: slot !== null && slot <= OUTREACH.manualSize;
		await tx.outreachProspect.update({
			where: { id: prospect.id },
			data: {
				consent,
				pilotSlot: slot,
				manual,
				status: manual ? "MANUAL" : "READY",
				stopReason: null,
			},
		});
	});
}
