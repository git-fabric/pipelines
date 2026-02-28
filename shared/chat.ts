/**
 * Helpers for working with fabric-chat sessions via the gateway.
 */

import { callTool } from './gateway.js';

export interface Session {
  id: string;
  project: string;
}

/**
 * Create a new chat session with an optional system prompt.
 */
export async function createSession(opts: {
  project: string;
  systemPrompt?: string;
  model?: string;
  title?: string;
}): Promise<Session> {
  const result = (await callTool('chat_session_create', {
    project: opts.project,
    systemPrompt: opts.systemPrompt,
    model: opts.model ?? 'claude-sonnet-4-6',
    title: opts.title,
  })) as { sessionId?: string; id?: string };

  const id = result.sessionId ?? result.id;
  if (!id) throw new Error(`chat_session_create returned no session ID: ${JSON.stringify(result)}`);
  return { id, project: opts.project };
}

/**
 * Inject context text into a session before the first user message.
 */
export async function injectContext(
  session: Session,
  context: string,
): Promise<void> {
  await callTool('chat_context_inject', {
    sessionId: session.id,
    context,
  });
}

/**
 * Send a message to a session and return the assistant response text.
 */
export async function sendMessage(
  session: Session,
  message: string,
): Promise<string> {
  const result = (await callTool('chat_message_send', {
    sessionId: session.id,
    content: message,
  })) as { response?: string; content?: string; text?: string; message?: string };

  return (
    result.response ??
    result.content ??
    result.text ??
    result.message ??
    JSON.stringify(result)
  );
}

/**
 * Search recent sessions for findings.
 */
export async function searchSessions(opts: {
  query: string;
  project?: string;
  limit?: number;
}): Promise<unknown> {
  return callTool('chat_search', {
    query: opts.query,
    project: opts.project,
    limit: opts.limit ?? 10,
  });
}
