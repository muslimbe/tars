-- Coding tasks for the Claude agent on the owner's computer: Lia proposes,
-- the owner approves with a button, the agent there claims and reports back.
CREATE TABLE agent_tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,  -- where the result is reported
    repo        TEXT NOT NULL,     -- a folder in the agent's projects directory
    jira_key    TEXT,
    title       TEXT NOT NULL,
    prompt      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'awaiting'
                CHECK (status IN ('awaiting', 'approved', 'running', 'done', 'failed', 'cancelled')),
    result      TEXT,
    pr_url      TEXT,
    created_at  TEXT NOT NULL,
    finished_at TEXT
);

CREATE INDEX idx_agent_tasks_status ON agent_tasks(status, id);
