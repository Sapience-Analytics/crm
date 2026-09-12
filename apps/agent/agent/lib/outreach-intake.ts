import { randomUUID } from "node:crypto";
import { db } from "@crm/db";
import { evidenceSchema, OUTREACH } from "@crm/validation/outreach";
import { OUTREACH_INTAKE } from "@crm/validation/outreach-intake";
import {
	checkProspectSources,
	ProspectBindingError,
	verifiedProspectBinding,
} from "./outreach-research";

async function verifyCandidate(id: string, ownerId: string) {
	const now = new Date();
	const lease = randomUUID();
	const claimed = await db.outreachProspect.updateMany({
		where: {
			id,
			campaignId: OUTREACH.id,
			status: "HELD",
			manual: false,
			evidence: { path: ["verified"], equals: false },
			sourceVerificationAttempts: { lt: OUTREACH_INTAKE.maxAttempts },
			sourceVerificationDueAt: { lte: now },
			OR: [
				{ sourceVerificationLeaseUntil: null },
				{ sourceVerificationLeaseUntil: { lt: now } },
			],
		},
		data: {
			sourceVerificationAttempts: { increment: 1 },
			sourceVerificationLease: lease,
			sourceVerificationLeaseUntil: new Date(now.getTime() + OUTREACH.leaseMs),
			sourceVerificationDueAt: new Date(
				now.getTime() + OUTREACH_INTAKE.retryMs,
			),
		},
	});
	if (!claimed.count) return;
	const row = await db.outreachProspect.findUniqueOrThrow({ where: { id } });
	try {
		const evidence = evidenceSchema.parse(row.evidence);
		if (
			row.domain !== evidence.domain ||
			row.email !== evidence.email ||
			!(await checkProspectSources(evidence))
		)
			throw new Error(OUTREACH_INTAKE.failedReason);
		await db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachProspect" WHERE id = ${id} FOR UPDATE`;
			const current = await tx.outreachProspect.findUniqueOrThrow({
				where: { id },
			});
			if (
				current.sourceVerificationLease !== lease ||
				!current.sourceVerificationLeaseUntil ||
				current.sourceVerificationLeaseUntil <= new Date() ||
				current.status !== "HELD" ||
				current.manual
			)
				return;
			if (
				current.domain !== row.domain ||
				current.email !== row.email ||
				JSON.stringify(evidenceSchema.parse(current.evidence)) !==
					JSON.stringify(evidence)
			)
				throw new Error(OUTREACH_INTAKE.failedReason);
			const verified = evidenceSchema.parse({
				...evidence,
				verified: true,
				checkedAt: new Date().toISOString(),
			});
			const { company, contact } = await verifiedProspectBinding(
				tx,
				verified,
				ownerId,
			);
			await tx.outreachProspect.update({
				where: { id },
				data: {
					evidence: verified,
					companyId: company?.id,
					contactId: contact?.id,
					stopReason: OUTREACH_INTAKE.verifiedReason,
					sourceVerificationDueAt: null,
				},
			});
		});
	} catch (error) {
		await db.outreachProspect.updateMany({
			where: {
				id,
				sourceVerificationLease: lease,
				status: "HELD",
				manual: false,
				evidence: { path: ["verified"], equals: false },
			},
			data: {
				sourceVerificationDueAt:
					error instanceof ProspectBindingError ||
					row.sourceVerificationAttempts >= OUTREACH_INTAKE.maxAttempts
						? null
						: new Date(Date.now() + OUTREACH_INTAKE.retryMs),
				stopReason:
					error instanceof ProspectBindingError
						? OUTREACH_INTAKE.bindingReason
						: row.sourceVerificationAttempts >= OUTREACH_INTAKE.maxAttempts
							? OUTREACH_INTAKE.exhaustedReason
							: OUTREACH_INTAKE.failedReason,
			},
		});
	} finally {
		await db.outreachProspect.updateMany({
			where: { id, sourceVerificationLease: lease },
			data: {
				sourceVerificationLease: null,
				sourceVerificationLeaseUntil: null,
			},
		});
	}
}

export async function runOutreachIntake() {
	if (process.env.VERCEL_ENV !== "production") return;
	const campaign = await db.outreachCampaign.findUnique({
		where: { id: OUTREACH.id },
	});
	if (!campaign || campaign.senderEmail !== OUTREACH.sender) return;
	const now = new Date();
	await db.outreachProspect.updateMany({
		where: {
			campaignId: campaign.id,
			status: "HELD",
			evidence: { path: ["verified"], equals: false },
			sourceVerificationAttempts: { gte: OUTREACH_INTAKE.maxAttempts },
			sourceVerificationDueAt: { not: null },
			OR: [
				{ sourceVerificationLeaseUntil: null },
				{ sourceVerificationLeaseUntil: { lt: now } },
			],
		},
		data: {
			sourceVerificationDueAt: null,
			sourceVerificationLease: null,
			sourceVerificationLeaseUntil: null,
			stopReason: OUTREACH_INTAKE.exhaustedReason,
		},
	});
	const candidates = await db.outreachProspect.findMany({
		where: {
			campaignId: campaign.id,
			status: "HELD",
			manual: false,
			evidence: { path: ["verified"], equals: false },
			sourceVerificationAttempts: { lt: OUTREACH_INTAKE.maxAttempts },
			sourceVerificationDueAt: { lte: now },
			OR: [
				{ sourceVerificationLeaseUntil: null },
				{ sourceVerificationLeaseUntil: { lt: now } },
			],
		},
		orderBy: [{ sourceVerificationDueAt: "asc" }, { createdAt: "asc" }],
		take: OUTREACH_INTAKE.perTick,
		select: { id: true },
	});
	await Promise.all(
		candidates.map((candidate) =>
			verifyCandidate(candidate.id, campaign.ownerId),
		),
	);
}
