"""The workflows, captured from Jira.

Not invented. Every status name, category and transition below was read out of
the live Jira on 2026-08-06 — `/project/{key}/statuses` for the statuses, then
one sampled issue per status asked `/issue/{key}/transitions` to learn which
moves that workflow actually permits. Boards map straight across:

    Classic Dev          <- DRC
    AI First Development <- AID
    QA Board             <- QA
    DevOps Board         <- OPS

Two things the capture made obvious, and both are why this project exists.

**The same step is spelled several ways.** `IN REVIEW` in DRC, `In review` in
AIW, `Review` in QA — three statuses in Jira, three ids, three separate things
to filter on, and no cross-project answer to "what is in review". Here they
collapse to one global status, which is the whole point of statuses being
global. The map that does the collapsing is `CANON` in the generator; only
genuinely different steps stay separate (AID's `Code Review` and `Tech Review`
really are two gates).

**Some categories are simply wrong.** Jira has `STAGING` categorised as *done*,
along with AID's `Master Sign-off`, `Pre-Release` and `Release Ready` — all of
them steps that happen before anything ships. That is why "how much of this
release is finished" cannot be answered there. They are corrected to
in-progress here, and this is the list of what was changed:

    STAGING          done -> in_progress   (it is not shipped, it is staged)
    Master Sign-off  done -> in_progress   (a gate before Pre-Release)
    Pre-Release      done -> in_progress   (before Release Ready, before LIVE)
    Release Ready    done -> in_progress   (ready to ship is not shipped)

`UNIFIED` (DRC) is left as *done* because we do not know what it means; ask
before changing it. `Solved` (OPS) keeps Jira's in-progress reading.

`New Rewquest` is spelled that way in OPS today. A clean start is the chance to
fix a typo that has been in every DevOps board view for years, so it is
`New Request` here.

QA's workflow is worth noticing: every status transitions to every other one,
which is Jira's default when nobody has configured a workflow. It is preserved
faithfully — the board says out loud that it has no rules, rather than us
inventing some.
"""
from __future__ import annotations

# Statuses Jira could not be asked about: transitions were learned by sampling a
# live issue in each status, and nothing was sitting in these three. They came
# through as dead ends, which in a strict workflow means an issue that reaches
# one can never leave. seed.py fills the gap with a forward move to the next
# status in board order, and this list is what says which edges are inferred
# rather than observed. Re-run the capture once AID has work in these and the
# guesses are replaced by the real thing.
UNSAMPLED = {
    "AIF": ["tech_review", "pre_release", "release_ready"],
}

# key, name, category, colour
STATUSES = [
    ("to_do", 'To Do', "todo", "#8b949e"),
    ("ideation", 'Ideation', "todo", "#8b949e"),
    ("design", 'Design', "todo", "#8b949e"),
    ("initial_presentation", 'Initial Presentation', "todo", "#8b949e"),
    ("assigned", 'Assigned', "todo", "#8b949e"),
    ("new_request", 'New Request', "todo", "#8b949e"),
    ("in_progress", 'In Progress', "in_progress", "#5b8cff"),
    ("in_review", 'In Review', "in_progress", "#a371f7"),
    ("staging", 'Staging', "in_progress", "#d29922"),
    ("analysis", 'Analysis', "in_progress", "#5b8cff"),
    ("implementation", 'Implementation', "in_progress", "#5b8cff"),
    ("code_review", 'Code Review', "in_progress", "#a371f7"),
    ("tech_review", 'Tech Review', "in_progress", "#a371f7"),
    ("ac_sign_off", 'AC Sign-Off', "in_progress", "#d29922"),
    ("test_plan", 'Test Plan', "in_progress", "#5b8cff"),
    ("compliance", 'Compliance', "in_progress", "#d29922"),
    ("final_presentation", 'Final Presentation', "in_progress", "#5b8cff"),
    ("master_sign_off", 'Master Sign-off', "in_progress", "#d29922"),
    ("pre_release", 'Pre-Release', "in_progress", "#d29922"),
    ("release_ready", 'Release Ready', "in_progress", "#d29922"),
    ("solved", 'Solved', "in_progress", "#5b8cff"),
    ("live", 'Live', "done", "#3fb950"),
    ("unified", 'Unified', "done", "#2dd4bf"),
    ("done", 'Done', "done", "#3fb950"),
    ("wont_do", "Won't Do", "done", "#6e7681"),
]


