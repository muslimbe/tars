import type { AgentTaskRow } from '../db/agent-tasks.ts';
import { escapeAttr, escapeXml } from '../text/xml.ts';

/** The branch the agent opens its pull request from. */
export const branchName = (t: Pick<AgentTaskRow, 'id' | 'jira_key'>): string => `lia/${t.jira_key ? `${t.jira_key.toLowerCase()}-` : 'task-'}${t.id}`;

const REPORT =
  'Finish with a short plain-text report: what you changed, how you checked it, and the pull request link on its own line as `PR: <url>`. ' +
  'If you could not finish, say exactly what stopped you. If you need a decision from the owner, stop and ask it in the report: this session will be resumed with the answer.';

/** What the agent on the owner's computer runs: Lia's instructions wrapped in how to deliver them. */
export function agentPrompt(t: AgentTaskRow): string {
  if (t.parent_id !== null) return followUpPrompt(t);
  const branch = branchName(t);
  const jira = t.jira_key ? ` — Jira ${t.jira_key}` : '';
  return [
    "You are a coding agent on the owner's computer. Lia, the owner's assistant, handed you this task and the owner approved it.",
    '',
    `Task #${t.id}${jira}: ${t.title}`,
    `Repository: ${t.repo}. Your working directory is a fresh git worktree of it (detached HEAD), so the owner's own checkout is untouched.`,
    '',
    t.prompt,
    '',
    'How to deliver:',
    `1. Create the branch \`${branch}\` from the up-to-date default branch of the upstream repository — the one \`origin\` is a fork of (\`gh repo view --json parent\`; add and fetch it as a remote if it is missing). If origin is not a fork, use origin's default branch. Use another base branch only if the task above names one.`,
    "2. Do the work. Run the project's tests and checks if it has them, and fix what fails.",
    `3. Commit with a clear message${t.jira_key ? ` that starts with ${t.jira_key}` : ''}, and push the branch to origin.`,
    `4. Open a pull request against that upstream base branch with \`gh pr create\` (from a fork: \`--repo <upstream owner>/<repo> --head <fork owner>:${branch}\`). Write its title and description in English${t.jira_key ? ` and mention ${t.jira_key}` : ''}.`,
    `5. ${REPORT}`,
  ].join('\n');
}

/** A follow-up resumes the session, so it needs only the new message and the delivery rules again. */
function followUpPrompt(t: AgentTaskRow): string {
  return [
    `Follow-up #${t.id} from the owner, through Lia:`,
    '',
    t.prompt,
    '',
    'Keep working on the same branch. Commit and push to it, so the open pull request updates; open one only if there is none yet.',
    REPORT,
  ].join('\n');
}

/** The `PR: <url>` line the prompt asks the agent to end with. */
export const prUrlOf = (report: string): string | undefined => /^PR:\s*(https?:\/\/\S+)/m.exec(report)?.[1];

/** How a finished task reaches Lia: a synthetic inbound message only tars can produce. */
export function resultEnvelope(t: AgentTaskRow): string {
  const attrs = [
    ['continues', t.parent_id],
    ['chat_id', t.chat_id],
    ['repo', t.repo],
    ['status', t.status],
    ['pr', t.pr_url],
    ['resume', t.resume],
  ]
    .filter(([, value]) => value !== null)
    .map(([key, value]) => ` ${key}="${escapeAttr(String(value))}"`)
    .join('');
  return `<agent_result task="${t.id}"${attrs}>${escapeXml(t.result ?? '')}</agent_result>`;
}
