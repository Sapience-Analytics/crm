import { Injectable } from "@nestjs/common";
import { SyncStateService } from "../mailbox/sync-state.service";
import { CalendarSyncService } from "./calendar-sync.service";
import { GmailImportService } from "./gmail-import.service";
import { GmailSyncService } from "./gmail-sync.service";
import { GOOGLE_SYNC_SOURCES, type GoogleSyncSource } from "./google.constants";

@Injectable()
export class GoogleSyncService {
	constructor(
		private readonly state: SyncStateService,
		private readonly calendar: CalendarSyncService,
		private readonly gmail: GmailSyncService,
		private readonly history: GmailImportService,
	) {}

	async runOne(userId: string, source: GoogleSyncSource) {
		const row = await this.state.get(userId, source);
		if (!row) return null;

		if (source === "calendar") return this.calendar.sync(row);
		const outcome = await this.gmail.sync(row);
		if (outcome.status === "synced") await this.history.runBatch(userId);
		return outcome;
	}

	async runForUser(userId: string): Promise<void> {
		for (const source of GOOGLE_SYNC_SOURCES) {
			await this.runOne(userId, source);
		}
	}
}
