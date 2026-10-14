from django.apps import AppConfig


class TelegramConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'telegram'

    def ready(self):
        from core import hooks
        from .services import unlink_account
        if unlink_account not in hooks.TELEGRAM_UNLINK:
            hooks.TELEGRAM_UNLINK.append(unlink_account)
