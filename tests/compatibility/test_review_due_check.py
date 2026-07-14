#!/usr/bin/env python3
from __future__ import annotations

from datetime import date
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "runtime"))
import review_due_check


UUID = "550e8400-e29b-41d4-a716-446655440000"


def artifact_text(kind: str, completion: str | None = "complete") -> str:
    marker = f"completion: {completion}\n" if completion is not None else ""
    return (
        "---\n"
        f"record_kind: ai_authored_{kind}\n"
        f"{marker}"
        "---\n\n"
        f"# {kind.replace('_', ' ').title()}\n"
    )


class ReviewDueCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.sessions = self.root / "sessions"
        self.reviews = self.root / "archive" / "reviews"
        self.sessions.mkdir(parents=True)
        self.reviews.mkdir(parents=True)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def evaluate(
        self,
        today: date = date(2026, 7, 16),
        timezone_status: str = "confirmed",
    ) -> review_due_check.ReviewCheckResult:
        return review_due_check.evaluate(
            today=today,
            timezone=(
                "Europe/Istanbul"
                if timezone_status == "confirmed"
                else "date-override"
                if timezone_status == "date_override"
                else "system-local"
            ),
            timezone_status=timezone_status,
            reviews_dir=self.reviews,
            sessions_dir=self.sessions,
        )

    def write_artifact(
        self,
        kind: str,
        day: str,
        *,
        completion: str | None = "complete",
        legacy: bool = False,
        empty: bool = False,
        clock: str = "120000",
    ) -> Path:
        directory = self.sessions if kind == "session" else self.reviews
        if legacy:
            suffix = ".md" if kind == "session" else "-weekly-review.md"
            filename = f"{day}-{clock[:4]}{suffix}"
            content = "" if empty else (
                artifact_text(kind, completion)
                if completion is not None
                else f"# Legacy {kind.title()}\n"
            )
        else:
            suffix = "session.md" if kind == "session" else "weekly-review.md"
            filename = f"{day}-{clock}--{UUID}--{suffix}"
            content = "" if empty else artifact_text(kind, completion)
        path = directory / filename
        path.write_text(content, encoding="utf-8")
        return path

    def clear_artifacts(self) -> None:
        for directory in (self.sessions, self.reviews):
            for path in directory.iterdir():
                if path.is_symlink() or path.is_file():
                    path.unlink()

    def test_first_week_is_not_due(self) -> None:
        self.write_artifact("session", "2026-07-14")
        result = self.evaluate(date(2026, 7, 15))
        self.assertEqual(result.status, "NOT_DUE")
        self.assertIn("no completed session", result.reason)

    def test_first_return_any_weekday_is_due(self) -> None:
        self.write_artifact("session", "2026-07-10")
        self.assertEqual(self.evaluate().status, "DUE")

    def test_complete_current_week_review_satisfies_due_check(self) -> None:
        self.write_artifact("session", "2026-07-10")
        review = self.write_artifact("review", "2026-07-15")
        result = self.evaluate()
        self.assertEqual(result.status, "NOT_DUE")
        self.assertEqual(result.matches, [review.name])

    def test_future_complete_review_is_ignored(self) -> None:
        self.write_artifact("session", "2026-07-10")
        self.write_artifact("review", "2026-07-17")
        self.assertEqual(self.evaluate().status, "DUE")

    def test_empty_new_artifacts_are_ignored(self) -> None:
        self.write_artifact("session", "2026-07-10", empty=True)
        self.write_artifact("review", "2026-07-15", empty=True)
        result = self.evaluate()
        self.assertEqual(result.status, "NOT_DUE")
        self.assertEqual(result.prior_sessions, [])
        self.assertEqual(result.matches, [])

    def test_new_session_requires_complete_frontmatter(self) -> None:
        self.write_artifact("session", "2026-07-10", completion=None)
        self.assertEqual(self.evaluate().status, "NOT_DUE")
        self.clear_artifacts()
        self.write_artifact("session", "2026-07-10", completion="interrupted_partial")
        self.assertEqual(self.evaluate().status, "NOT_DUE")

    def test_new_review_requires_complete_frontmatter(self) -> None:
        self.write_artifact("session", "2026-07-10")
        self.write_artifact("review", "2026-07-15", completion=None)
        self.assertEqual(self.evaluate().status, "DUE")
        self.clear_artifacts()
        self.write_artifact("session", "2026-07-10")
        self.write_artifact("review", "2026-07-15", completion="incomplete")
        self.assertEqual(self.evaluate().status, "DUE")

    def test_new_marker_must_be_unique_and_in_leading_frontmatter(self) -> None:
        duplicate = self.write_artifact("session", "2026-07-10")
        duplicate.write_text(
            "---\ncompletion: complete\ncompletion: complete\n---\n\n# Session\n",
            encoding="utf-8",
        )
        self.assertEqual(self.evaluate().status, "NOT_DUE")
        duplicate.write_text("# Session\n\ncompletion: complete\n", encoding="utf-8")
        self.assertEqual(self.evaluate().status, "NOT_DUE")
        duplicate.write_text(
            "---\ncompletion: complete\n---\n\n# Session\ncompletion: complete\n",
            encoding="utf-8",
        )
        self.assertEqual(self.evaluate().status, "NOT_DUE")
        duplicate.write_text(
            "---\ncompletion: complete\n# missing closing delimiter\n",
            encoding="utf-8",
        )
        self.assertEqual(self.evaluate().status, "NOT_DUE")

    def test_legacy_nonempty_unmarked_files_remain_compatible(self) -> None:
        session = self.write_artifact("session", "2026-07-10", legacy=True, completion=None)
        review = self.write_artifact("review", "2026-07-15", legacy=True, completion=None)
        result = self.evaluate()
        self.assertEqual(result.status, "NOT_DUE")
        self.assertEqual(result.prior_sessions, [session.name])
        self.assertEqual(result.matches, [review.name])

    def test_legacy_empty_files_are_ignored(self) -> None:
        self.write_artifact("session", "2026-07-10", legacy=True, empty=True)
        self.assertEqual(self.evaluate().status, "NOT_DUE")
        self.clear_artifacts()
        self.write_artifact("session", "2026-07-10")
        self.write_artifact("review", "2026-07-15", legacy=True, empty=True)
        self.assertEqual(self.evaluate().status, "DUE")

    def test_legacy_explicit_incomplete_never_counts(self) -> None:
        self.write_artifact(
            "session", "2026-07-10", legacy=True, completion="interrupted_partial"
        )
        self.assertEqual(self.evaluate().status, "NOT_DUE")
        self.clear_artifacts()
        self.write_artifact("session", "2026-07-10")
        self.write_artifact("review", "2026-07-15", legacy=True, completion="incomplete")
        self.assertEqual(self.evaluate().status, "DUE")

    def test_legacy_explicit_complete_counts(self) -> None:
        self.write_artifact("session", "2026-07-10", legacy=True)
        self.write_artifact("review", "2026-07-15", legacy=True)
        self.assertEqual(self.evaluate().status, "NOT_DUE")

    def test_unconfirmed_timezone_cannot_return_due(self) -> None:
        self.write_artifact("session", "2026-07-10")
        result = self.evaluate(timezone_status="unconfirmed")
        self.assertEqual(result.status, "NOT_DUE")
        self.assertEqual(
            result.reason,
            "timezone is unconfirmed; confirm an IANA timezone before creating a calendar-week review",
        )

    def test_date_override_status_may_return_due(self) -> None:
        self.write_artifact("session", "2026-07-10")
        today, timezone, timezone_status = review_due_check.resolve_clock(
            "2026-07-16", None
        )
        result = review_due_check.evaluate(
            today=today,
            timezone=timezone,
            timezone_status=timezone_status,
            reviews_dir=self.reviews,
            sessions_dir=self.sessions,
        )
        self.assertEqual(result.status, "DUE")

    def test_non_directory_is_an_error(self) -> None:
        bad = self.root / "not-a-directory"
        bad.write_text("not a directory\n", encoding="utf-8")
        with self.assertRaisesRegex(NotADirectoryError, "not a directory"):
            review_due_check.evaluate(
                today=date(2026, 7, 16),
                timezone="Europe/Istanbul",
                timezone_status="confirmed",
                reviews_dir=bad,
                sessions_dir=self.sessions,
            )

    def test_symlink_entry_is_rejected(self) -> None:
        target = self.root / "outside.md"
        target.write_text("outside\n", encoding="utf-8")
        try:
            (self.sessions / "2026-07-10-1200.md").symlink_to(target)
        except OSError as exc:
            self.skipTest(f"symlinks unavailable in this environment: {exc}")
        with self.assertRaisesRegex(ValueError, "symlink entries are not allowed"):
            self.evaluate()

    def test_unknown_timezone_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown IANA timezone"):
            review_due_check.resolve_clock(None, "Not/A_Real_Zone")
        with self.assertRaisesRegex(ValueError, "unknown IANA timezone"):
            review_due_check.resolve_clock("2026-07-14", "Not/A_Real_Zone")

    def run_node(self) -> dict[str, object]:
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node.js is unavailable for parity test")
        node_workspace = self.root / "node-workspace"
        if not (node_workspace / ".scalvin" / "state.json").is_file():
            installed = subprocess.run(
                [
                    node,
                    str(REPO_ROOT / "bin" / "scalvin.js"),
                    "install",
                    "--workspace",
                    str(node_workspace),
                    "--consent",
                    "granted",
                    "--json",
                ],
                cwd=REPO_ROOT,
                env={**os.environ, "SCALVIN_DISABLE_LOCAL_POINTER": "1"},
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(
                installed.returncode,
                0,
                f"Node parity workspace install failed\nstdout:\n{installed.stdout}\nstderr:\n{installed.stderr}",
            )
        for source, destination in (
            (self.sessions, node_workspace / "sessions"),
            (self.reviews, node_workspace / "archive" / "reviews"),
        ):
            destination.mkdir(parents=True, exist_ok=True)
            for existing in destination.iterdir():
                if existing.is_file() or existing.is_symlink():
                    existing.unlink()
                elif existing.is_dir():
                    shutil.rmtree(existing)
            for artifact in source.iterdir():
                shutil.copy2(artifact, destination / artifact.name, follow_symlinks=False)
        result = subprocess.run(
            [
                node,
                str(REPO_ROOT / "bin" / "scalvin.js"),
                "review-due",
                "--workspace",
                str(node_workspace),
                "--date",
                "2026-07-16",
                "--json",
            ],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"Node review-due failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        return json.loads(result.stdout)

    def assert_node_python_parity(self) -> None:
        python_result = self.evaluate(timezone_status="date_override")
        node_result = self.run_node()
        self.assertEqual(node_result["status"], python_result.status)
        self.assertEqual(node_result["reason"], python_result.reason)
        self.assertEqual(node_result["matches"], python_result.matches)
        self.assertEqual(node_result["priorSessionMatches"], python_result.prior_sessions)

    def test_node_python_completion_parity_matrix(self) -> None:
        scenarios = (
            ("complete prior session", (("session", "2026-07-10", "complete", False, False),)),
            ("incomplete prior session", (("session", "2026-07-10", "incomplete", False, False),)),
            (
                "incomplete current review",
                (
                    ("session", "2026-07-10", "complete", False, False),
                    ("review", "2026-07-15", "incomplete", False, False),
                ),
            ),
            (
                "complete current review",
                (
                    ("session", "2026-07-10", "complete", False, False),
                    ("review", "2026-07-15", "complete", False, False),
                ),
            ),
            ("empty legacy session", (("session", "2026-07-10", None, True, True),)),
            ("unmarked legacy session", (("session", "2026-07-10", None, True, False),)),
        )
        for name, artifacts in scenarios:
            with self.subTest(name=name):
                self.clear_artifacts()
                for kind, day, completion, legacy, empty in artifacts:
                    self.write_artifact(
                        kind,
                        day,
                        completion=completion,
                        legacy=legacy,
                        empty=empty,
                    )
                self.assert_node_python_parity()


if __name__ == "__main__":
    unittest.main()
