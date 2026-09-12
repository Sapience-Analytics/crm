import {
	contactResearchActionOutput,
	contactResearchInput,
	contactResearchOutput,
	queueContactResearchInput,
	selectContactInput,
} from "@crm/validation/outreach-contacts";
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
import { OutreachContactsService } from "./outreach-contacts.service";

@Router({ alias: "outreachContacts" })
@UseMiddlewares(AuthMiddleware)
export class OutreachContactsRouter {
	constructor(
		@Inject(OutreachContactsService)
		private readonly service: OutreachContactsService,
	) {}

	@Query({ input: contactResearchInput, output: contactResearchOutput })
	status(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof contactResearchInput>,
	) {
		return this.service.status(ctx.user.id, input);
	}

	@Mutation({
		input: queueContactResearchInput,
		output: contactResearchActionOutput,
	})
	research(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof queueContactResearchInput>,
	) {
		return this.service.research(ctx.user.id, input);
	}

	@Mutation({ input: selectContactInput, output: contactResearchActionOutput })
	select(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof selectContactInput>,
	) {
		return this.service.select(ctx.user.id, input);
	}
}
