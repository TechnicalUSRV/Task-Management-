"""Extension points between apps, so lower layers never import higher ones.

TELEGRAM_UNLINK: callables (staff_id, actor_staff_id, why) run when an account's password changes, the account is
disabled or the person signs out everywhere. The telegram app registers its unlink function here.
"""
TELEGRAM_UNLINK = []
