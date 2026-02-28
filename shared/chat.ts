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
  tags?: string[];
}): Promise<Session> {
  const result = (await callTool('chat_session_create', {
    project: opts.project,
    system_prompt: opts.systemPrompt,
    model: opts.model ?? 'claude-sonnet-4-6',
    tags: opts.tags ?? [],
  })) as { id: string };

  return { id: result.id, project: opts.project };
}

/**
 * Inject context text into a session before the first user message.
 */
export async function injectContext(
  session: Session,
  context: string,
): Promise<void> {
  await callTool('chat_context_inject', {
    session_id: session.id,
    content: context,
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
    session_id: session.id,
    message,
  })) as { response?: string; content?: string; text?: string };

  return result.response ?? result.content ?? result.text ?? JSON.stringify(result);
}

/**
 * Search recent sessions for findings within a time window.
 */
export async function searchSessions(opts: {
  query: string;
  project?: string;
  hoursBack?: number;
}): Promise<unknown> {
  return callTool('chat_search', {
    query: opts.query,
    project: opts.project,
    since_hours: opts.hoursBack ?? 24,
  });
}
