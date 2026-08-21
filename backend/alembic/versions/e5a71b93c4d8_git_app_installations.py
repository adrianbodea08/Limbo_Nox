"""Remember a GitHub App installation.

One row per org that has authorised the app, so connecting GitHub is a button
rather than a personal access token pasted into settings.

Additive; nothing existing changes. Tracker Postgres only.
"""
from alembic import op
import sqlalchemy as sa


revision = "e5a71b93c4d8"
down_revision = "d83c1f4a5e20"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "git_installations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("installation_id", sa.BigInteger(), nullable=False),
        sa.Column("account_login", sa.Text(), server_default="", nullable=False),
        sa.Column("account_type", sa.String(length=24), server_default="", nullable=False),
        sa.Column("repo_selection", sa.String(length=16), server_default="", nullable=False),
        sa.Column("suspended", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("connected_by", sa.Integer(), nullable=True),
        sa.Column("connected_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("last_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_sync", sa.Text(), server_default="", nullable=False),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_git_installations")),
        sa.UniqueConstraint("installation_id", name=op.f("uq_git_installations_installation_id")),
    )


def downgrade() -> None:
    op.drop_table("git_installations")
