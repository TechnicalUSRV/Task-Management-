"""Language isolation for each request; account preferences override browser hints."""
from rest_framework.renderers import JSONRenderer
from .i18n import language, current_language, normalize_language, render, activate


class LanguageMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from accounts.services import resolve
        user = resolve(request) if not request.path_info.startswith('/tg') else None
        preferred = user.language if user else request.headers.get('X-App-Language', 'en')
        with language(preferred):
            response = self.get_response(request)
            response['Content-Language'] = current_language()
            if user or getattr(request, 'language_account', False):
                response['X-Account-Language'] = current_language()
            return response


class AccountJSONRenderer(JSONRenderer):
    def render(self, data, accepted_media_type=None, renderer_context=None):
        return super().render(render(data), accepted_media_type, renderer_context)
