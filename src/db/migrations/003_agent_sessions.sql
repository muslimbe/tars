-- Agent conversations: a follow-up continues an earlier task's Claude session
-- in the same worktree, without another approval.
ALTER TABLE agent_tasks ADD COLUMN parent_id  INTEGER REFERENCES agent_tasks(id);  -- the task a follow-up continues
ALTER TABLE agent_tasks ADD COLUMN session_id TEXT;  -- the agent's Claude session, reported when it finishes
ALTER TABLE agent_tasks ADD COLUMN worktree   TEXT;  -- where it ran on the owner's computer
ALTER TABLE agent_tasks ADD COLUMN resume     TEXT;  -- a command that opens the session there
