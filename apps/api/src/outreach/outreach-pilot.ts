import type { Db, Prisma } from "@crm/db";
import { OUTREACH } from "@crm/validation/outreach";
import { OUTREACH_AUTOMATION } from "@crm/validation/outreach-referrals";

export async function pilotProgress(
	db: Db | Prisma.TransactionClient,
	campaignId: string,
	now: Date,
) {
	const pilot = await db.outreachProspect.findMany({
		where: { campaignId, pilotSlot: { not: null }, referredFromId: null },
	});
	if (
		pilot.length !== OUTREACH.pilotSize ||
		pilot.filter((row) => row.manual).length !== OUTREACH.manualSize
	) {
		return {
			ready: false,
			blocked: false,
			reason: "The original twelve pilot assignments are required.",
		};
	}
	const bounced = await db.outreachProspect.count({
		where: {
			campaignId,
			domain: { in: pilot.map((row) => row.domain) },
			status: "BOUNCED",
		},
	});
	if (bounced)
		return {
			ready: false,
			blocked: true,
			reason: "A pilot email bounced. Review the recipient before expansion.",
		};
	if (
		pilot.some(
			(row) =>
				!row.manual &&
				!["BOOKED", "SUPPRESSED"].includes(row.status) &&
				(!row.lastCheckedAt ||
					now.getTime() - row.lastCheckedAt.getTime() > OUTREACH.leaseMs * 3),
		)
	) {
		return {
			ready: false,
			blocked: false,
			reason:
				"Fresh mailbox checks are required for all ten automated pilot contacts.",
		};
	}
	const uncertain = await db.outreachDelivery.count({
		where: { prospect: { campaignId }, status: { in: ["SENDING", "UNKNOWN"] } },
	});
	const sent = await db.outreachDelivery.findMany({
		where: {
			prospectId: {
				in: pilot.filter((row) => !row.manual).map((row) => row.id),
			},
			stage: 0,
			status: "SENT",
			loggedAt: { not: null },
			sentAt: { not: null },
		},
		orderBy: { sentAt: "desc" },
	});
	if (
		uncertain ||
		sent.length !== OUTREACH.pilotSize - OUTREACH.manualSize ||
		!sent[0]?.sentAt
	) {
		return {
			ready: false,
			blocked: false,
			reason:
				"Finish and reconcile the ten automated pilot introductions first.",
		};
	}
	const after = new Date(sent[0].sentAt);
	let days = OUTREACH_AUTOMATION.pilotObservationBusinessDays;
	while (days > 0) {
		after.setTime(after.getTime() + OUTREACH.dayMs);
		const day = new Date(after.getTime() + OUTREACH.offsetMs).getUTCDay();
		if (day !== 0 && day !== 6) days -= 1;
	}
	return {
		ready: now >= after,
		blocked: false,
		reason:
			"Observe the completed pilot for one business day before expansion.",
	};
}
