"""Branches and pull requests, linked to the issues they name.

A pull request is one object that can touch several issues, and an issue can
have several branches and PRs — so the ref is a row and the link is a join,
rather than a copy of the PR per issue that would disagree with itself.

Additive; nothing existing changes. Tracker Postgres only.
"""
from alembic import op
import sqlalchemy as sa


revision = "d83c1f4a5e20"
down_revision = "c41d7a2b90e5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "git_refs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=12), nullable=False),
        sa.Column("repo", sa.Text(), nullable=False),
        sa.Column("ref", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), server_default="", nullable=False),
        sa.Column("url", sa.Text(), server_default="", nullable=False),
        sa.Column("state", sa.String(length=12), server_default="", nullable=False),
        sa.Column("checks", sa.String(length=12), server_default="none", nullable=False),
        sa.Column("author", sa.Text(), server_default="", nullable=False),
        sa.Column("branch", sa.Text(), server_default="", nullable=False),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("merged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_git_refs")),
        sa.UniqueConstraint("repo", "kind", "ref", name="uq_git_refs_repo_kind_ref"),
    )
    op.create_index(op.f("ix_git_refs_state"), "git_refs", ["state"], unique=False)

    op.create_table(
        "issue_git",
        sa.Column("issue_id", sa.BigInteger(), nullable=False),
        sa.Column("git_ref_id", sa.Integer(), nullable=False),
        sa.Column("found_in", sa.String(length=12), server_default="title", nullable=False),
        sa.Column("linked_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["issue_id"], ["issues.id"],
                                name=op.f("fk_issue_git_issue_id"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["git_ref_id"], ["git_refs.id"],
                                name=op.f("fk_issue_git_git_ref_id"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("issue_id", "git_ref_id", name=op.f("pk_issue_git")),
    )
    op.create_index(op.f("ix_issue_git_ref"), "issue_git", ["git_ref_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_issue_git_ref"), table_name="issue_git")
    op.drop_table("issue_git")
    op.drop_index(op.f("ix_git_refs_state"), table_name="git_refs")
    op.drop_table("git_refs")
