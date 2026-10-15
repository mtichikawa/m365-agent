// EXCERPT of src/agent/tools.ts — executeTool(), which the agent loop calls for every tool call in production. Read-only.

export async function executeTool(
  name: string,
  args: Record<string, any>,
  userId?: string,
  chatJid?: string,
  tenantId?: string,
  /** Observer for the permission decision (the demo console's trace). */
  onPermission?: (result: { allowed: boolean; reason?: string }) => void,
): Promise<string> {
  // Permission check — if a userId is provided, verify the user has toggled
  // on the permission that gates this tool before executing it.
  if (userId) {
    const permCheck = await checkPermission(userId, name);
    onPermission?.(permCheck);
    if (!permCheck.allowed) {
      logger.info(
        { tool: name, userId, reason: permCheck.reason },
        'Tool blocked by permission check',
      );
      return permCheck.reason ?? 'Permission denied.';
    }
  }

  const tool = tools.find((t) => t.definition.function.name === name);
  if (!tool) return `Unknown tool: ${name}`;
  try {
    const ctx = { userId: userId ?? '', tenantId: tenantId ?? 'default' };
    const result = await _requestContext.run(ctx, () =>
      tool.execute({ ...args, _chatJid: chatJid, _userId: userId }),
    );
    // 3A: Attach tenacity hint if result is empty, so the model tries smarter
    if (isEmptyResult(result)) {
      const hint = TENACITY_HINTS[name];
      if (hint) return `${result}\n[Hint: ${hint}]`;
    }
    return result;
  } catch (err: any) {
    logger.error({ tool: name, args, err: err.message }, 'Tool execution failed');
    return `Tool error: ${err.message}`;
  }
}