# Per project: the statuses in board order, and the real transition graph.
WORKFLOWS = {
    "CD": {
        "from_jira": "DRC",
        "statuses": ['to_do', 'in_progress', 'in_review', 'staging', 'live', 'unified', 'done', 'wont_do'],
        "jira_issue_types": ['Add-on Task', 'Bug', 'Defect', 'Epic', 'Hotfix', 'Live Bug', 'Story', 'Subtask', 'Task'],
        "transitions": {
            'done': ['in_review', 'staging', 'to_do', 'unified', 'wont_do'],
            'in_progress': ['done', 'in_review', 'to_do', 'wont_do'],
            'in_review': ['done', 'in_progress', 'to_do', 'wont_do'],
            'live': ['staging', 'to_do', 'wont_do'],
            'staging': ['live', 'to_do', 'unified', 'wont_do'],
            'to_do': ['in_progress', 'wont_do'],
            'unified': ['done', 'staging', 'to_do', 'wont_do'],
            'wont_do': ['to_do'],
        },
    },
    "AIF": {
        "from_jira": "AID",
        "statuses": ['ideation', 'design', 'initial_presentation', 'analysis', 'implementation', 'code_review', 'tech_review', 'ac_sign_off', 'test_plan', 'compliance', 'final_presentation', 'master_sign_off', 'pre_release', 'release_ready', 'live', 'done', 'wont_do'],
        "jira_issue_types": ['Epic', 'Story', 'Subtask', 'Task'],
        "transitions": {
            'ac_sign_off': ['analysis', 'test_plan', 'wont_do'],
            'analysis': ['ac_sign_off', 'compliance', 'wont_do'],
            'code_review': ['final_presentation', 'implementation', 'wont_do'],
            'compliance': ['analysis', 'initial_presentation', 'wont_do'],
            'design': ['ideation', 'initial_presentation', 'wont_do'],
            'done': ['wont_do'],
            'final_presentation': ['code_review', 'master_sign_off', 'wont_do'],
            'ideation': ['ac_sign_off', 'design', 'done', 'wont_do'],
            'implementation': ['code_review', 'tech_review', 'wont_do'],
            'initial_presentation': ['compliance', 'design', 'wont_do'],
            'live': ['pre_release', 'wont_do'],
            'master_sign_off': ['final_presentation', 'release_ready', 'wont_do'],
            'test_plan': ['ac_sign_off', 'tech_review', 'wont_do'],
            'wont_do': ['ideation'],
        },
    },
    "QAB": {
        "from_jira": "QA",
        "statuses": ['to_do', 'assigned', 'in_progress', 'in_review', 'done'],
        "jira_issue_types": ['Bug', 'Epic', 'Story', 'Subtask', 'Task'],
        "transitions": {
            'assigned': ['done', 'in_progress', 'in_review', 'to_do'],
            'done': ['assigned', 'in_progress', 'in_review', 'to_do'],
            'in_progress': ['assigned', 'done', 'in_review', 'to_do'],
            'in_review': ['assigned', 'done', 'in_progress', 'to_do'],
            'to_do': ['assigned', 'done', 'in_progress', 'in_review'],
        },
    },
    "DVO": {
        "from_jira": "OPS",
        "statuses": ['new_request', 'to_do', 'in_progress', 'in_review', 'solved', 'done'],
        "jira_issue_types": ['Bug', 'Epic', 'Story', 'Subtask', 'Task'],
        "transitions": {
            'done': ['in_progress', 'in_review', 'new_request', 'solved', 'to_do'],
            'in_progress': ['in_review', 'new_request', 'solved', 'to_do'],
            'in_review': ['in_progress', 'new_request', 'solved', 'to_do'],
            'new_request': ['in_progress', 'in_review', 'solved', 'to_do'],
            'solved': ['done', 'in_progress', 'in_review', 'new_request', 'to_do'],
            'to_do': ['in_progress', 'in_review', 'new_request', 'solved'],
        },
    },
}
