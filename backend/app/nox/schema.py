"""The tracker's Postgres schema, as SQLAlchemy Core tables.

Core, not the ORM: queries stay explicit and readable like the rest of this
codebase, and a saved view's filter can be built as composable SQL expressions
rather than concatenated strings. Alembic reads this metadata to generate
migrations.

Read docs/tracker/DESIGN.md before changing anything here — most of these
choices are reactions to something specific that Jira's model cost us, and the
comments say which.
"""
from __future__ import annotations

from sqlalchemy import (
    BigInteger, Boolean, CheckConstraint, Column, DateTime, ForeignKey, Index,
    Integer, MetaData, Numeric, String, Table, Text, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import JSONB

# Named constraints so Alembic can alter them later without guessing.
metadata = MetaData(naming_convention={
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s",
    "pk": "pk_%(table_name)s",
})


def _ts(name: str, **kw) -> Column:
    return Column(name, DateTime(timezone=True), **kw)


# --------------------------------------------------------------------- people
# Users live in SQLite (auth_store) — this is a PROJECTION, kept in sync, so
# that filtering, sorting and grouping by person happens in SQL instead of an
# in-memory join after the query. `id` matches the SQLite account id; there is
# deliberately no foreign key, because there cannot be one across databases.
users = Table(
    "users", metadata,
    Column("id", Integer, primary_key=True, autoincrement=False),
    Column("display_name", Text, nullable=False, server_default=""),
    Column("avatar", Text, nullable=False, server_default=""),
    Column("active", Boolean, nullable=False, server_default="true"),
    _ts("synced_at", nullable=False, server_default=func.now()),
)

# --------------------------------------------------------------------- teams
# Delivery teams — Rocket and Sparta today.
#
# A team is a group of people, not a board: both teams work across the same
# projects, and which team owns a piece of work is a planning decision the PO
# makes per issue rather than a property of where it was filed.
teams = Table(
    "teams", metadata,
    Column("id", Integer, primary_key=True),
    Column("key", String(16), nullable=False, unique=True),
    Column("name", Text, nullable=False),
    Column("colour", String(9), nullable=False, server_default="#5b8cff"),
    # The person who orders this team's queue. One lever, one owner — the whole
    # arrangement rests on somebody actually maintaining the order.
    Column("lead_id", Integer),
    Column("position", Integer, nullable=False, server_default="0"),
    _ts("created_at", nullable=False, server_default=func.now()),
    _ts("archived_at"),
)

team_members = Table(
    "team_members", metadata,
    Column("team_id", ForeignKey("teams.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", Integer, primary_key=True),
    # dev | ai | qa | ops — what they do on the team, for grouping the lead's
    # view. Not a permission; permissions come from account tags.
    Column("craft", String(16), nullable=False, server_default="dev"),
    _ts("joined_at", nullable=False, server_default=func.now()),
)


# ------------------------------------------------------------------ projects
projects = Table(
    "projects", metadata,
    Column("id", Integer, primary_key=True),
    # Permanent, and it leaks into git branches and bookmarks forever.
    Column("key", String(8), nullable=False, unique=True),
    Column("name", Text, nullable=False),
    Column("description", Text, nullable=False, server_default=""),
    Column("lead_id", Integer),
    Column("position", Integer, nullable=False, server_default="0"),
    # Who can see this board. "everyone" means anyone with the tracker tag,
    # which is the sane default — a private-by-default tracker is a tracker
    # nobody uses. "restricted" hands the decision to project_access.
    Column("visibility", String(16), nullable=False, server_default="everyone"),
    # The next issue number. Bumped in the same transaction as the insert, so
    # two people creating at once cannot collide.
    Column("issue_seq", Integer, nullable=False, server_default="0"),
    _ts("created_at", nullable=False, server_default=func.now()),
    _ts("archived_at"),
    CheckConstraint("key = upper(key)", name="key_upper"),
    CheckConstraint("visibility in ('everyone','restricted')", name="visibility_known"),
)

# Who may see a restricted project.
#
# Two kinds, because the two questions people actually ask are different: "the
# QA team" is a tag and survives someone joining, while "and Ioana" is a person
# and does not need a tag invented for it. Admins bypass this entirely, as they
# do every other gate in this app.
project_access = Table(
    "project_access", metadata,
    Column("id", Integer, primary_key=True),
    Column("project_id", ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
    Column("kind", String(8), nullable=False),
    # A tag name, or a user id as text. One column because the pair is only
    # ever read together, and a nullable-pair would allow rows meaning neither.
    Column("value", Text, nullable=False),
    Column("granted_by", Integer),
    _ts("granted_at", nullable=False, server_default=func.now()),
    UniqueConstraint("project_id", "kind", "value", name="uq_project_access_project_id"),
    CheckConstraint("kind in ('user','tag')", name="kind_known"),
)

# --------------------------------------------------------------- issue types
# Global, like fields. hierarchy_level makes epic > story > subtask a real
# relationship rather than a naming convention.
issue_types = Table(
    "issue_types", metadata,
    Column("id", Integer, primary_key=True),
    Column("key", String(40), nullable=False, unique=True),
    Column("name", Text, nullable=False),
    Column("icon", Text, nullable=False, server_default=""),
    Column("colour", String(9), nullable=False, server_default="#8b949e"),
    Column("hierarchy_level", Integer, nullable=False, server_default="0"),
    _ts("archived_at"),
)

project_issue_types = Table(
    "project_issue_types", metadata,
    Column("project_id", ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
    Column("issue_type_id", ForeignKey("issue_types.id", ondelete="CASCADE"), primary_key=True),
    Column("position", Integer, nullable=False, server_default="0"),
)

# -------------------------------------------------------------------- status
# Statuses are GLOBAL. In Jira, DRC's "IN REVIEW" and AIW's "In review" are two
# different statuses, which is why cross-project reporting there is miserable.
#
# `category` is the most load-bearing column in the schema. Two things we
# hand-coded against Jira become data here: which statuses count as open, and
# the fact that DRC ships to LIVE while QA ends at Done.
statuses = Table(
    "statuses", metadata,
    Column("id", Integer, primary_key=True),
    Column("key", String(40), nullable=False, unique=True),
    Column("name", Text, nullable=False),
    Column("category", String(16), nullable=False),
    Column("colour", String(9), nullable=False, server_default="#8b949e"),
    _ts("archived_at"),
    CheckConstraint("category in ('todo','in_progress','done')", name="category_known"),
)

# ------------------------------------------------------------------ workflow
workflows = Table(
    "workflows", metadata,
    Column("id", Integer, primary_key=True),
    Column("name", Text, nullable=False),
    Column("description", Text, nullable=False, server_default=""),
    # The status that means "shipped" in this workflow. Replaces the per-project
    # special-casing we needed when only DRC and AID had a Live status.
    Column("shipped_status_id", ForeignKey("statuses.id")),
    # Where each status sits on the diagram: {status_id: {"x": …, "y": …}}.
    # Presentation, deliberately kept with the workflow rather than per person —
    # a diagram everyone lays out differently is a diagram nobody can point at
    # during a conversation. Empty means "lay it out automatically".
    Column("layout", JSONB, nullable=False, server_default="{}"),
    _ts("archived_at"),
)

workflow_statuses = Table(
    "workflow_statuses", metadata,
    Column("workflow_id", ForeignKey("workflows.id", ondelete="CASCADE"), primary_key=True),
    Column("status_id", ForeignKey("statuses.id", ondelete="CASCADE"), primary_key=True),
    Column("position", Integer, nullable=False, server_default="0"),
)

# NULL issue_type_id = the project's default workflow.
project_workflows = Table(
    "project_workflows", metadata,
    Column("id", Integer, primary_key=True),
    Column("project_id", ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
    Column("issue_type_id", ForeignKey("issue_types.id", ondelete="CASCADE")),
    Column("workflow_id", ForeignKey("workflows.id"), nullable=False),
    UniqueConstraint("project_id", "issue_type_id", name="uq_project_workflows_scope"),
)

# from_status_id NULL = "from anywhere" — Won't Do, reopen.
#
# conditions  is it offered?      {"actor": "assignee"}
# validators  is it accepted?     {"field_set": "tested_by"}   (with a reason)
# post_actions what happens next  [{"set_field": {...}}, {"notify": "watchers"}]
transitions = Table(
    "transitions", metadata,
    Column("id", Integer, primary_key=True),
    Column("workflow_id", ForeignKey("workflows.id", ondelete="CASCADE"), nullable=False),
    Column("from_status_id", ForeignKey("statuses.id")),
    Column("to_status_id", ForeignKey("statuses.id"), nullable=False),
    Column("name", Text, nullable=False),
    Column("conditions", JSONB, nullable=False, server_default="{}"),
    Column("validators", JSONB, nullable=False, server_default="{}"),
    Column("post_actions", JSONB, nullable=False, server_default="[]"),
    Column("position", Integer, nullable=False, server_default="0"),
)
Index("ix_transitions_lookup", transitions.c.workflow_id, transitions.c.from_status_id)

# ---------------------------------------------------------------- the fields
# Dynamic, but GLOBAL — one field, one id, forever. Scoping fields per project
# is what made "Utility Points" five different ids in Jira and forced every
# report to carry a resolver map.
#
# `key` is machine-facing and never changes; `name` is display and renames
# freely. Jira conflates them, which is why renaming a field there quietly
# breaks saved filters.
field_defs = Table(
    "field_defs", metadata,
    Column("id", Integer, primary_key=True),
    Column("key", String(64), nullable=False, unique=True),
    Column("name", Text, nullable=False),
    Column("description", Text, nullable=False, server_default=""),
    # Never change this after creation — create a new field and migrate.
    Column("kind", String(16), nullable=False),
    Column("options", JSONB, nullable=False, server_default="[]"),
    # Why it was created. Enough friction for 20 fields in two years, not 200.
    Column("reason", Text, nullable=False, server_default=""),
    Column("created_by", Integer),
    _ts("created_at", nullable=False, server_default=func.now()),
    # Archive, never delete: values stay and old reports keep working.
    _ts("archived_at"),
    CheckConstraint(
        "kind in ('number','text','longtext','select','multiselect','user','date','checkbox','url')",
        name="kind_known",
    ),
    CheckConstraint("key = lower(key)", name="key_lower"),
)

# Where a field appears. Presentation only — never identity.
field_usage = Table(
    "field_usage", metadata,
    Column("id", Integer, primary_key=True),
    Column("field_id", ForeignKey("field_defs.id", ondelete="CASCADE"), nullable=False),
    Column("project_id", ForeignKey("projects.id", ondelete="CASCADE")),
    Column("issue_type_id", ForeignKey("issue_types.id", ondelete="CASCADE")),
    Column("required", Boolean, nullable=False, server_default="false"),
    Column("position", Integer, nullable=False, server_default="0"),
    UniqueConstraint("field_id", "project_id", "issue_type_id", name="uq_field_usage_scope"),
)

# ----------------------------------------------------------------------- git
# A pull request is one thing that can touch several issues, and an issue can
# have several branches and PRs. So the ref is a row of its own and the link is
# a join — the same shape as issue_links, and for the same reason: storing the
# PR once per issue means two copies that disagree the moment one is updated.
# An ask is a question, directed at a person, about an issue, with a state.
#
# The thing comments could never be. There are fifty comments in this database
# and not one of them is something you can be *waiting on* — no state, no owner,
# no age. See docs/ASKS.md; the four kinds exist because the answer is a
# different shape each time.
asks = Table(
    "asks", metadata,
    Column("id", BigInteger, primary_key=True),
    Column("issue_id", BigInteger, ForeignKey("issues.id", ondelete="CASCADE"),
           nullable=False),
    Column("asked_by", Integer, nullable=False),
    Column("asked_of", Integer, nullable=False),
    # confirm | explain | discuss | present
    Column("kind", String(16), nullable=False),
    # Never empty. An ask with no question is a nudge, and a nudge does not
    # deserve somebody's attention.
    Column("question", Text, nullable=False),
    # open | answered | declined | withdrawn
    Column("state", String(16), nullable=False, server_default="open"),
    Column("answer", Text, nullable=False, server_default=""),
    # Whether the work stops until this is answered. A blocking ask counts
    # towards the issue's blocked state, alongside a blocking issue link.
    Column("blocking", Boolean, nullable=False, server_default="false"),
    _ts("asked_at", nullable=False, server_default=func.now()),
    _ts("answered_at"),
    # Who actually answered. Usually the person asked, but a colleague picking
    # it up is a real thing and pretending otherwise loses the truth.
    Column("answered_by", Integer),
)
# The queue: what is open, on whom, oldest first.
Index("ix_asks_of_open", asks.c.asked_of, asks.c.state, asks.c.asked_at)
Index("ix_asks_issue", asks.c.issue_id, asks.c.state)


# Something that may need your attention. Four kinds and no more — see
# docs/ASKS.md section 5. The failure mode of a notification system is not too
# few; it is somebody who has learned to ignore the badge.
notifications = Table(
    "notifications", metadata,
    Column("id", BigInteger, primary_key=True),
    # Who is being told.
    Column("user_id", Integer, nullable=False),
    # asked | ask_answered | assigned | mentioned
    Column("kind", String(24), nullable=False),
    Column("issue_id", BigInteger, ForeignKey("issues.id", ondelete="CASCADE"),
           nullable=False),
    # Who caused it. Null when it was an automation or an integration — and the
    # UI says so rather than inventing a person.
    Column("actor_id", Integer),
    # Rendered once, at the moment it happened. A notification that re-derives
    # its own sentence later is a notification that changes what it said.
    Column("text", Text, nullable=False, server_default=""),
    _ts("at", nullable=False, server_default=func.now()),
    _ts("read_at"),
)
# The bell: what is unread for one person, newest first.
Index("ix_notifications_unread", notifications.c.user_id, notifications.c.read_at,
      notifications.c.at)

# Which of the four kinds a person wants. Absent means all four, because the
# list is short enough that the default is "yes" and the setting exists to turn
# one off rather than to opt in.
notification_prefs = Table(
    "notification_prefs", metadata,
    Column("user_id", Integer, primary_key=True),
    Column("muted", Text, nullable=False, server_default=""),
)


# The axis nothing else covers.
#
# Type says what kind of work it is, status where it has got to, component which
# part of the system, parent what it belongs to — and none of them can say
# "flaky", "needs-design" or "good-first-issue". Those are the words a team
# invents for itself, which is exactly why they are a free-form list rather than
# another configured taxonomy.
#
# Global, like statuses and fields and for the same reason: a label that means
# something different per project makes every cross-project filter a guess.
labels = Table(
    "labels", metadata,
    Column("id", Integer, primary_key=True),
    # Lower-cased and hyphenated on the way in, so "Needs Design", "needs
    # design" and "needs-design" are one label rather than three.
    Column("key", String(40), nullable=False, unique=True),
    Column("name", Text, nullable=False),
    Column("colour", String(9), nullable=False, server_default="#8b949e"),
    Column("description", Text, nullable=False, server_default=""),
    _ts("archived_at"),
)

issue_labels = Table(
    "issue_labels", metadata,
    Column("issue_id", BigInteger, ForeignKey("issues.id", ondelete="CASCADE"),
           primary_key=True),
    Column("label_id", Integer, ForeignKey("labels.id", ondelete="CASCADE"),
           primary_key=True),
    _ts("at", nullable=False, server_default=func.now()),
)
# "Everything tagged flaky", across every board.
Index("ix_issue_labels_label", issue_labels.c.label_id)


git_refs = Table(
    "git_refs", metadata,
    Column("id", Integer, primary_key=True),
    # branch | pr | commit
    Column("kind", String(12), nullable=False),
    Column("repo", Text, nullable=False),
    # The PR number, the branch name, or the commit sha — whatever identifies
    # this ref inside its repo.
    Column("ref", Text, nullable=False),
    Column("title", Text, nullable=False, server_default=""),
    Column("url", Text, nullable=False, server_default=""),
    # open | draft | merged | closed. Empty for a branch, which has no state
    # beyond existing.
    Column("state", String(12), nullable=False, server_default=""),
    # passing | failing | pending | none. Its own column and not folded into
    # state: a merged PR whose build failed is a thing that happens, and the
    # two answers are needed separately.
    Column("checks", String(12), nullable=False, server_default="none"),
    Column("author", Text, nullable=False, server_default=""),
    Column("branch", Text, nullable=False, server_default=""),
    _ts("opened_at"),
    _ts("merged_at"),
    _ts("updated_at", nullable=False, server_default=func.now()),
    UniqueConstraint("repo", "kind", "ref", name="uq_git_refs_repo_kind_ref"),
)
Index("ix_git_refs_state", git_refs.c.state)

# One row per GitHub App installation. An org owner authorises the app once and
# this is what remembers it — so "connect GitHub" is a button somebody presses,
# not a token somebody pastes.
git_installations = Table(
    "git_installations", metadata,
    Column("id", Integer, primary_key=True),
    Column("installation_id", BigInteger, nullable=False, unique=True),
    Column("account_login", Text, nullable=False, server_default=""),
    Column("account_type", String(24), nullable=False, server_default=""),
    # "all" or "selected" — worth showing, because "selected" is the setting
    # that quietly leaves a new repository out.
    Column("repo_selection", String(16), nullable=False, server_default=""),
    Column("suspended", Boolean, nullable=False, server_default="false"),
    Column("connected_by", Integer),
    _ts("connected_at", nullable=False, server_default=func.now()),
    _ts("last_sync_at"),
    Column("last_sync", Text, nullable=False, server_default=""),
    # Marked rather than deleted: the pull requests it brought in stay, and this
    # is the only thing that can explain a gap in them.
    _ts("removed_at"),
)

issue_git = Table(
    "issue_git", metadata,
    Column("issue_id", ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True),
    Column("git_ref_id", ForeignKey("git_refs.id", ondelete="CASCADE"), primary_key=True),
    # How the key was found — "title", "branch", "body". Worth keeping: a link
    # made from a branch name is the one most likely to be a false positive,
    # and without this nobody can tell which those are.
    Column("found_in", String(12), nullable=False, server_default="title"),
    _ts("linked_at", nullable=False, server_default=func.now()),
)
Index("ix_issue_git_ref", issue_git.c.git_ref_id)


# -------------------------------------------------------------------- issues
issues = Table(
    "issues", metadata,
    Column("id", BigInteger, primary_key=True),
    Column("project_id", ForeignKey("projects.id"), nullable=False),
    # PREFIX-N, allocated from projects.issue_seq in the insert's transaction.
    Column("key", String(32), nullable=False, unique=True),
    Column("issue_type_id", ForeignKey("issue_types.id"), nullable=False),
    Column("status_id", ForeignKey("statuses.id"), nullable=False),
    Column("summary", Text, nullable=False),
    Column("description", Text, nullable=False, server_default=""),
    Column("reporter_id", Integer),
    Column("assignee_id", Integer),
    # Who verifies it. A first-class column rather than a configured field
    # because it is asked for on every issue type on every board, and a field
    # that always exists should not be something each project remembers to add.
    # Separate from the assignee on purpose: the person who wrote it is the
    # worst person to be the one who checked it.
    Column("tester_id", Integer),
    # The order a developer works in, set by their team lead. Above the usual
    # five sits `urgent`, which does not mean "very important" — it means stop.
    Column("priority", String(16), nullable=False, server_default="medium"),
    # A separate field from `priority` on purpose. This is the PO saying which
    # work a team should pick up first; `priority` is the lead saying what one
    # developer does next. One field cannot be both — the moment a lead edited
    # it the PO could no longer see their own plan.
    Column("plan_priority", String(16), nullable=False, server_default="medium"),
    # Which team owns this. NULL is deliberate and means free-for-all: either
    # team may take it, and only a lead can.
    Column("team_id", ForeignKey("teams.id", ondelete="SET NULL")),
    # Who made it urgent, when, and why. Urgency without a name attached is how
    # everything becomes urgent by the end of the quarter.
    _ts("urgent_at"),
    Column("urgent_by", Integer),
    Column("urgent_reason", Text, nullable=False, server_default=""),
    Column("parent_id", BigInteger, ForeignKey("issues.id", ondelete="SET NULL")),
    # Lexicographic rank for manual ordering — cheaper than renumbering a column
    # of integers every time somebody drags a card.
    Column("rank", String(64), nullable=False, server_default=""),
    Column("custom", JSONB, nullable=False, server_default="{}"),
    Column("estimate", Numeric(10, 2)),
    _ts("created_at", nullable=False, server_default=func.now()),
    _ts("updated_at", nullable=False, server_default=func.now()),
    _ts("resolved_at"),
    # Archive, never delete: events point at issues.
    _ts("archived_at"),
)
Index("ix_issues_board", issues.c.project_id, issues.c.status_id, issues.c.rank)
Index("ix_issues_assignee", issues.c.assignee_id)
Index("ix_issues_tester", issues.c.tester_id)
Index("ix_issues_updated", issues.c.updated_at.desc())
Index("ix_issues_parent", issues.c.parent_id)
# Containment queries over custom fields. Targeted expression indexes get added
# per field once we know which two or three people actually filter on.
Index("ix_issues_custom", issues.c.custom, postgresql_using="gin")

# ----------------------------------------------------------------- the events
# The reason this project exists in the shape it does. Nearly every useful
# report reads history, not current state — and where Jira has no history (the
# Test status field) that report simply cannot be written.
#
# NOT event sourcing: the issue row is the truth, and events are written in the
# same transaction. All writes go through one repository function so nothing can
# change an entity without leaving a trace.
events = Table(
    "events", metadata,
    Column("id", BigInteger, primary_key=True),
    # entity_type from day one. Releases and projects emit events too — "release
    # created" is a real automation trigger, and issue-only would have meant
    # rewriting every trigger later.
    Column("entity_type", String(24), nullable=False),
    Column("entity_id", BigInteger, nullable=False),
    # Groups the changes made in one save, so the activity feed can render
    # "Alex changed status and assignee" as a single item while each field
    # change stays independently queryable.
    Column("batch_id", BigInteger, nullable=False),
    Column("actor_id", Integer),
    # human | automation | integration — automations ignore their own events by
    # default, which is the first line of defence against rule loops.
    Column("actor_kind", String(16), nullable=False, server_default="human"),
    _ts("at", nullable=False, server_default=func.now()),
    Column("kind", String(32), nullable=False),
    Column("field", String(80)),
    Column("from_value", Text),
    Column("to_value", Text),
    Column("payload", JSONB, nullable=False, server_default="{}"),
)
Index("ix_events_entity", events.c.entity_type, events.c.entity_id, events.c.at)
Index("ix_events_at", events.c.at.desc())
Index("ix_events_batch", events.c.batch_id)
# "when did this field last become X" — the query Jira makes hard.
Index("ix_events_field", events.c.field, events.c.at.desc())

# ------------------------------------------------------------------ comments
# Their own table (editable, deletable, own permissions) but they still emit
# events, so the activity feed stays a single query.
comments = Table(
    "comments", metadata,
    Column("id", BigInteger, primary_key=True),
    Column("issue_id", BigInteger, ForeignKey("issues.id", ondelete="CASCADE"), nullable=False),
    Column("author_id", Integer),
    Column("body", Text, nullable=False),
    _ts("created_at", nullable=False, server_default=func.now()),
    _ts("edited_at"),
    _ts("deleted_at"),
)
Index("ix_comments_issue", comments.c.issue_id, comments.c.created_at)

# --------------------------------------------------------------------- views
# A board is a saved view, not code. "I don't know how it should look yet" is
# exactly why this is data: a new arrangement is ten seconds in the UI.
views = Table(
    "views", metadata,
    Column("id", Integer, primary_key=True),
    # NULL = cross-project, which releases already need.
    Column("project_id", ForeignKey("projects.id", ondelete="CASCADE")),
    Column("name", Text, nullable=False),
    Column("owner_id", Integer),
    Column("shared", Boolean, nullable=False, server_default="false"),
    Column("filter", JSONB, nullable=False, server_default="{}"),
    Column("group_by", String(32), nullable=False, server_default="status"),
    Column("renderer", String(16), nullable=False, server_default="columns"),
    Column("columns", JSONB, nullable=False, server_default="[]"),
    Column("sort", JSONB, nullable=False, server_default="[]"),
    Column("wip_limits", JSONB, nullable=False, server_default="{}"),
    Column("position", Integer, nullable=False, server_default="0"),
    _ts("created_at", nullable=False, server_default=func.now()),
    CheckConstraint(
        "renderer in ('columns','table','timeline','swimlanes')", name="renderer_known"
    ),
)


# --------------------------------------------------------------------- releases
# A release is a dated set of issues plus the things that actually get shipped.
#
# Cross-project by construction: one release, issues from anywhere. In Jira a
# fixVersion belongs to a project, which is why one delivery ends up tagged
# twelve times and no single object knows what shipped.
components = Table(
    "components", metadata,
    Column("id", Integer, primary_key=True),
    Column("key", String(40), nullable=False, unique=True),
    Column("name", Text, nullable=False),
    # The repository this component is built from, when there is one — this is
    # also how a merged PR finds its way onto a release later.
    Column("repo", Text, nullable=False, server_default=""),
    Column("position", Integer, nullable=False, server_default="0"),
    _ts("archived_at"),
)

releases = Table(
    "releases", metadata,
    Column("id", Integer, primary_key=True),
    Column("name", Text, nullable=False),
    # Free text, not an enum. "B-34 fix", "Android", "infra" — we do not know
    # the full set yet and guessing it wrong costs a migration. The UI suggests
    # the ones already in use.
    Column("kind", String(40), nullable=False, server_default="standard"),
    Column("state", String(16), nullable=False, server_default="planning"),
    # When work on this release started, as opposed to when it was created —
    # the difference is what makes cycle time honest.
    _ts("cycle_start"),
    _ts("planned_at"),
    _ts("shipped_at"),
    # Generated from the issues, then edited before publishing. Kept on the
    # release so publishing does not depend on regenerating identically.
    Column("notes", Text, nullable=False, server_default=""),
    Column("notes_published", Boolean, nullable=False, server_default="false"),
    Column("description", Text, nullable=False, server_default=""),
    Column("created_by", Integer),
    _ts("created_at", nullable=False, server_default=func.now()),
    _ts("updated_at", nullable=False, server_default=func.now()),
    _ts("archived_at"),
    CheckConstraint(
        "state in ('planning','in_progress','shipped','cancelled')", name="state_known"
    ),
)

# One row per thing that ships. A release with a single artifact IS a component
# release — a backend hotfix is a release containing `backend 34.0.1`. One
# concept that can be narrow, rather than two concepts.
#
# `shipped_at` is per artifact because mobile ships when Apple says so. Staggered
# delivery inside one release is exactly what the fixVersion tagging was working
# around.
release_artifacts = Table(
    "release_artifacts", metadata,
    Column("id", Integer, primary_key=True),
    Column("release_id", ForeignKey("releases.id", ondelete="CASCADE"), nullable=False),
    Column("component_id", ForeignKey("components.id"), nullable=False),
    Column("version", Text, nullable=False, server_default=""),
    Column("state", String(16), nullable=False, server_default="pending"),
    _ts("planned_at"),
    _ts("shipped_at"),
    Column("notes", Text, nullable=False, server_default=""),
    UniqueConstraint("release_id", "component_id", name="uq_release_artifacts_release_id"),
    CheckConstraint("state in ('pending','shipped','skipped')", name="state_known"),
)

# Issues link to the release, not to an artifact. "Which app version has my fix"
# is derivable from the artifacts; per-issue-per-artifact granularity is purely
# additive later, so it waits.
release_issues = Table(
    "release_issues", metadata,
    Column("release_id", ForeignKey("releases.id", ondelete="CASCADE"), primary_key=True),
    Column("issue_id", ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True),
    Column("added_by", Integer),
    _ts("added_at", nullable=False, server_default=func.now()),
)

# The runbook. Today "Release" is one Jira issue absorbing 153 hours a year as
# an undifferentiated number; an ordered checklist with an owner and a done-at
# makes "what is left before we ship" a query instead of a conversation.
release_actions = Table(
    "release_actions", metadata,
    Column("id", Integer, primary_key=True),
    Column("release_id", ForeignKey("releases.id", ondelete="CASCADE"), nullable=False),
    Column("title", Text, nullable=False),
    Column("description", Text, nullable=False, server_default=""),
    Column("owner_id", Integer),
    Column("position", Integer, nullable=False, server_default="0"),
    _ts("done_at"),
    Column("done_by", Integer),
    _ts("created_at", nullable=False, server_default=func.now()),
)

Index("ix_release_issues_issue", release_issues.c.issue_id)
Index("ix_release_artifacts_release", release_artifacts.c.release_id)
Index("ix_release_actions_release", release_actions.c.release_id, release_actions.c.position)
Index("ix_releases_state", releases.c.state, releases.c.planned_at)


# -------------------------------------------------------------- issue links
# "blocked by", "duplicates", "relates to" — the relationships that are not
# hierarchy.
#
# Directional and stored once: A blocks B is one row, and B's page works out
# that it is blocked by A. Storing both directions would mean two rows that can
# disagree, which is how a link ends up showing on one issue and not the other.
#
# The kind lives in code rather than a table: there are five of them, each needs
# a phrase for both directions, and a lookup table would be five rows nobody
# ever edits plus a join on every read.
issue_links = Table(
    "issue_links", metadata,
    Column("id", Integer, primary_key=True),
    Column("source_id", BigInteger, ForeignKey("issues.id", ondelete="CASCADE"), nullable=False),
    Column("target_id", BigInteger, ForeignKey("issues.id", ondelete="CASCADE"), nullable=False),
    Column("kind", String(24), nullable=False),
    Column("created_by", Integer),
    _ts("created_at", nullable=False, server_default=func.now()),
    UniqueConstraint("source_id", "target_id", "kind", name="uq_issue_links_source_id"),
    CheckConstraint("source_id <> target_id", name="not_itself"),
)

Index("ix_issue_links_source", issue_links.c.source_id)
Index("ix_issue_links_target", issue_links.c.target_id)


# ------------------------------------------------------------- board columns
# A column on the board is a container of statuses, not a status.
#
# The workflow says which statuses exist and how work moves between them; the
# board says how those are grouped for looking at. They are different questions
# and Jira is right to separate them: "Unified / Staging" is one column to a
# person watching a release and two statuses to the workflow, and forcing them
# to be the same thing means either the board grows a column nobody needs or
# the workflow loses a step somebody relies on.
#
# A status in no column is hidden: its issues are simply not on the board.
board_columns = Table(
    "board_columns", metadata,
    Column("id", Integer, primary_key=True),
    Column("project_id", ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
    Column("name", Text, nullable=False),
    Column("position", Integer, nullable=False, server_default="0"),
    # Work in progress limit. Nothing reads it yet; the column is where it will
    # go, and adding it now costs nothing.
    Column("wip_limit", Integer),
    _ts("created_at", nullable=False, server_default=func.now()),
)

board_column_statuses = Table(
    "board_column_statuses", metadata,
    Column("column_id", ForeignKey("board_columns.id", ondelete="CASCADE"), primary_key=True),
    Column("status_id", ForeignKey("statuses.id", ondelete="CASCADE"), primary_key=True),
    Column("position", Integer, nullable=False, server_default="0"),
)

Index("ix_board_columns_project", board_columns.c.project_id, board_columns.c.position)
Index("ix_board_column_statuses_status", board_column_statuses.c.status_id)


# ------------------------------------------------------------------- pauses
# What an interruption actually cost.
#
# One row per stop: when it started, what interrupted it, when it resumed. The
# number nobody has today is the sum of these — how much of a week goes on
# putting down one thing to pick up another. It only stays honest because a
# person presses the button; a system that parked things automatically would be
# measuring its own flag flips.
issue_pauses = Table(
    "issue_pauses", metadata,
    Column("id", BigInteger, primary_key=True),
    Column("issue_id", BigInteger, ForeignKey("issues.id", ondelete="CASCADE"), nullable=False),
    Column("paused_by", Integer),
    # The issue that took over. NULL when somebody parked something for a
    # reason the tracker does not model — a meeting, a day off.
    Column("paused_for_issue_id", BigInteger, ForeignKey("issues.id", ondelete="SET NULL")),
    Column("reason", Text, nullable=False, server_default=""),
    _ts("paused_at", nullable=False, server_default=func.now()),
    _ts("resumed_at"),
)

Index("ix_issue_pauses_open", issue_pauses.c.issue_id, issue_pauses.c.resumed_at)
Index("ix_issue_pauses_for", issue_pauses.c.paused_for_issue_id)


# ----------------------------------------------------------------- automations
# Trigger -> condition -> action, stored as data so the UI can build a rule
# without anyone writing code.
#
# Rules run on a queue, never inside the request that triggered them.
# Automations are slow, they fail, and they cascade; none of that belongs in a
# request a human is waiting on.
automation_rules = Table(
    "automation_rules", metadata,
    Column("id", Integer, primary_key=True),
    Column("name", Text, nullable=False),
    Column("description", Text, nullable=False, server_default=""),
    Column("enabled", Boolean, nullable=False, server_default="true"),
    # NULL = every project. A rule scoped to one project is the common case;
    # "create a QA task for every release" is not.
    Column("project_id", ForeignKey("projects.id", ondelete="CASCADE")),
    # {"type": "issue_created" | "issue_transitioned" | "release_created" | ...,
    #  plus whatever that type needs, e.g. {"to_status_id": 4}}
    Column("trigger", JSONB, nullable=False, server_default="{}"),
    # The same filter shape a saved view uses, compiled by query.py. One filter
    # language for boards and rules means one thing to learn and one to test.
    Column("conditions", JSONB, nullable=False, server_default="{}"),
    Column("actions", JSONB, nullable=False, server_default="[]"),
    # Rules act as themselves, not as whoever tripped them. An automation
    # writing as though it were a person is how an audit trail stops being
    # worth reading.
    Column("run_as", String(20), nullable=False, server_default="automation"),
    # Consecutive failures. A rule that keeps throwing gets switched off rather
    # than retried forever — a broken rule firing every minute is an outage.
    Column("failure_count", Integer, nullable=False, server_default="0"),
    Column("disabled_reason", Text, nullable=False, server_default=""),
    Column("created_by", Integer),
    _ts("created_at", nullable=False, server_default=func.now()),
    _ts("updated_at", nullable=False, server_default=func.now()),
    CheckConstraint("run_as in ('automation','actor')", name="run_as_known"),
)

# One job per (rule, triggering event). The runner retries — that is what makes
# it reliable — so `dedupe_key` is unique and a retry becomes a no-op instead of
# a second comment on the same issue, forever.
automation_jobs = Table(
    "automation_jobs", metadata,
    Column("id", BigInteger, primary_key=True),
    Column("rule_id", ForeignKey("automation_rules.id", ondelete="CASCADE"), nullable=False),
    Column("event_id", BigInteger),
    Column("dedupe_key", Text, nullable=False, unique=True),
    Column("state", String(16), nullable=False, server_default="pending"),
    Column("attempts", Integer, nullable=False, server_default="0"),
    # The queue keys on this: one job in flight per issue, so two rules cannot
    # interleave halfway through changing the same issue.
    Column("issue_id", BigInteger),
    Column("entity_type", String(20), nullable=False, server_default="issue"),
    Column("entity_id", BigInteger),
    # How many automation hops deep this is. Rules ignore automation-caused
    # events by default; this is the hard stop for the ones that opt in.
    Column("depth", Integer, nullable=False, server_default="0"),
    Column("payload", JSONB, nullable=False, server_default="{}"),
    Column("error", Text, nullable=False, server_default=""),
    _ts("scheduled_at", nullable=False, server_default=func.now()),
    _ts("started_at"),
    _ts("finished_at"),
    CheckConstraint("state in ('pending','running','done','failed','skipped')",
                    name="state_known"),
)

Index("ix_automation_jobs_queue", automation_jobs.c.state, automation_jobs.c.scheduled_at)
Index("ix_automation_jobs_issue", automation_jobs.c.issue_id, automation_jobs.c.state)

# The audit log, in v1 rather than later. Jira Automation is only tolerable
# because you can see why a rule did something; without this table every
# surprise is a mystery and the feature gets switched off out of fear.
automation_runs = Table(
    "automation_runs", metadata,
    Column("id", BigInteger, primary_key=True),
    Column("rule_id", ForeignKey("automation_rules.id", ondelete="CASCADE"), nullable=False),
    Column("job_id", BigInteger),
    Column("event_id", BigInteger),
    Column("outcome", String(16), nullable=False),
    # Why the conditions passed or did not — the question actually asked when a
    # rule "did nothing".
    Column("condition_result", Boolean, nullable=False, server_default="true"),
    Column("steps", JSONB, nullable=False, server_default="[]"),
    Column("error", Text, nullable=False, server_default=""),
    Column("dry_run", Boolean, nullable=False, server_default="false"),
    _ts("at", nullable=False, server_default=func.now()),
    CheckConstraint("outcome in ('ran','skipped','failed')", name="outcome_known"),
)

Index("ix_automation_runs_rule", automation_runs.c.rule_id, automation_runs.c.at)

# Small key/value store for the worker: where the event scan got to, mostly.
# A table rather than a module global because it has to survive a restart.
worker_state = Table(
    "worker_state", metadata,
    Column("key", String(64), primary_key=True),
    Column("value", Text, nullable=False, server_default=""),
    _ts("updated_at", nullable=False, server_default=func.now()),
)


Index("ix_issues_team_queue", issues.c.team_id, issues.c.priority, issues.c.rank)
Index("ix_issues_assignee_queue", issues.c.assignee_id, issues.c.priority, issues.c.rank)
Index("ix_team_members_user", team_members.c.user_id)
