/**
 * Written for this repo: the tool catalogue, as sent to the model.
 *
 * The product assembles this array from its 12 skill modules, each tool with an
 * execute() that calls Microsoft Graph (src/agent/tools.ts). Here the
 * definitions alone are loaded from tool-catalogue.json, exported from the same
 * product commit, so the selection code and the eval see exactly the same tools.
 */
import { readFileSync } from 'fs';
import type { ChatCompletionFunctionTool as ChatCompletionTool } from 'openai/resources/chat/completions.js';

export const toolDefinitions: ChatCompletionTool[] = JSON.parse(
  readFileSync(new URL('./tool-catalogue.json', import.meta.url), 'utf8'),
);
