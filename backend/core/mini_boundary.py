"""Deny-by-default WSGI boundary for the internet-facing Telegram process."""
import re

# Built files: name-hash.ext, where the name may have dots between its parts (pdf.worker.min-<hash>.mjs, the PDF
# preview's worker) but never an empty part, so "." and ".." can't appear.
_ASSET = re.compile(r"/assets/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:m?js|css|woff2?|ttf|png|jpg|jpeg|gif|svg|ico|webp)")
_GET_API = frozenset({"state", "changes", "organization", "report", "photo", "file", "file-preview"})
_POST_API = frozenset({"login", "link", "command"})


class MiniAppBoundary:
    """Only expose the company Mini App; authentication remains in telegram.gateway."""

    def __init__(self, application, company_id):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", company_id):
            raise ValueError("Invalid company ID")
        self.application = application
        self.base = f"/c/{company_id}/tg"

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        method = environ.get("REQUEST_METHOD", "")
        allowed = False
        # Refuse ambiguous paths, including double-encoded traversal. The normal
        # frontend view unquotes paths again, so literal percent signs are unsafe.
        if not environ.get("SCRIPT_NAME") and "%" not in path and "\\" not in path:
            if method in ("GET", "HEAD"):
                allowed = path in (self.base, self.base + "/") or bool(_ASSET.fullmatch(path))
            if path.startswith(self.base + "/api/"):
                endpoint = path[len(self.base + "/api/"):]
                allowed = (method == "GET" and endpoint in _GET_API) or (
                    method == "POST" and endpoint in _POST_API
                )
        if allowed:
            return self.application(environ, start_response)
        body = b'{"error":"Not found."}'
        start_response("404 Not Found", [
            ("Content-Type", "application/json"),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
        ])
        return [] if method == "HEAD" else [body]
