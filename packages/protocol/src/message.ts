import { z } from "zod";
import { MessageId, SessionId, TicketId } from "./ids.js";
import { IsoTimestamp, ORCHESTRATOR_ALIAS, SessionName } from "./primitives.js";
import { utf8ByteLength } from "./util.js";

export const TEXT_MAX_BYTES = 64 * 1024;

const boundedText = (maxBytes: number) =>
  z.string().refine((s) => utf8ByteLength(s) <= maxBytes, { message: `exceeds ${maxBytes} bytes` });

/** A message recipient: a session id, a session name, or the literal `orchestrator`. */
export const Recipient = z.union([z.literal(ORCHESTRATOR_ALIAS), SessionId, SessionName]);
export type Recipient = z.infer<typeof Recipient>;

export const TextBody = z.object({ text: boundedText(TEXT_MAX_BYTES) });
export const HandoffBody = z.object({
  goal: z.string().min(1).max(2_000),
  state: z.string().max(16_000),
  nextSteps: z.array(z.string().min(1).max(1_000)).max(50),
  filesTouched: z.array(z.string().min(1).max(1_024)).max(200),
});
export const QuestionBody = z.object({
  ticketId: TicketId,
  question: z.string().min(1).max(8_000),
  options: z.array(z.string().min(1).max(500)).min(1).max(20).optional(),
});
export const AnswerBody = z.object({
  ticketId: TicketId,
  response: boundedText(TEXT_MAX_BYTES).refine((s) => s.length > 0, { message: "empty response" }),
});
export const SystemBody = z.object({
  event: z.string().min(1).max(64),
  detail: z.string().max(2_000).optional(),
});

/** `{kind, body}` pairs. Shared by the stored envelope and the `message.send` params. */
export const TextContent = z.object({ kind: z.literal("text"), body: TextBody });
export const HandoffContent = z.object({ kind: z.literal("handoff"), body: HandoffBody });
export const QuestionContent = z.object({ kind: z.literal("question"), body: QuestionBody });
export const AnswerContent = z.object({ kind: z.literal("answer"), body: AnswerBody });
export const SystemContent = z.object({ kind: z.literal("system"), body: SystemBody });

export const MessageContent = z.discriminatedUnion("kind", [
  TextContent,
  HandoffContent,
  QuestionContent,
  AnswerContent,
  SystemContent,
]);
export type MessageContent = z.infer<typeof MessageContent>;

export const MESSAGE_KINDS = ["text", "handoff", "question", "answer", "system"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const messageEnvelopeShape = {
  id: MessageId,
  from: SessionId,
  to: Recipient,
  urgent: z.boolean().default(false),
  replyTo: MessageId.optional(),
  createdAt: IsoTimestamp,
};

export const Message = z.discriminatedUnion("kind", [
  TextContent.extend(messageEnvelopeShape),
  HandoffContent.extend(messageEnvelopeShape),
  QuestionContent.extend(messageEnvelopeShape),
  AnswerContent.extend(messageEnvelopeShape),
  SystemContent.extend(messageEnvelopeShape),
]);
export type Message = z.infer<typeof Message>;
