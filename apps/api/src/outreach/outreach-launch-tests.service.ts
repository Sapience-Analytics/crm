import { randomUUID } from "node:crypto";
import { type Db, type OutreachLaunchTestModel } from "@crm/db";
import { OUTREACH, perthDay } from "@crm/validation/outreach";
import {
	launchTestAuth,
	launchTestContent,
	launchTestKind,
	OUTREACH_TESTS,
	recipientHeaderEvidence,
	type startLaunchTestsInput,
} from "@crm/validation/outreach-tests";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import { GmailSyncService } from "../google/gmail-sync.service";
import { MailboxTokenService } from "../mailbox/mailbox-token.service";
import { ThreadWriterService } from "../mailbox/thread-writer.service";
import { OutreachService } from "./outreach.service";
import { OutreachGmail } from "./outreach-gmail";
import {
	classifyOutreachMessage,
	storeOutreachMessage,
} from "./outreach-message";

@Injectable()
export class OutreachLaunchTestsService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly outreach: OutreachService,
		private readonly tokens: MailboxTokenService,
		private readonly gmail: OutreachGmail,
		private readonly parser: GmailSyncService,
		private readonly writer: ThreadWriterService,
	) {}

	async list(userId: string) {
		await this.outreach.assertOwner(userId);
		const rows = await this.db.outreachLaunchTest.findMany({
			where: { ownerId: userId },
			orderBy: { createdAt: "desc" },
			take: OUTREACH_TESTS.recentLimit,
		});
		return {
			rows: rows.map((row) => ({
				id: row.id,
				batchId: row.batchId,
				kind: launchTestKind.parse(row.kind),
				recipientEmail: row.recipientEmail,
				subject: row.subject,
				body: row.body,
				status: row.status,
				rfcMessageId: row.rfcMessageId,
				gmailMessageId: row.gmailMessageId,
				gmailThreadId: row.gmailThreadId,
				loggedAt: row.loggedAt?.toISOString() ?? null,
				responseStatus: row.responseStatus,
				responseAt: row.responseAt?.toISOString() ?? null,
				responseLoggedAt: row.responseLoggedAt?.toISOString() ?? null,
				recipientAuth: row.recipientAuth
					? launchTestAuth.parse(row.recipientAuth)
					: null,
				lastError: row.lastError,
				createdAt: row.createdAt.toISOString(),
			})),
		};
	}

	async start(userId: string, input: z.infer<typeof startLaunchTestsInput>) {
		await this.outreach.assertOwner(userId);
		if (process.env.VERCEL_ENV !== "production")
			throw new BadRequestException(
				"Controlled email sending is enabled only on the production API.",
			);
		const context = await this.writer.context();
		const domain = input.recipientEmail.split("@")[1] ?? "";
		if (
			input.recipientEmail === OUTREACH.sender ||
			context.ourAddresses.has(input.recipientEmail) ||
			context.ourDomains.has(domain)
		)
			throw new BadRequestException(
				"Use a separate owner-controlled external inbox. Self-send cannot verify inbound replies or receiver authentication.",
			);
		if (
			context.suppressedDomains.has(domain) ||
			context.suppressedEmails.has(input.recipientEmail)
		)
			throw new BadRequestException("This test address is suppressed.");
		const token = await this.token(userId, true);
		const now = new Date();
		const day = new Date(`${perthDay(now)}T00:00:00+08:00`);
		const rows = await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${OUTREACH.id} FOR UPDATE`;
			const campaign = await tx.outreachCampaign.findUniqueOrThrow({
				where: { id: OUTREACH.id },
			});
			if (!["DRAFT", "PAUSED"].includes(campaign.status))
				throw new BadRequestException(
					"Pause prospect outreach before controlled tests.",
				);
			if (
				await tx.outreachLaunchTest.count({ where: { batchId: input.batchId } })
			)
				return [];
			if (
				await tx.outreachLaunchTest.count({
					where: { ownerId: userId, status: { in: ["SENDING", "UNKNOWN"] } },
				})
			)
				throw new BadRequestException(
					"Reconcile uncertain test deliveries before starting another test.",
				);
			if (
				(await tx.outreachLaunchTest.count({
					where: { ownerId: userId, createdAt: { gte: day } },
				})) >= OUTREACH_TESTS.dailyMessages
			)
				throw new BadRequestException(
					"The daily limit is two controlled test emails.",
				);
			if (
				await tx.outreachProspect.findUnique({
					where: { email: input.recipientEmail },
				})
			)
				throw new BadRequestException(
					"Use a test inbox that is not a campaign prospect.",
				);
			if (
				await tx.outreachSuppression.findUnique({
					where: { email: input.recipientEmail },
				})
			)
				throw new BadRequestException("This test address is suppressed.");
			const contacts = await tx.contact.findMany({
				where: { email: { equals: input.recipientEmail, mode: "insensitive" } },
			});
			const prior = await tx.outreachLaunchTest.findFirst({
				where: { ownerId: userId, recipientEmail: input.recipientEmail },
			});
			if (
				contacts.some(
					(contact) =>
						contact.id !== prior?.contactId || contact.archivedAt !== null,
				)
			)
				throw new BadRequestException(
					"This address belongs to an existing CRM contact. Use an isolated test inbox.",
				);
			const existing = contacts[0];
			const contact =
				existing ??
				(await tx.contact.create({
					data: {
						firstName: OUTREACH_TESTS.contactName,
						email: input.recipientEmail,
						title: "Owner-confirmed test mailbox",
						ownerId: userId,
						enrichmentStatus: "SKIPPED",
					},
				}));
			const tests = [];
			for (const kind of OUTREACH_TESTS.kinds)
				tests.push(
					await tx.outreachLaunchTest.create({
						data: {
							batchId: input.batchId,
							createdAt: now,
							kind,
							ownerId: userId,
							recipientEmail: input.recipientEmail,
							contactId: contact.id,
							...launchTestContent(kind),
							rfcMessageId: `${randomUUID()}@sapienceanalytics.com.au`,
						},
					}),
				);
			return tests;
		});
		for (const row of rows) {
			try {
				const sent = await this.gmail.send(token, {
					to: row.recipientEmail,
					from: OUTREACH.sender,
					subject: row.subject,
					body: row.body,
					rfcId: row.rfcMessageId,
				});
				await this.db.outreachLaunchTest.update({
					where: { id: row.id },
					data: {
						status: "SENT",
						gmailMessageId: sent.id,
						gmailThreadId: sent.threadId,
						sentAt: new Date(),
					},
				});
				await this.checkWithToken(userId, row.id, token);
			} catch (error) {
				await this.db.outreachLaunchTest.updateMany({
					where: { id: row.id, status: "SENDING" },
					data: { status: "UNKNOWN" },
				});
				await this.error(
					row.id,
					error instanceof Error
						? error.message
						: "Controlled email test failed",
				);
			}
		}
		return { ok: true };
	}

	async check(userId: string, id: string) {
		await this.outreach.assertOwner(userId);
		await this.db.outreachLaunchTest.findFirstOrThrow({
			where: { id, ownerId: userId },
		});
		const token = await this.token(userId, false);
		try {
			await this.checkWithToken(userId, id, token);
		} catch (error) {
			await this.error(
				id,
				error instanceof Error ? error.message : "Controlled email test failed",
			);
		}
		return { ok: true };
	}

	async recordHeaders(userId: string, id: string, headers: string) {
		await this.outreach.assertOwner(userId);
		const row = await this.db.outreachLaunchTest.findFirstOrThrow({
			where: { id, ownerId: userId },
		});
		if (!row.gmailMessageId)
			throw new BadRequestException(
				"Reconcile the test delivery before recording recipient headers.",
			);
		let evidence: z.infer<typeof launchTestAuth>;
		try {
			evidence = recipientHeaderEvidence(
				headers,
				row.rfcMessageId,
				row.recipientEmail,
			);
		} catch (error) {
			throw new BadRequestException(
				error instanceof Error ? error.message : "Invalid recipient headers",
			);
		}
		await this.db.outreachLaunchTest.update({
			where: { id },
			data: { recipientAuth: evidence },
		});
		return { ok: true };
	}

	private async token(userId: string, sending: boolean) {
		const scopes = await this.tokens.grantedScopes(userId, "google");
		if (sending && !scopes.has("https://www.googleapis.com/auth/gmail.send"))
			throw new BadRequestException("Reconnect Gmail with sending permission.");
		const result = await this.tokens.accessTokenFor(userId, "gmail");
		if (result.outcome !== "ok") throw new BadRequestException(result.reason);
		if ((await this.gmail.profile(result.accessToken)) !== OUTREACH.sender)
			throw new BadRequestException(
				"Gmail sender does not match the campaign owner.",
			);
		return result.accessToken;
	}

	private async checkWithToken(userId: string, id: string, token: string) {
		let row = await this.db.outreachLaunchTest.findFirstOrThrow({
			where: { id, ownerId: userId },
		});
		if (!row.gmailMessageId) {
			const found = await this.gmail.search(
				token,
				`in:sent rfc822msgid:${row.rfcMessageId}`,
			);
			const message = found[0];
			if (found.length !== 1 || !message) {
				await this.db.outreachLaunchTest.update({
					where: { id },
					data: { status: "UNKNOWN" },
				});
				throw new Error(
					"No unique sent test message exists. No automatic retry occurs.",
				);
			}
			row = await this.db.outreachLaunchTest.update({
				where: { id },
				data: {
					status: "SENT",
					gmailMessageId: message.id,
					gmailThreadId: message.threadId,
				},
			});
		}
		if (!row.gmailMessageId || !row.gmailThreadId)
			throw new Error("Test delivery is incomplete.");
		await this.log(row, row.gmailMessageId, token, false);
		if (row.responseMessageId) {
			await this.log(row, row.responseMessageId, token, true);
		} else {
			const messages = await this.gmail.threadIds(token, row.gmailThreadId);
			for (const candidate of messages) {
				if (candidate.id === row.gmailMessageId) continue;
				const message = await this.gmail.message(token, candidate.id);
				const parsed = this.parser.parse(message);
				if (
					!parsed ||
					message.labelIds?.includes("SENT") ||
					parsed.from.email.toLowerCase() !== row.recipientEmail
				)
					continue;
				const { status } = classifyOutreachMessage(message);
				row = await this.db.outreachLaunchTest.update({
					where: { id },
					data: {
						responseMessageId: candidate.id,
						responseStatus: status,
						responseAt: parsed.sentAt,
					},
				});
				await this.log(row, candidate.id, token, true);
				break;
			}
		}
		await this.db.outreachLaunchTest.update({
			where: { id },
			data: { lastError: null },
		});
	}

	private async log(
		row: OutreachLaunchTestModel,
		messageId: string,
		token: string,
		response: boolean,
	) {
		if (response ? row.responseLoggedAt : row.loggedAt) return;
		const message = await this.gmail.message(token, messageId);
		const parsed = this.parser.parse(message);
		if (!parsed)
			throw new Error("Test message cannot be parsed for CRM logging.");
		if (!response && parsed.rfcMessageId !== row.rfcMessageId)
			throw new Error(
				"The sent test Message-ID does not match its durable record.",
			);
		const mailbox = await this.db.mailboxSync.findUniqueOrThrow({
			where: { userId_source: { userId: row.ownerId, source: "gmail" } },
		});
		const messageRecordId = await storeOutreachMessage(
			this.db,
			this.writer,
			mailbox,
			OUTREACH.sender,
			parsed,
			row.contactId,
		);
		const stored = await this.db.emailMessage.findUniqueOrThrow({
			where: { id: messageRecordId },
			select: { thread: { select: { contactId: true } } },
		});
		if (stored.thread.contactId !== row.contactId)
			throw new Error(
				"Test message logging did not match its isolated test contact.",
			);
		await this.db.outreachLaunchTest.update({
			where: { id: row.id },
			data: response
				? { responseLoggedAt: new Date() }
				: { loggedAt: new Date(), sentAt: parsed.sentAt },
		});
	}

	private async error(id: string, message: string) {
		await this.db.outreachLaunchTest.update({
			where: { id },
			data: {
				lastError: message,
			},
		});
	}
}
