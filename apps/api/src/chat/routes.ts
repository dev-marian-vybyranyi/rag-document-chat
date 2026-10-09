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

export const MAX_SCOPED_SOURCES = 50;

const sourceIdsSchema = z.array(z.uuid()).min(1).max(MAX_SCOPED_SOURCES);

const createChatSchema = z.object({
  title: titleSchema.optional(),
  sourceIds: sourceIdsSchema.nullable().optional(),
});
const sendMessageSchema = z.object({ content: z.string().trim().min(1).max(MAX_QUESTION_LENGTH) });
const updateChatSchema = z
  .object({ title: titleSchema.optional(), sourceIds: sourceIdsSchema.nullable().optional() })
  .refine((body) => body.title !== undefined || body.sourceIds !== undefined, {
    message: 'Send a title or the sources to search',
  });

function toPublicChat(chat: ChatRecord) {
  return {
    id: chat.id,
    title: chat.title,
    sourceIds: chat.sourceIds,
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

  const checkedSources = async (userId: string, ids: string[] | null | undefined) => {
    if (!ids) return null;
    const unique = [...new Set(ids)];
    const owned = await chats.ownedSourceIds(userId, unique);
    if (owned.length !== unique.length) {
      throw new AppError(400, 'validation_error', 'One of the chosen sources is not available');
    }
    return unique;
  };

  router.post('/', async (req, res) => {
    const { title, sourceIds } = parseBody(createChatSchema, req.body ?? {});
    const userId = userOf(req).id;
    if ((await chats.countByUser(userId)) >= maxChatsPerUser) {
      throw new AppError(
        409,
        'chat_limit',
        `You have reached the limit of ${plural(maxChatsPerUser, 'conversation')}. Delete one to start another.`,
      );
    }
    const scope = await checkedSources(userId, sourceIds);
    const chat = await chats.create(userId, title, scope);
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
    const { title, sourceIds } = parseBody(updateChatSchema, req.body);
    const id = idParam(req.params.id);
    const userId = userOf(req).id;
    let chat = await chats.findForUser(id, userId);
    if (!chat) throw notFound();
    if (sourceIds !== undefined) {
      chat = (await chats.setScope(id, userId, await checkedSources(userId, sourceIds))) ?? chat;
    }
    if (title !== undefined) chat = (await chats.rename(id, userId, title)) ?? chat;
    res.json({ chat: toPublicChat(chat) });
  });

  router.delete('/:id', async (req, res) => {
    const deleted = await chats.deleteForUser(idParam(req.params.id), userOf(req).id);
    if (!deleted) throw notFound();
    res.status(204).end();
  });

  return router;
}
