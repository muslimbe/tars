-- The Claude model the agent runs a task with; NULL means the computer's default.
ALTER TABLE agent_tasks ADD COLUMN model TEXT;
