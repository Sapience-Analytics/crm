import { timingSafeEqual } from "node:crypto";
import {
	Controller,
	ForbiddenException,
	Get,
	Headers,
	ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { EnvironmentVariables } from "../config/env.validation";
import { OutreachDispatchService } from "./outreach-dispatch.service";

@Controller("internal/outreach")
export class OutreachController {
	constructor(
		private readonly dispatch: OutreachDispatchService,
		private readonly config: ConfigService<EnvironmentVariables, true>,
	) {}
	@Get("dispatch")
	@AllowAnonymous()
	run(@Headers("authorization") authorization?: string) {
		const secret = this.config.get("CRON_SECRET", { infer: true });
		if (!secret)
			throw new ServiceUnavailableException("Cron is not configured.");
		const actual = Buffer.from(authorization ?? "");
		const expected = Buffer.from(`Bearer ${secret}`);
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
			throw new ForbiddenException();
		return this.dispatch.run();
	}
}
