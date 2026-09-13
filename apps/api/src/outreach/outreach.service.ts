import { type Db, Prisma } from "@crm/db";
import {
	consentSchema,
	contactEligible,
	DEFAULT_TEMPLATES,
	evidenceSchema,
	OUTREACH,
	outreachReportSchema,
	readinessSchema,
	templatesSchema,
} from "@crm/validation/outreach";
import {
	campaignHash,
	currentDraft,
	draftReviewHash,
} from "@crm/validation/outreach-draft-state";
import { referralDecisionSchema } from "@crm/validation/outreach-referrals";
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
	outreachPageInput,
	prospectApproveInput,
} from "./outreach.contracts";
import { verifiedOutreachContact } from "./outreach-contact";
import { pilotProgress } from "./outreach-pilot";

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
		const [
			counts,
			budgets,
			reports,
			scopes,
			pilot,
			deliveryStates,
			referralHolds,
			unsettledProspects,
			expansion,
		] = await Promise.all([
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
			this.db.outreachProspect.findMany({
				where: { campaignId: OUTREACH.id, pilotSlot: { not: null } },
			}),
			this.db.outreachDelivery.groupBy({
				by: ["status"],
				where: {
					prospect: { campaignId: OUTREACH.id },
					status: { in: ["SENDING", "UNKNOWN"] },
				},
				_count: true,
			}),
			this.db.outreachProspect.count({
				where: {
					campaignId: OUTREACH.id,
					referrals: { some: { status: "HELD" } },
				},
			}),
			this.db.outreachProspect.count({
				where: {
					campaignId: OUTREACH.id,
					deliveries: { some: { status: { in: ["SENDING", "UNKNOWN"] } } },
				},
			}),
			pilotProgress(this.db, OUTREACH.id, new Date()),
		]);
		const draftReadyCount = pilot.filter((prospect) =>
			currentDraft(prospect, templates),
		).length;
		const reviewedCount = pilot.filter((prospect) => {
			const draft = currentDraft(prospect, templates);
			return (
				draft && prospect.emailDraftReviewedHash === draftReviewHash(draft)
			);
		}).length;
		const eligibility = await Promise.all(
			pilot.map(async (prospect) => {
				if (
					!["READY", "MANUAL"].includes(prospect.status) ||
					!currentDraft(prospect, templates) ||
					!prospect.email
				)
					return false;
				try {
					await verifiedOutreachContact(this.db, prospect, userId);
				} catch {
					return false;
				}
				const blocked =
					(await this.db.outreachSuppression.findUnique({
						where: { email: prospect.email },
					})) ||
					(await this.db.suppressedContact.findUnique({
						where: { email: prospect.email },
					})) ||
					(await this.db.suppressedDomain.findFirst({
						where: {
							domain: {
								in: [
									prospect.domain,
									prospect.email.split("@")[1] ?? prospect.domain,
								],
							},
						},
					}));
				return !blocked;
			}),
		);
		const eligibleCount = eligibility.filter(Boolean).length;
		return {
			exists: row !== null,
			status: row?.status ?? "NOT_CREATED",
			hash,
			templates,
			approved: row?.approvedHash === hash,
			researchEnabled: row?.researchEnabled ?? false,
			sendConnected: scopes.has("https://www.googleapis.com/auth/gmail.send"),
			ready: readinessSchema.safeParse(row?.readiness).success,
			pilotCount: pilot.length,
			pilotProgress: expansion,
			draftReadyCount,
			reviewedCount,
			reviewQueue: {
				replies:
					counts.find((group) => group.status === "REPLIED")?._count ?? 0,
				referrals: referralHolds,
				qualification:
					counts.find((group) => group.status === "HELD")?._count ?? 0,
				deliveries: unsettledProspects,
			},
			deliveries: {
				inProgress:
					deliveryStates.find((group) => group.status === "SENDING")?._count ??
					0,
				unconfirmed:
					deliveryStates.find((group) => group.status === "UNKNOWN")?._count ??
					0,
			},
			pilotReady:
				pilot.length === OUTREACH.pilotSize &&
				eligibleCount === OUTREACH.pilotSize &&
				reviewedCount === OUTREACH.pilotSize &&
				pilot.filter((prospect) => prospect.manual).length ===
					OUTREACH.manualSize,
			aiPausedReason: row?.aiPausedReason ?? null,
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
		await this.db.$transaction(async (tx) => {
			await tx.outreachCampaign.update({
				where: { id: OUTREACH.id },
				data: {
					templates,
					status: "PAUSED",
					approvedAt: null,
					approvedHash: null,
					readiness: Prisma.DbNull,
				},
			});
			await tx.outreachProspect.updateMany({
				where: { campaignId: OUTREACH.id, initialSentAt: null },
				data: {
					emailDraftStatus: "STALE",
					emailDrafts: Prisma.DbNull,
					emailDraftHash: null,
					emailDraftDueAt: new Date(),
					emailDraftAttempts: 0,
					emailDraftReviewedHash: null,
					emailDraftReviewedAt: null,
					emailDraftError:
						"Templates changed. New AI drafts and review are required.",
				},
			});
			await tx.outreachProspect.updateMany({
				where: { campaignId: OUTREACH.id, initialSentAt: { not: null } },
				data: {
					emailDraftStatus: "HELD",
					emailDraftError:
						"Templates changed after sending started. Existing sent messages stay unchanged; follow-ups are held.",
				},
			});
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
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${OUTREACH.id} FOR UPDATE`;
			const row = await tx.outreachCampaign.findUniqueOrThrow({
				where: { id: OUTREACH.id },
			});
			const hash = campaignHash(templatesSchema.parse(row.templates));
			if (input.action === "research-on" || input.action === "research-off") {
				await tx.outreachCampaign.update({
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
				await tx.outreachCampaign.update({
					where: { id: row.id },
					data: {
						approvedHash: hash,
						approvedAt: new Date(),
						status: "PAUSED",
					},
				});
			} else if (input.action === "pause") {
				await tx.outreachCampaign.update({
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
				const manual = await tx.outreachProspect.count({
					where: { campaignId: row.id, manual: true, pilotSlot: { not: null } },
				});
				const pilot = await tx.outreachProspect.count({
					where: { campaignId: row.id, pilotSlot: { not: null } },
				});
				if (manual !== OUTREACH.manualSize || pilot !== OUTREACH.pilotSize)
					throw new BadRequestException(
						"Qualify the 12 pilot prospects first.",
					);
				if (input.action === "start-pilot") {
					const prospects = await tx.outreachProspect.findMany({
						where: { campaignId: row.id, pilotSlot: { not: null } },
					});
					if (
						prospects.some((prospect) => {
							const draft = currentDraft(
								prospect,
								templatesSchema.parse(row.templates),
							);
							return (
								!["READY", "MANUAL"].includes(prospect.status) ||
								!draft ||
								prospect.emailDraftReviewedHash !== draftReviewHash(draft)
							);
						})
					)
						throw new BadRequestException(
							"All 12 eligible prospects need current AI drafts for all three stages and a recorded preview review.",
						);
					for (const prospect of prospects) {
						await verifiedOutreachContact(tx, prospect, userId);
						if (
							!prospect.email ||
							(await tx.outreachSuppression.findUnique({
								where: { email: prospect.email },
							})) ||
							(await tx.suppressedContact.findUnique({
								where: { email: prospect.email },
							})) ||
							(await tx.suppressedDomain.findFirst({
								where: {
									domain: {
										in: [
											prospect.domain,
											prospect.email.split("@")[1] ?? prospect.domain,
										],
									},
								},
							}))
						)
							throw new BadRequestException(
								"A pilot prospect is suppressed. Sending remains paused.",
							);
					}
				}
				if (input.action === "start-active") {
					const progress = await pilotProgress(tx, row.id, new Date());
					if (!progress.ready) throw new BadRequestException(progress.reason);
					const sent = await tx.outreachDelivery.count({
						where: {
							stage: 0,
							status: "SENT",
							loggedAt: { not: null },
							prospect: { pilotSlot: { not: null }, manual: false },
						},
					});
					const uncertain = await tx.outreachDelivery.count({
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
				await tx.outreachCampaign.update({
					where: { id: row.id },
					data: {
						status: input.action === "start-pilot" ? "PILOT" : "ACTIVE",
						pilotPassedAt:
							input.action === "start-active" ? new Date() : undefined,
					},
				});
			}
		});
		return { ok: true };
	}

	async qualify(userId: string, input: z.infer<typeof prospectApproveInput>) {
		await this.assertOwner(userId);
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${OUTREACH.id} FOR UPDATE`;
			await tx.$queryRaw`SELECT id FROM "outreachProspect" WHERE id = ${input.id} FOR UPDATE`;
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
				((await tx.outreachSuppression.findUnique({
					where: { email: prospect.email },
				})) ||
					(await tx.suppressedContact.findUnique({
						where: { email: prospect.email },
					})) ||
					(await tx.suppressedDomain.findFirst({
						where: {
							domain: {
								in: [
									prospect.domain,
									prospect.email.split("@")[1] ?? prospect.domain,
								],
							},
						},
					})))
			)
				throw new BadRequestException("This address is suppressed.");
			const slots = await tx.outreachProspect.count({
				where: { pilotSlot: { not: null } },
			});
			const slot =
				prospect.pilotSlot ?? (slots < OUTREACH.pilotSize ? slots + 1 : null);
			const manual =
				prospect.pilotSlot !== null
					? prospect.manual
					: prospect.manual || (slot !== null && slot <= OUTREACH.manualSize);
			await tx.outreachProspect.update({
				where: { id: prospect.id },
				data: {
					consent,
					stopReason: null,
					pilotSlot: slot,
					manual,
					status: manual ? "MANUAL" : "READY",
					emailDraftDueAt: new Date(),
				},
			});
		});
		return { ok: true };
	}

	async stop(userId: string, id: string) {
		await this.assertOwner(userId);
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${OUTREACH.id} FOR UPDATE`;
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
			await tx.outreachProspect.updateMany({
				where: {
					campaignId: row.campaignId,
					domain: row.domain,
					id: { not: row.id },
				},
				data: {
					status: "SUPPRESSED",
					stoppedAt: new Date(),
					stopReason: "Related company sequence stopped by campaign owner",
					replyDraft: null,
				},
			});
		});
		return { ok: true };
	}

	async prospects(
		userId: string,
		page: number,
		view: z.infer<typeof outreachPageInput>["view"] = "all",
	) {
		await this.assertOwner(userId);
		const campaign = await this.db.outreachCampaign.findUnique({
			where: { id: OUTREACH.id },
		});
		const templates = templatesSchema.parse(
			campaign?.templates ?? DEFAULT_TEMPLATES,
		);
		const where: Prisma.OutreachProspectWhereInput = {
			campaignId: OUTREACH.id,
		};
		if (view === "replies") where.status = "REPLIED";
		if (view === "qualification") where.status = "HELD";
		if (view === "referrals") where.referrals = { some: { status: "HELD" } };
		if (view === "deliveries")
			where.deliveries = { some: { status: { in: ["SENDING", "UNKNOWN"] } } };
		const [rows, total] = await Promise.all([
			this.db.outreachProspect.findMany({
				where,
				orderBy: { createdAt: "desc" },
				skip: page * 50,
				take: 50,
				include: {
					referralParent: {
						select: {
							id: true,
							evidence: true,
							email: true,
							status: true,
							stoppedAt: true,
						},
					},
					referrals: {
						select: {
							id: true,
							status: true,
							decision: true,
							error: true,
							createdAt: true,
						},
						orderBy: { createdAt: "desc" },
					},
					deliveries: {
						where: { status: { in: ["SENDING", "UNKNOWN"] } },
						select: {
							id: true,
							stage: true,
							status: true,
							lastError: true,
							createdAt: true,
						},
						orderBy: { createdAt: "desc" },
					},
				},
			}),
			this.db.outreachProspect.count({ where }),
		]);
		return {
			total,
			rows: rows.map((row) => {
				const evidence = evidenceSchema.parse(row.evidence);
				const draft = currentDraft(row, templates);
				return {
					id: row.id,
					company: evidence.company,
					email: row.email,
					status: row.status,
					manual: row.manual,
					sourceUrl: evidence.sourceUrl,
					sourceQuote: evidence.sourceQuote,
					contactSourceUrl: evidence.contactSourceUrl ?? null,
					contactRoleQuote: evidence.contactRoleQuote ?? null,
					fleetBand: evidence.fleetBand,
					fit: evidence.fit,
					verified: evidence.verified,
					consent: row.consent,
					replyDraft: row.replyDraft,
					replyText: row.replyText,
					stopReason: row.stopReason,
					stoppedAt: row.stoppedAt?.toISOString() ?? null,
					eligibilityError: row.eligibilityError,
					referralDepth: row.referralDepth,
					referredFrom: row.referralParent
						? {
								id: row.referralParent.id,
								company: evidenceSchema.parse(row.referralParent.evidence)
									.company,
								email: row.referralParent.email,
								status: row.referralParent.status,
								stoppedAt: row.referralParent.stoppedAt?.toISOString() ?? null,
							}
						: null,
					referrals: row.referrals.map((referral) => {
						const parsed = referralDecisionSchema.safeParse(referral.decision);
						const decision = parsed.success ? parsed.data : null;
						return {
							id: referral.id,
							status: referral.status,
							reason:
								referral.error ??
								(decision?.kind === "none" ? decision.reason : null),
							recipientEmail:
								decision?.kind === "referral" ? decision.email : null,
							recipientName:
								decision?.kind === "referral" ? decision.name : null,
							createdAt: referral.createdAt.toISOString(),
						};
					}),
					deliveries: row.deliveries.map((delivery) => ({
						id: delivery.id,
						stage: delivery.stage,
						status: delivery.status,
						error: delivery.lastError,
						createdAt: delivery.createdAt.toISOString(),
					})),
					draft: {
						status: draft
							? "READY"
							: row.emailDraftStatus === "READY"
								? "STALE"
								: row.emailDraftStatus,
						hold: draft
							? null
							: (row.emailDraftError ??
								"Current verified research, eligibility, and all three AI drafts are required."),
						generatedAt: row.emailDraftGeneratedAt?.toISOString() ?? null,
						model: row.emailDraftModel,
						reviewHash: draft ? draftReviewHash(draft) : null,
						reviewedAt:
							draft && row.emailDraftReviewedHash === draftReviewHash(draft)
								? (row.emailDraftReviewedAt?.toISOString() ?? null)
								: null,
						stages: draft?.stages ?? [],
					},
				};
			}),
		};
	}

	async reviewDrafts(userId: string, id: string, hash: string) {
		await this.assertOwner(userId);
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${OUTREACH.id} FOR UPDATE`;
			await tx.$queryRaw`SELECT id FROM "outreachProspect" WHERE id = ${id} FOR UPDATE`;
			const campaign = await tx.outreachCampaign.findUniqueOrThrow({
				where: { id: OUTREACH.id },
			});
			const row = await tx.outreachProspect.findUniqueOrThrow({
				where: { id, campaignId: OUTREACH.id },
			});
			const draft = currentDraft(
				row,
				templatesSchema.parse(campaign.templates),
			);
			if (!draft || draftReviewHash(draft) !== hash)
				throw new BadRequestException(
					"The drafts changed. Review all three current previews first.",
				);
			await tx.outreachProspect.update({
				where: { id },
				data: {
					emailDraftReviewedHash: hash,
					emailDraftReviewedAt: new Date(),
				},
			});
		});
		return { ok: true };
	}

	async retryDrafts(userId: string, id: string) {
		await this.assertOwner(userId);
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${OUTREACH.id} FOR UPDATE`;
			await tx.$queryRaw`SELECT id FROM "outreachProspect" WHERE id = ${id} FOR UPDATE`;
			const campaign = await tx.outreachCampaign.findUniqueOrThrow({
				where: { id: OUTREACH.id },
			});
			const row = await tx.outreachProspect.findUniqueOrThrow({
				where: { id, campaignId: OUTREACH.id },
			});
			const now = new Date();
			if (
				row.initialSentAt ||
				!["READY", "MANUAL"].includes(row.status) ||
				(row.emailDraftLeaseUntil && row.emailDraftLeaseUntil >= now) ||
				(await tx.outreachDelivery.count({ where: { prospectId: id } }))
			)
				throw new BadRequestException(
					"Only unsent eligible prospects without a delivery or active draft lease can retry drafting.",
				);
			const draft = currentDraft(
				row,
				templatesSchema.parse(campaign.templates),
			);
			if (
				draft &&
				row.emailDraftReviewedAt &&
				row.emailDraftReviewedHash === draftReviewHash(draft)
			)
				throw new BadRequestException(
					"Only unreviewed ready drafts can be regenerated.",
				);
			const evidence = evidenceSchema.safeParse(row.evidence);
			const consent = consentSchema.safeParse(row.consent);
			if (
				!evidence.success ||
				!consent.success ||
				!contactEligible(evidence.data, consent.data)
			)
				throw new BadRequestException(
					"Current verified research and contact eligibility are required to retry drafting.",
				);
			await verifiedOutreachContact(tx, row, userId);
			if (
				!row.email ||
				(await tx.outreachSuppression.findUnique({
					where: { email: row.email },
				})) ||
				(await tx.suppressedContact.findUnique({
					where: { email: row.email },
				})) ||
				(await tx.suppressedDomain.findFirst({
					where: {
						domain: { in: [row.domain, row.email.split("@")[1] ?? row.domain] },
					},
				}))
			)
				throw new BadRequestException("This address is suppressed.");
			await tx.outreachCampaign.update({
				where: { id: OUTREACH.id },
				data: { status: "PAUSED" },
			});
			await tx.outreachProspect.update({
				where: { id },
				data: {
					emailDraftStatus: "PENDING",
					emailDraftHash: null,
					emailDrafts: Prisma.DbNull,
					emailDraftAttempts: 0,
					emailDraftDueAt: now,
					emailDraftLease: null,
					emailDraftLeaseUntil: null,
					emailDraftReviewedHash: null,
					emailDraftReviewedAt: null,
					emailDraftError: null,
				},
			});
		});
		return { ok: true };
	}
}
