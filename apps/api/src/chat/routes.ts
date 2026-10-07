import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireAuth, userOf } from '../auth/middleware.js';
import { AppError } from '../http/errors.js';
import { plural } from '../http/limits.js';
import { parseBody } from '../http/validate.js';
import { pipeUIMessageStreamToResponse } from 'ai';
import type { ChatRecord, ChatRepository, MessageRecord } from './repository.js';
import { MAX_QUESTION_LENGTH, type ChatResponder } from './responder.js';

export const MAX_TITLE_LENGTH = 120;

const titleSchema = z.string().trim().min(1).max(MAX_TITLE_LENGTH);

const createChatSchema = z.object({ title: titleSchema.optional() });
const sendMessageSchema = z.object({ content: z.string().trim().min(1).max(MAX_QUESTION_LENGTH) });
const renameChatSchema = z.object({ title: titleSchema });

function toPublicChat(chat: ChatRecord) {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

function toPublicMessage(message: MessageRecord) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    sources: message.sources ?? [],
    retrieval: message.retrieval,
    createdAt: message.createdAt,
  };
}

export function createChatsRouter({
  chats,
  responder,
  questionLimiters = [],
  maxChatsPerUser,
}: {
  chats: ChatRepository;
  responder: ChatResponder;
  questionLimiters?: RequestHandler[];
  maxChatsPerUser: number;
}) {
  const router = Router();

  router.use(requireAuth);

  const notFound = () => new AppError(404, 'not_found', 'Chat not found');
  const idParam = (value: unknown): string => {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw notFound();
    return parsed.data;
  };

  router.get('/', async (req, res) => {
    const list = await chats.listByUser(userOf(req).id);
    res.json({ chats: list.map(toPublicChat) });
  });

  router.post('/', async (req, res) => {
    const { title } = parseBody(createChatSchema, req.body ?? {});
    const userId = userOf(req).id;
    if ((await chats.countByUser(userId)) >= maxChatsPerUser) {
      throw new AppError(
        409,
        'chat_limit',
        `You have reached the limit of ${plural(maxChatsPerUser, 'conversation')}. Delete one to start another.`,
      );
    }
    const chat = await chats.create(userId, title);
    res.status(201).json({ chat: toPublicChat(chat) });
  });

  router.get('/:id', async (req, res) => {
    const chat = await chats.findForUser(idParam(req.params.id), userOf(req).id);
    if (!chat) throw notFound();
    const messages = await chats.messagesOf(chat.id);
    res.json({ chat: toPublicChat(chat), messages: messages.map(toPublicMessage) });
  });

  router.post('/:id/messages', ...questionLimiters, async (req, res) => {
    const id = idParam(req.params.id);
    const { content } = parseBody(sendMessageSchema, req.body);
    const user = userOf(req);
    const chat = await chats.findForUser(id, user.id);
    if (!chat) throw notFound();
    if (!responder.available) {
      throw new AppError(503, 'chat_unavailable', 'The AI service is not configured');
    }

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    const stream = await responder.respond({
      chat,
      userId: user.id,
      question: content,
      signal: abort.signal,
    });
    await pipeUIMessageStreamToResponse({ response: res, stream });
  });

  router.patch('/:id', async (req, res) => {
    const { title } = parseBody(renameChatSchema, req.body);
    const chat = await chats.rename(idParam(req.params.id), userOf(req).id, title);
    if (!chat) throw notFound();
    res.json({ chat: toPublicChat(chat) });
  });

  router.delete('/:id', async (req, res) => {
    const deleted = await chats.deleteForUser(idParam(req.params.id), userOf(req).id);
    if (!deleted) throw notFound();
    res.status(204).end();
  });

  return router;
}
