import { randomUUID } from "node:crypto";
import type { Db, GmailImportModel, Prisma } from "@crm/db";
import { Injectable } from "@nestjs/common";
import { TRPCError } from "@trpc/server";
import { InjectDatabase } from "../database/database.constants";
import { MailboxTokenService } from "../mailbox/mailbox-token.service";
import { ThreadWriterService } from "../mailbox/thread-writer.service";
import { GmailClient } from "./gmail.client";
import { GmailSyncService } from "./gmail-sync.service";
import { GMAIL_IMPORT } from "./google.constants";

export function importStart(before: Date): Date {
	const after = new Date(before);
	const day = after.getUTCDate();
	after.setUTCDate(1);
	after.setUTCMonth(after.getUTCMonth() - GMAIL_IMPORT.months);
	const lastDay = new Date(
		Date.UTC(after.getUTCFullYear(), after.getUTCMonth() + 1, 0),
	).getUTCDate();
	after.setUTCDate(Math.min(day, lastDay));
	return after;
}

@Injectable()
export class GmailImportService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly gmail: GmailClient,
		private readonly tokens: MailboxTokenService,
		private readonly parser: GmailSyncService,
		private readonly threads: ThreadWriterService,
	) {}

	async status(userId: string) {
		const job = await this.db.gmailImport.findFirst({
			where: { mailbox: { userId, source: "gmail" } },
		});
		return job
			? {
					phase: job.phase,
					after: job.after.toISOString(),
					before: job.before.toISOString(),
					reviewed: job.reviewed,
					imported: job.imported,
					skipped: job.skipped,
					lastError: job.lastError,
					completedAt: job.completedAt?.toISOString() ?? null,
					busy: !!job.leaseUntil && job.leaseUntil > new Date(),
				}
			: null;
	}

	async start(userId: string) {
		const mailbox = await this.db.mailboxSync.findUnique({
			where: { userId_source: { userId, source: "gmail" } },
		});
		if (!mailbox)
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Connect Gmail before importing.",
			});
		const before = new Date();
		await this.db.gmailImport.upsert({
			where: { mailboxId: mailbox.id },
			create: { mailboxId: mailbox.id, after: importStart(before), before },
			update: {},
		});
		return this.status(userId);
	}

	async assertInactive(userId: string) {
		const active = await this.db.gmailImport.findFirst({
			where: {
				mailbox: { userId, source: "gmail" },
				phase: { in: ["sent", "received"] },
			},
		});
		if (active)
			throw new TRPCError({
				code: "CONFLICT",
				message:
					"Stop the email import before deleting synced data or revoking Google access.",
			});
	}

	async stop(userId: string) {
		const result = await this.db.gmailImport.updateMany({
			where: {
				mailbox: { userId, source: "gmail" },
				phase: { in: ["sent", "received"] },
				OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
			},
			data: { phase: "stopped" },
		});
		if (!result.count) {
			const status = await this.status(userId);
			if (status?.busy)
				throw new TRPCError({
					code: "CONFLICT",
					message: "A batch is finishing. Try Stop again shortly.",
				});
		}
		return this.status(userId);
	}

	async runBatch(userId: string) {
		const started = Date.now();
		const job = await this.db.gmailImport.findFirst({
			where: {
				mailbox: { userId, source: "gmail" },
				phase: { in: ["sent", "received"] },
			},
			include: { mailbox: true },
		});
		if (!job) return;
		const leaseToken = randomUUID();
		const claimed = await this.db.gmailImport.updateMany({
			where: {
				id: job.id,
				updatedAt: job.updatedAt,
				AND: [
					{ OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] },
					{ OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }] },
				],
			},
			data: {
				leaseToken,
				leaseUntil: new Date(started + GMAIL_IMPORT.leaseMs),
			},
		});
		if (!claimed.count) return;
		const save = async (data: Prisma.GmailImportUpdateManyMutationInput) => {
			const saved = await this.db.gmailImport.updateMany({
				where: { id: job.id, leaseToken },
				data,
			});
			if (!saved.count) throw new Error("Import lease expired.");
		};
		try {
			const token = await this.tokens.accessTokenFor(userId, "gmail");
			if (token.outcome !== "ok")
				throw new Error("Reconnect Google to continue the email import.");
			const profile = await this.gmail.profile(token.accessToken);
			if (profile.outcome !== "ok") return await this.failure(save, profile);
			const mailbox = profile.data.emailAddress?.toLowerCase();
			if (!mailbox) throw new Error("Google returned no mailbox address.");
			const context = await this.threads.context();
			let current: GmailImportModel = job;
			while (Date.now() - started < GMAIL_IMPORT.batchMs) {
				if (current.pendingIds.length === 0) {
					if (current.pageLoaded && !current.pageToken) {
						if (current.phase === "received") {
							await save({
								phase: "complete",
								completedAt: new Date(),
								lastError: null,
								retryAfter: null,
							});
							break;
						}
						current = { ...current, phase: "received", pageLoaded: false };
						await save({ phase: current.phase, pageLoaded: false });
					}
					const page = await this.gmail.listMessages(token.accessToken, {
						after: current.after,
						before: current.before,
						pageToken: current.pageToken ?? undefined,
						maxResults: GMAIL_IMPORT.pageSize,
						sentOnly: current.phase === "sent",
					});
					if (page.outcome !== "ok") return await this.failure(save, page);
					const pendingIds = (page.data.messages ?? []).flatMap((message) =>
						message.id ? [message.id] : [],
					);
					current = {
						...current,
						pendingIds,
						pageToken: page.data.nextPageToken ?? null,
						pageLoaded: true,
					};
					await save({
						pendingIds,
						pageToken: current.pageToken,
						pageLoaded: true,
					});
					if (pendingIds.length === 0) continue;
				}
				const id = current.pendingIds[0];
				if (!id) break;
				const message = await this.gmail.getMessage(token.accessToken, id);
				if (message.outcome !== "ok" && message.outcome !== "cursor-invalid")
					return await this.failure(save, message);
				const parsed =
					message.outcome === "ok" ? this.parser.parse(message.data) : null;
				const imported =
					parsed &&
					parsed.sentAt >= current.after &&
					parsed.sentAt < current.before
						? await this.threads.store(
								job.mailbox,
								{ mailbox, origin: "gmail" },
								parsed,
								context,
							)
						: false;
				current.pendingIds = current.pendingIds.slice(1);
				await save({
					pendingIds: current.pendingIds,
					reviewed: { increment: 1 },
					imported: { increment: imported ? 1 : 0 },
					skipped: { increment: imported ? 0 : 1 },
					lastError: null,
					retryAfter: null,
				});
			}
		} catch {
			await save({
				lastError:
					"The import paused after an error. It will retry automatically. Check the Google connection if this continues.",
				retryAfter: new Date(Date.now() + GMAIL_IMPORT.retryMs),
			});
		} finally {
			await this.db.gmailImport.updateMany({
				where: { id: job.id, leaseToken },
				data: { leaseToken: null, leaseUntil: null },
			});
		}
	}

	private async failure(
		save: (data: Prisma.GmailImportUpdateManyMutationInput) => Promise<void>,
		failure: { outcome: string; retryAfterMs?: number },
	) {
		await save({
			lastError:
				failure.outcome === "unauthorized"
					? "Reconnect Google to continue importing."
					: "Google could not finish this batch. The import will retry automatically.",
			retryAfter: new Date(
				Date.now() + (failure.retryAfterMs ?? GMAIL_IMPORT.retryMs),
			),
		});
	}
}
