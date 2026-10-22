"""Errors shared by every API. Responses keep the V5.7.7 shape: {"error": "<message>"} with the HTTP status."""
from core.i18n import msg as _message, render
import logging

from django.http import Http404, JsonResponse
from rest_framework import exceptions as drf
from rest_framework.response import Response

log = logging.getLogger(__name__)

GENERIC_ERROR = _message('Unable to complete this operation. Your saved data has been preserved.')


class InputError(Exception):
    """A request the person can correct; the message is shown to them exactly."""

    def __init__(self, message, status=400, details=None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.details = details


def fail(message, status=400, details=None):
    raise InputError(message, status, details)


def error_body(exc):
    body = {'error': render(exc.message)}
    if exc.details is not None:
        body['details'] = exc.details
    return body


def json_error(exc):
    return JsonResponse(error_body(exc), status=exc.status)


def exception_handler(exc, context):
    """DRF hook: InputError and DRF errors become {"error": ...}; anything else is logged and hidden."""
    if isinstance(exc, InputError):
        return Response(error_body(exc), status=exc.status)
    if isinstance(exc, (drf.NotAuthenticated, drf.AuthenticationFailed)):
        return Response({'error': _message('Sign in to continue.')}, status=401)
    if isinstance(exc, drf.PermissionDenied):
        return Response({'error': str(exc.detail)}, status=403)
    if isinstance(exc, (Http404, drf.NotFound)):
        return Response({'error': _message('Route not found.')}, status=404)
    if isinstance(exc, drf.MethodNotAllowed):
        return Response({'error': _message('Method not allowed.')}, status=405)
    if isinstance(exc, drf.UnsupportedMediaType):
        return Response({'error': _message('JSON is required.')}, status=415)
    if isinstance(exc, drf.ParseError):
        return Response({'error': _message('Invalid JSON.')}, status=400)
    if isinstance(exc, drf.Throttled):
        return Response({'error': _message('Too many changes in a short time. Wait a moment and try again.')}, status=429)
    if isinstance(exc, drf.APIException):
        return Response({'error': str(exc.detail)}, status=exc.status_code)
    log.exception(_message('Unhandled API error'), exc_info=exc)
    return Response({'error': GENERIC_ERROR}, status=500)
