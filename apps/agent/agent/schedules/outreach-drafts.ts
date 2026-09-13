import { DRAFTING } from "@crm/validation/outreach-drafts";
import { defineSchedule } from "eve/schedules";
import { draftOutreachSequence } from "../lib/outreach-drafts";

export default defineSchedule({
	cron: DRAFTING.scheduleCron,
	run({ waitUntil }) {
		waitUntil(draftOutreachSequence());
	},
});
