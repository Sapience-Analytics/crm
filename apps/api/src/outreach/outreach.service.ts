import { createHash } from "node:crypto";
import { type Db, Prisma } from "@crm/db";
import {
	consentSchema,
	contactEligible,
	DEFAULT_TEMPLATES,
	evidenceSchema,
	OUTREACH,
	outreachReportSchema,
	readinessSchema,
	renderEmail,
	templatesSchema,
} from "@crm/validation/outreach";
import {
	BadRequestException,
	ForbiddenException,
	Injectable,
} from "@nestjs/common";
import type { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import { MailboxTokenService } from "../mailbox/mailbox-token.service";
import type {
	campaignActionInput,
	prospectApproveInput,
} from "./outreach.contracts";

export function campaignHash(templates: z.infer<typeof templatesSchema>) {
	return createHash("sha256")
		.update(JSON.stringify({ templates, rules: OUTREACH }))
		.digest("hex");
}

@Injectable()
export class OutreachService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly tokens: MailboxTokenService,
	) {}

	async assertOwner(userId: string) {
		const user = await this.db.user.findUniqueOrThrow({
			where: { id: userId },
			select: { email: true },
		});
		if (user.email.toLowerCase() !== OUTREACH.sender)
			throw new ForbiddenException(
				"Only the campaign sender can manage this campaign.",
			);
	}

	async initialize(userId: string) {
		await this.assertOwner(userId);
		await this.db.outreachCampaign.upsert({
			where: { id: OUTREACH.id },
			update: {},
			create: {
				id: OUTREACH.id,
				ownerId: userId,
				senderEmail: OUTREACH.sender,
				templates: DEFAULT_TEMPLATES,
			},
		});
		return { ok: true };
	}

	async status(userId: string) {
		await this.assertOwner(userId);
		const row = await this.db.outreachCampaign.findUnique({
			where: { id: OUTREACH.id },
		});
		const templates = templatesSchema.parse(
			row?.templates ?? DEFAULT_TEMPLATES,
		);
		const hash = campaignHash(templates);
		const [counts, budgets, reports, scopes] = await Promise.all([
			this.db.outreachProspect.groupBy({
				by: ["status"],
				where: { campaignId: OUTREACH.id },
				_count: true,
			}),
			this.db.outreachBudget.findMany({
				where: { id: { contains: new Date().toISOString().slice(0, 7) } },
				select: {
					id: true,
					reservedMicroUsd: true,
					actualMicroUsd: true,
					calls: true,
				},
			}),
			this.db.outreachReport.findMany({
				where: { campaignId: OUTREACH.id },
				orderBy: { week: "desc" },
				take: 8,
			}),
			this.tokens.grantedScopes(userId, "google"),
		]);
		return {
			exists: row !== null,
			status: row?.status ?? "NOT_CREATED",
			hash,
			templates,
			approved: row?.approvedHash === hash,
			researchEnabled: row?.researchEnabled ?? false,
			sendConnected: scopes.has("https://www.googleapis.com/auth/gmail.send"),
			ready: readinessSchema.safeParse(row?.readiness).success,
			lastError: row?.lastError ?? null,
			researchError: row?.lastResearchError ?? null,
			lastTickAt: row?.lastTickAt?.toISOString() ?? null,
			lastResearchAt: row?.lastResearchAt?.toISOString() ?? null,
			counts: counts.map((group) => ({
				status: group.status,
				count: group._count,
			})),
			budgets,
			reports: reports.map((report) => ({
				week: report.week.toISOString(),
				summary: outreachReportSchema.parse(report.summary),
			})),
		};
	}

	async update(userId: string, templates: z.infer<typeof templatesSchema>) {
		await this.assertOwner(userId);
		if (
			!/reply unsubscribe/i.test(templates.signature) ||
			!templates.signature.includes(OUTREACH.sender)
		) {
			throw new BadRequestException(
				"Keep sender identification and reply unsubscribe in the signature.",
			);
		}
		await this.db.outreachCampaign.update({
			where: { id: OUTREACH.id },
			data: {
				templates,
				status: "PAUSED",
				approvedAt: null,
				approvedHash: null,
				readiness: Prisma.DbNull,
			},
		});
		return { ok: true };
	}

	async readiness(userId: string, input: z.infer<typeof readinessSchema>) {
		await this.assertOwner(userId);
		await this.db.outreachCampaign.update({
			where: { id: OUTREACH.id },
			data: { readiness: input },
		});
		return { ok: true };
	}

	async action(userId: string, input: z.infer<typeof campaignActionInput>) {
		await this.assertOwner(userId);
		const row = await this.db.outreachCampaign.findUniqueOrThrow({
			where: { id: OUTREACH.id },
		});
		const hash = campaignHash(templatesSchema.parse(row.templates));
		if (input.action === "research-on" || input.action === "research-off") {
			await this.db.outreachCampaign.update({
				where: { id: row.id },
				data: {
					researchEnabled: input.action === "research-on",
					researchDueAt: new Date(),
				},
			});
		} else if (input.action === "approve") {
			if (input.hash !== hash)
				throw new BadRequestException(
					"The campaign changed. Read the current templates first.",
				);
			await this.db.outreachCampaign.update({
				where: { id: row.id },
				data: { approvedHash: hash, approvedAt: new Date(), status: "PAUSED" },
			});
		} else if (input.action === "pause") {
			await this.db.outreachCampaign.update({
				where: { id: row.id },
				data: { status: "PAUSED" },
			});
		} else {
			if (
				row.approvedHash !== hash ||
				!readinessSchema.safeParse(row.readiness).success
			)
				throw new BadRequestException(
					"Approve current templates and record launch checks first.",
				);
			const scopes = await this.tokens.grantedScopes(userId, "google");
			if (!scopes.has("https://www.googleapis.com/auth/gmail.send"))
				throw new BadRequestException(
					"Reconnect Gmail with sending permission.",
				);
			const manual = await this.db.outreachProspect.count({
				where: { campaignId: row.id, manual: true, pilotSlot: { not: null } },
			});
			const pilot = await this.db.outreachProspect.count({
				where: { campaignId: row.id, pilotSlot: { not: null } },
			});
			if (manual !== OUTREACH.manualSize || pilot !== OUTREACH.pilotSize)
				throw new BadRequestException("Qualify the 12 pilot prospects first.");
			if (input.action === "start-active") {
				const sent = await this.db.outreachDelivery.count({
					where: {
						stage: 0,
						status: "SENT",
						loggedAt: { not: null },
						prospect: { pilotSlot: { not: null }, manual: false },
					},
				});
				const uncertain = await this.db.outreachDelivery.count({
					where: { status: { in: ["SENDING", "UNKNOWN"] } },
				});
				if (
					sent !== OUTREACH.pilotSize - OUTREACH.manualSize ||
					uncertain !== 0
				)
					throw new BadRequestException(
						"Finish and reconcile the automated pilot first.",
					);
			}
			await this.db.outreachCampaign.update({
				where: { id: row.id },
				data: {
					status: input.action === "start-pilot" ? "PILOT" : "ACTIVE",
					pilotPassedAt:
						input.action === "start-active" ? new Date() : undefined,
				},
			});
		}
		return { ok: true };
	}

	async qualify(userId: string, input: z.infer<typeof prospectApproveInput>) {
		await this.assertOwner(userId);
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${OUTREACH.id} FOR UPDATE`;
			const prospect = await tx.outreachProspect.findUniqueOrThrow({
				where: { id: input.id },
			});
			if (prospect.status !== "HELD" || prospect.campaignId !== OUTREACH.id)
				throw new BadRequestException(
					"Only held campaign prospects can be qualified.",
				);
			const evidence = evidenceSchema.parse(prospect.evidence);
			const consent = consentSchema.parse({
				...input.consent,
				verifiedBy: userId,
				verifiedAt: new Date().toISOString(),
			});
			if (!contactEligible(evidence, consent))
				throw new BadRequestException(
					"Verified research and a published email are required.",
				);
			if (
				prospect.email &&
				(await tx.outreachSuppression.findUnique({
					where: { email: prospect.email },
				}))
			)
				throw new BadRequestException("This address is suppressed.");
			const slots = await tx.outreachProspect.count({
				where: { pilotSlot: { not: null } },
			});
			const slot = slots < OUTREACH.pilotSize ? slots + 1 : null;
			const manual = slot !== null && slot <= OUTREACH.manualSize;
			await tx.outreachProspect.update({
				where: { id: prospect.id },
				data: {
					consent,
					stopReason: null,
					pilotSlot: slot,
					manual,
					status: manual ? "MANUAL" : "READY",
				},
			});
		});
		return { ok: true };
	}

	async stop(userId: string, id: string) {
		await this.assertOwner(userId);
		await this.db.$transaction(async (tx) => {
			const row = await tx.outreachProspect.update({
				where: { id, campaignId: OUTREACH.id },
				data: {
					status: "SUPPRESSED",
					stopReason: "Stopped by campaign owner",
					stoppedAt: new Date(),
				},
			});
			if (row.email)
				await tx.outreachSuppression.upsert({
					where: { email: row.email },
					update: {},
					create: { email: row.email, reason: "Stopped by campaign owner" },
				});
		});
		return { ok: true };
	}

	async prospects(userId: string, page: number) {
		await this.assertOwner(userId);
		const campaign = await this.db.outreachCampaign.findUnique({
			where: { id: OUTREACH.id },
		});
		const templates = templatesSchema.parse(
			campaign?.templates ?? DEFAULT_TEMPLATES,
		);
		const where = { campaignId: OUTREACH.id };
		const [rows, total] = await Promise.all([
			this.db.outreachProspect.findMany({
				where,
				orderBy: { createdAt: "desc" },
				skip: page * 50,
				take: 50,
			}),
			this.db.outreachProspect.count({ where }),
		]);
		return {
			total,
			rows: rows.map((row) => {
				const evidence = evidenceSchema.parse(row.evidence);
				return {
					id: row.id,
					company: evidence.company,
					email: row.email,
					status: row.status,
					manual: row.manual,
					sourceUrl: evidence.sourceUrl,
					sourceQuote: evidence.sourceQuote,
					fleetBand: evidence.fleetBand,
					fit: evidence.fit,
					verified: evidence.verified,
					consent: row.consent,
					replyDraft: row.replyDraft,
					stopReason: row.stopReason,
					preview: renderEmail(templates, evidence, 0),
				};
			}),
		};
	}
}
