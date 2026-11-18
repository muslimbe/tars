import { renderPng, type RenderRequest } from '../browser/render.ts';
import { queryReadOnly } from '../db/query.ts';
import type { Logger } from '../log/logger.ts';
import type { Tool } from '../mcp/tool.ts';
import { clickTool, fillTool, pressKeyTool, scrollTool, selectOptionTool } from './browser/actions.ts';
import { downloadTool, screenshotTool } from './browser/files.ts';
import { backTool, navigateTool, reloadTool, resetTool } from './browser/navigation.ts';
import { getAttributeTool, getHtmlTool, getTextTool, listTool, waitForTool } from './browser/reading.ts';
import { agentTaskContinueTool, agentTaskCreateTool } from './agents.ts';
import type { ToolContext } from './context.ts';
import { databaseQueryTool, recentMessagesTool } from './database.ts';
import { instructionAppendTool, instructionReadTool, instructionRewriteTool } from './instructions.ts';
import { toolListTool } from './list.ts';
import { memoryAppendTool, memoryListTool, memoryReadTool, memorySearchTool, memoryWriteTool } from './memory.ts';
import { reminderCancelTool, reminderListTool, reminderSetTool } from './reminders.ts';
import { renderHtmlTool, renderLatexTool } from './render.ts';
import { skillListTool, skillReadTool, skillWriteTool } from './skills.ts';
import { readAttachmentTool } from './telegram/attachment.ts';
import { deleteMessageTool } from './telegram/delete.ts';
import { sendMemoryDocumentTool } from './telegram/document.ts';
import { editMessageTool } from './telegram/edit.ts';
import { sendPhotoTool } from './telegram/photo.ts';
import { createPollTool, stopPollTool } from './telegram/poll.ts';
import { addReactionTool } from './telegram/reaction.ts';
import { replyToMessageTool, sendMessageTool } from './telegram/send.ts';
import { timeNowTool } from './time.ts';

/**
 * Every tars tool, in a fixed order (that of `tools/list` and the prompt's
 * tool index), minus the ones `plugins.json` disables. An unknown name in
 * `builtin_tools_disabled` fails boot.
 */
export function buildTools(ctx: ToolContext, disabled: ReadonlySet<string>, log: Logger): Tool[] {
  const enabled: Tool[] = [];
  const all = allTools(ctx, () => enabled);
  const known = all.map((tool) => tool.name);
  const unknown = [...disabled].filter((name) => !known.includes(name));
  if (unknown.length) {
    throw new Error(`plugins.json builtin_tools_disabled has unknown name(s): ${JSON.stringify(unknown.sort())}; available: ${JSON.stringify(known.sort())}`);
  }
  for (const tool of all) {
    if (disabled.has(tool.name)) {
      log.info(`skipped MCP tool ${tool.name} (disabled in plugins.json)`);
      continue;
    }
    enabled.push(tool);
    log.info(`registered MCP tool ${tool.name}`);
  }
  return enabled;
}

function allTools(ctx: ToolContext, enabled: () => readonly Tool[]): Tool[] {
  const agents = ctx.agents ? [agentTaskCreateTool(ctx.agents), agentTaskContinueTool(ctx.agents)] : [];
  return [...browserTools(ctx), ...dataTools(ctx), ...telegramTools(ctx), ...agents, toolListTool(enabled)];
}

function browserTools(ctx: ToolContext): Tool[] {
  const session = ctx.browserSession;
  return [
    backTool(session),
    clickTool(session),
    downloadTool(session, ctx.renders, ctx.log),
    fillTool(session),
    getAttributeTool(session),
    getHtmlTool(session),
    getTextTool(session),
    listTool(session),
    navigateTool(session, ctx.log),
    pressKeyTool(session),
    reloadTool(session),
    resetTool(session),
    screenshotTool(session, ctx.renders, ctx.log),
    scrollTool(session),
    selectOptionTool(session),
    waitForTool(session),
  ];
}

function dataTools(ctx: ToolContext): Tool[] {
  // render_latex logged on render_html's logger, the browser context on the browser module's.
  const render = { render: (req: RenderRequest) => renderPng(ctx.browser, req, ctx.log.child('render')), store: ctx.renders, log: ctx.log.child('render_html') };
  return [
    recentMessagesTool(ctx.db),
    databaseQueryTool((sql) => queryReadOnly(ctx.dbPath, sql)),
    instructionAppendTool(ctx.instructions),
    instructionReadTool(ctx.instructions),
    instructionRewriteTool(ctx.instructions),
    memoryAppendTool(ctx.memory),
    memoryListTool(ctx.memory),
    memoryReadTool(ctx.memory),
    memorySearchTool(ctx.memory),
    memoryWriteTool(ctx.memory),
    timeNowTool(),
    reminderCancelTool(ctx.db),
    reminderListTool(ctx.db),
    reminderSetTool(ctx.db),
    renderHtmlTool(render),
    renderLatexTool(render),
    skillListTool(ctx.skills),
    skillReadTool(ctx.skills),
    skillWriteTool(ctx.skills),
  ];
}

function telegramTools(ctx: ToolContext): Tool[] {
  return [
    addReactionTool(ctx),
    createPollTool(ctx),
    deleteMessageTool(ctx),
    editMessageTool(ctx),
    readAttachmentTool(ctx.attachments),
    replyToMessageTool(ctx),
    sendMessageTool(ctx),
    sendMemoryDocumentTool(ctx, ctx.memory),
    sendPhotoTool(ctx, ctx.renders),
    stopPollTool(ctx),
  ];
}
