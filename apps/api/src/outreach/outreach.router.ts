import {
	launchTestHeadersInput,
	launchTestIdInput,
	launchTestsOutput,
	startLaunchTestsInput,
} from "@crm/validation/outreach-tests";
import { Inject } from "@nestjs/common";
import {
	Ctx,
	Input,
	Mutation,
	Query,
	Router,
	UseMiddlewares,
} from "nestjs-trpc";
import type { z } from "zod";
import type { AuthedTrpcContext } from "../trpc/context.types";
import { AuthMiddleware } from "../trpc/middlewares/auth.middleware";
import {
	campaignActionInput,
	campaignReadinessInput,
	campaignUpdateInput,
	outreachPageInput,
	outreachProspectsOutput,
	outreachResult,
	outreachStatusOutput,
	prospectApproveInput,
	prospectStopInput,
	reviewDraftsInput,
} from "./outreach.contracts";
import { OutreachService } from "./outreach.service";
import { OutreachLaunchTestsService } from "./outreach-launch-tests.service";

@Router({ alias: "outreach" })
@UseMiddlewares(AuthMiddleware)
export class OutreachRouter {
	constructor(
		@Inject(OutreachService) private readonly service: OutreachService,
		@Inject(OutreachLaunchTestsService)
		private readonly tests: OutreachLaunchTestsService,
	) {}
	@Query({ output: outreachStatusOutput })
	status(@Ctx() ctx: AuthedTrpcContext) {
		return this.service.status(ctx.user.id);
	}
	@Query({ input: outreachPageInput, output: outreachProspectsOutput })
	prospects(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof outreachPageInput>,
	) {
		return this.service.prospects(ctx.user.id, input.page);
	}
	@Mutation({ output: outreachResult })
	initialize(@Ctx() ctx: AuthedTrpcContext) {
		return this.service.initialize(ctx.user.id);
	}
	@Mutation({ input: campaignUpdateInput, output: outreachResult })
	update(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof campaignUpdateInput>,
	) {
		return this.service.update(ctx.user.id, input.templates);
	}
	@Mutation({ input: campaignActionInput, output: outreachResult })
	action(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof campaignActionInput>,
	) {
		return this.service.action(ctx.user.id, input);
	}
	@Mutation({ input: campaignReadinessInput, output: outreachResult })
	readiness(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof campaignReadinessInput>,
	) {
		return this.service.readiness(ctx.user.id, input);
	}
	@Mutation({ input: prospectApproveInput, output: outreachResult })
	qualify(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof prospectApproveInput>,
	) {
		return this.service.qualify(ctx.user.id, input);
	}
	@Mutation({ input: prospectStopInput, output: outreachResult })
	stop(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof prospectStopInput>,
	) {
		return this.service.stop(ctx.user.id, input.id);
	}
	@Query({ output: launchTestsOutput })
	launchTests(@Ctx() ctx: AuthedTrpcContext) {
		return this.tests.list(ctx.user.id);
	}
	@Mutation({ input: reviewDraftsInput, output: outreachResult })
	reviewDrafts(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof reviewDraftsInput>,
	) {
		return this.service.reviewDrafts(ctx.user.id, input.id, input.hash);
	}
	@Mutation({ input: prospectStopInput, output: outreachResult })
	retryDrafts(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof prospectStopInput>,
	) {
		return this.service.retryDrafts(ctx.user.id, input.id);
	}
	@Mutation({ input: startLaunchTestsInput, output: outreachResult })
	startLaunchTests(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof startLaunchTestsInput>,
	) {
		return this.tests.start(ctx.user.id, input);
	}
	@Mutation({ input: launchTestIdInput, output: outreachResult })
	checkLaunchTest(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof launchTestIdInput>,
	) {
		return this.tests.check(ctx.user.id, input.id);
	}
	@Mutation({ input: launchTestHeadersInput, output: outreachResult })
	recordLaunchTestHeaders(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof launchTestHeadersInput>,
	) {
		return this.tests.recordHeaders(ctx.user.id, input.id, input.headers);
	}
}
