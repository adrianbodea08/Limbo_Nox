"""accounts into postgres, and the foreign keys that were never possible

Accounts and sessions lived in a separate SQLite database, and this table was a
copy of them kept in sync on every request. The reason was that Nox used to be
one feature inside another product, where an instance could have accounts and no
tracker database at all. Standing alone that state means "the app does nothing",
so the split has no job left.

It cost more than tidiness. **Twenty-six columns across this schema hold a user
id and not one of them declared a foreign key**, because you cannot declare one
across two database engines. Deleting an account left its issues, comments and
events pointing at nobody, and nothing anywhere would have complained.

This adds the account columns to `users`, creates `sessions`, and then adds
those twenty-six constraints. Checked before writing it: zero orphaned
references, so every one of them can be created without cleaning anything first.

The ids do not change. `users.id` has always been the account id, so every
column already points at the right row and no data moves.

Revision ID: f2a7c9d40b13
Revises: c5d1e9b408aa
"""

from alembic import op
import sqlalchemy as sa

revision = "f2a7c9d40b13"
down_revision = "c5d1e9b408aa"
branch_labels = None
depends_on = None


# What happens to somebody's work when their account is deleted. Three answers,
# and which one a column gets is a decision about the product rather than about
# the database:
#
#   RESTRICT  history and authorship. You cannot delete a person who wrote
#             something; deal with what they wrote first. The alternative is an
#             event log with holes in it, which is worse than an awkward delete.
#   SET NULL  assignment. Unassigning is a normal thing that happens to work
#             every day, so it is what deleting an assignee means.
#   CASCADE   rows that only exist because that person does. Their sessions,
#             their notifications, their saved views.
RESTRICT = [
    ("asks", "asked_by"), ("asks", "answered_by"),
    ("automation_rules", "created_by"),
    ("comments", "author_id"),
    ("events", "actor_id"),
    ("field_defs", "created_by"),
    ("git_installations", "connected_by"),
    ("issue_links", "created_by"),
    ("issue_pauses", "paused_by"),
    ("issues", "reporter_id"), ("issues", "urgent_by"),
    ("project_access", "granted_by"),
    ("release_actions", "done_by"),
    ("release_issues", "added_by"),
    ("releases", "created_by"),
]

SET_NULL = [
    ("asks", "asked_of"),
    ("issues", "assignee_id"), ("issues", "tester_id"),
    ("projects", "lead_id"),
    ("release_actions", "owner_id"),
    ("teams", "lead_id"),
    ("notifications", "actor_id"),
]

CASCADE = [
    ("notification_prefs", "user_id"),
    ("notifications", "user_id"),
    ("team_members", "user_id"),
    ("views", "owner_id"),
]


def _name(table: str, column: str) -> str:
    return f"fk_{table}_{column}_users"


def upgrade() -> None:
    # --- the account, on the person ---------------------------------------
    # Nullable: a row here is a person, and an account is something a person
    # may have. It also means eighteen existing rows do not each need a value
    # invented for them before the column can exist.
    for name, type_ in (
        ("username", sa.Text()),
        ("email", sa.Text()),
        ("password_hash", sa.Text()),
        ("code", sa.Text()),
        ("jira_account_id", sa.Text()),
        ("bug_rate", sa.Float()),
    ):
        op.add_column("users", sa.Column(name, type_, nullable=True))

    for name, type_, default in (
        ("salt", sa.Text(), "''"),
        ("role", sa.String(16), "'member'"),
        ("status", sa.String(16), "'pending'"),
        ("nickname", sa.Text(), "''"),
        ("tags", sa.Text(), "''"),
    ):
        op.add_column("users", sa.Column(name, type_, nullable=False,
                                         server_default=sa.text(default)))
    for name in ("myboard_enabled", "releases_enabled"):
        op.add_column("users", sa.Column(name, sa.Boolean(), nullable=False,
                                         server_default=sa.text("true")))
    op.add_column("users", sa.Column("created_at", sa.DateTime(timezone=True),
                                     nullable=False, server_default=sa.text("now()")))

    # Unique rather than a plain index. Postgres lets many rows be NULL under a
    # unique constraint, which is exactly the behaviour wanted: any number of
    # people without a login, at most one account per name.
    op.create_unique_constraint("uq_users_username", "users", ["username"])
    op.create_unique_constraint("uq_users_email", "users", ["email"])

    # --- sessions ----------------------------------------------------------
    op.create_table(
        "sessions",
        sa.Column("token", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("token", name=op.f("pk_sessions")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"],
                                name=op.f("fk_sessions_user_id"),
                                ondelete="CASCADE"),
    )
    op.create_index("ix_sessions_user", "sessions", ["user_id"])

    # --- the twenty-six ----------------------------------------------------
    for rule, columns in (("RESTRICT", RESTRICT), ("SET NULL", SET_NULL),
                          ("CASCADE", CASCADE)):
        for table, column in columns:
            op.create_foreign_key(_name(table, column), table, "users",
                                  [column], ["id"], ondelete=rule)


def downgrade() -> None:
    for _, columns in (("", RESTRICT), ("", SET_NULL), ("", CASCADE)):
        for table, column in columns:
            op.drop_constraint(_name(table, column), table, type_="foreignkey")

    op.drop_index("ix_sessions_user", table_name="sessions")
    op.drop_table("sessions")

    op.drop_constraint("uq_users_email", "users", type_="unique")
    op.drop_constraint("uq_users_username", "users", type_="unique")
    for name in ("username", "email", "password_hash", "salt", "role", "status",
                 "nickname", "tags", "code", "myboard_enabled",
                 "releases_enabled", "jira_account_id", "bug_rate", "created_at"):
        op.drop_column("users", name)
