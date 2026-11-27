import type { z } from "zod";
import { Message } from "./message.js";
import { RelayFrame } from "./relay.js";
import { Session } from "./session.js";
import { Ticket } from "./ticket.js";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: z.ZodError };

/** Validate `input` against `schema` without throwing. */
export function safeParse<S extends z.ZodType>(
  schema: S,
  input: unknown,
): ParseResult<z.output<S>> {
  const r = schema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error };
}

export const parseMessage = (input: unknown) => safeParse(Message, input);
export const parseSession = (input: unknown) => safeParse(Session, input);
export const parseTicket = (input: unknown) => safeParse(Ticket, input);
export const parseRelayFrame = (input: unknown) => safeParse(RelayFrame, input);
