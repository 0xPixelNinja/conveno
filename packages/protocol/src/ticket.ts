import { z } from "zod";
import { SessionId, TicketId } from "./ids.js";
import { IsoTimestamp } from "./primitives.js";

export const TICKET_STATUSES = ["open", "answered", "cancelled"] as const;
export const TicketStatus = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatus>;

/**
 * A question routed to the orchestrator.
 *
 * Rule: a ticket never resolves by timeout. An `open` ticket stays open until it is answered
 * or cancelled; the asking CLI keeps its own native prompt meanwhile. Conveno never auto-approves.
 */
export const Ticket = z
  .object({
    id: TicketId,
    fromSession: SessionId,
    question: z.string().min(1).max(8_000),
    options: z.array(z.string().min(1).max(500)).min(1).max(20).optional(),
    status: TicketStatus,
    answer: z.string().optional(),
    answeredBy: SessionId.optional(),
    createdAt: IsoTimestamp,
    answeredAt: IsoTimestamp.optional(),
  })
  .superRefine((t, ctx) => {
    if (t.status === "answered") {
      for (const f of ["answer", "answeredBy", "answeredAt"] as const) {
        if (t[f] === undefined) {
          ctx.addIssue({ code: "custom", path: [f], message: `required when status is answered` });
        }
      }
    } else if (t.answer !== undefined || t.answeredBy !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["answer"],
        message: "answer fields are only allowed when status is answered",
      });
    }
  });
export type Ticket = z.infer<typeof Ticket>;
