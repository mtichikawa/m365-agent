// EXCERPT of src/agent/embeddings.ts — the one-request query path. Read-only.

async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (!embeddingClient || !embeddingDeployment) return texts.map(() => null);
  const BATCH = 96;
  const results: (number[] | null)[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    try {
      const response = await embeddingClient.embeddings.create({
        model: embeddingDeployment,
        input: slice,
      });
      const sorted = [...response.data].sort((a, b) => a.index - b.index);
      results.push(...sorted.map(r => r.embedding));
    } catch (err) {
      logger.warn({ err, batchStart: i }, 'Batch embedding request failed');
      results.push(...slice.map(() => null));
    }
  }
  return results;
}

/**
 * Select tools for a user message.
 *
 * `previousExchange` is the last user + assistant turn, used so short
 * follow-ups inherit the tools of the conversation they continue.
 * Returns null if embeddings are not initialized or the embedding call fails.
 */
export async function selectToolsByEmbedding(
  message: string,
  previousExchange?: string,
): Promise<ChatCompletionTool[] | null> {
  if (!toolEntries) return null;

  const context = previousExchange ? `${previousExchange}\n${message}` : null;
  const clauses = splitClauses(message);
  const [msgEmbedding, ...rest] = await embedBatch([message, ...(context ? [context] : []), ...clauses]);
  if (!msgEmbedding) return null;
  const contextEmbedding = context ? rest.shift() ?? null : null;
  const clauseEmbeddings = rest.filter((e): e is number[] => e !== null);

  const selected = selectToolNames(msgEmbedding, contextEmbedding, toolEntries, trainEntries ?? [], clauseEmbeddings);
  const result = toolEntries.filter(e => selected.has(e.name)).map(e => e.definition);

  logger.debug({ toolCount: result.length, withContext: !!contextEmbedding }, 'Tool selection');
  return result;
}

