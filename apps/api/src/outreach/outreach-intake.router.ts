import {
	importCandidatesInput,
	importCandidatesOutput,
} from "@crm/validation/outreach-intake";
import { Inject } from "@nestjs/common";
import { Ctx, Input, Mutation, Router, UseMiddlewares } from "nestjs-trpc";
import type { z } from "zod";
import type { AuthedTrpcContext } from "../trpc/context.types";
import { AuthMiddleware } from "../trpc/middlewares/auth.middleware";
import { OutreachIntakeService } from "./outreach-intake.service";

@Router({ alias: "outreachIntake" })
@UseMiddlewares(AuthMiddleware)
export class OutreachIntakeRouter {
	constructor(
		@Inject(OutreachIntakeService)
		private readonly service: OutreachIntakeService,
	) {}

	@Mutation({ input: importCandidatesInput, output: importCandidatesOutput })
	importCandidates(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof importCandidatesInput>,
	) {
		return this.service.importCandidates(ctx.user.id, input);
	}
}
