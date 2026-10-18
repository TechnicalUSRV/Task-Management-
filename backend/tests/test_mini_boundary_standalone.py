"""Run without a database: python -m unittest discover -s tests -p test_mini_boundary_standalone.py"""
import unittest

from core.mini_boundary import MiniAppBoundary


class MiniBoundaryTests(unittest.TestCase):
    def check_route(self, path, method="GET", script_name=""):
        calls = []
        statuses = []

        def downstream(environ, start_response):
            calls.append(environ)
            start_response("204 No Content", [])
            return [b""]

        app = MiniAppBoundary(downstream, "default")
        result = list(app(
            {"PATH_INFO": path, "REQUEST_METHOD": method, "SCRIPT_NAME": script_name},
            lambda status, headers: statuses.append(status),
        ))
        return calls, statuses, result

    def test_mini_page_assets_and_gateway_reach_downstream(self):
        routes = [
            ("/c/default/tg", "GET"), ("/c/default/tg/", "GET"),
            ("/assets/tg-ABC12345.js", "GET"), ("/assets/font-ABC12345.woff2", "HEAD"),
            ("/assets/pdf.worker.min-rsCePomN.mjs", "GET"),
        ]
        routes += [(f"/c/default/tg/api/{x}", "GET") for x in
                   ("state", "changes", "organization", "report", "photo", "file", "file-preview", "group", "group-rows", "group-members", "group-delivery", "group-file", "group-file-preview")]
        routes += [(f"/c/default/tg/api/{x}", "POST") for x in ("login", "link", "command")]
        for path, method in routes:
            with self.subTest(path=path, method=method):
                calls, statuses, _ = self.check_route(path, method)
                self.assertEqual(len(calls), 1)
                self.assertEqual(statuses, ["204 No Content"])

    def test_office_and_ambiguous_routes_never_reach_django(self):
        paths = [
            "/", "/index.html", "/tg.html", "/c/default/", "/api/state",
            "/TaskManagement", "/TaskManagement/", "/TaskManagement/api/state",
            "/api/auth/login", "/c/default/api/command", "/admin/",
            "/c/default/tg/api/group/shares", "/c/default/tg/api/group-file/../state", "/api/tasks/group", "/c/other/tg/", "/c/default/tg/api/auth/setup",
            "/assets/../index.html", "/assets/%2e%2e/index.html",
            "/assets/%252e%252e/index.html", "/assets/..\\index.html",
            "/assets/file.js/../../api/state", "//c/default/tg/",
            "/assets/bundle.js.map", "/c/default/tg/api/state/", "/assets/x..y.mjs", "/assets/.hidden.mjs", "/assets/worker.mjs.map",
        ]
        for path in paths:
            for method in ("GET", "POST", "HEAD"):
                with self.subTest(path=path, method=method):
                    calls, statuses, body = self.check_route(path, method)
                    self.assertEqual(calls, [])
                    self.assertEqual(statuses, ["404 Not Found"])
                    if method == "HEAD":
                        self.assertEqual(body, [])

    def test_wrong_methods_and_mounts_are_denied(self):
        for path, method, script in [
            ("/assets/tg-ABC12345.js", "POST", ""),
            ("/c/default/tg/", "POST", ""),
            ("/c/default/tg/api/command", "GET", ""),
            ("/c/default/tg/api/state", "POST", ""),
            ("/c/default/tg/", "GET", "/other"),
        ]:
            self.assertEqual(self.check_route(path, method, script)[0], [])


if __name__ == "__main__":
    unittest.main()
