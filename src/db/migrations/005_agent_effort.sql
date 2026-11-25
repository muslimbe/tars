-- How hard the agent thinks (`claude --effort`); NULL means the computer's default.
ALTER TABLE agent_tasks ADD COLUMN effort TEXT;
