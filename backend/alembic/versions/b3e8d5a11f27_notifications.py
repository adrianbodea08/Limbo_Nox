"""notifications — four triggers and no more

See docs/ASKS.md section 5. The failure mode of a notification system is not
too few; it is somebody who has learned to ignore the badge.

Revision ID: b3e8d5a11f27
Revises: a7f2c1d9e004
"""

from alembic import op
import sqlalchemy as sa

revision = "b3e8d5a11f27"
down_revision = "a7f2c1d9e004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("issue_id", sa.BigInteger(), nullable=False),
        sa.Column("actor_id", sa.Integer(), nullable=True),
        sa.Column("text", sa.Text(), server_default="", nullable=False),
        sa.Column("at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["issue_id"], ["issues.id"],
                                name=op.f("fk_notifications_issue_id"),
                                ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_notifications")),
    )
    op.create_index("ix_notifications_unread", "notifications",
                    ["user_id", "read_at", "at"], unique=False)

    op.create_table(
        "notification_prefs",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("muted", sa.Text(), server_default="", nullable=False),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_notification_prefs")),
    )


def downgrade() -> None:
    op.drop_table("notification_prefs")
    op.drop_index("ix_notifications_unread", table_name="notifications")
    op.drop_table("notifications")
