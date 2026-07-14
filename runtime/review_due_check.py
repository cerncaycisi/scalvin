#!/usr/bin/env python3
# version: 2.1.0
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
import re
import sys
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


OLD_WEEKLY_REVIEW_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2})-\d{4}-weekly-review\.md$"
)
NEW_WEEKLY_REVIEW_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2})-\d{6}--[0-9a-fA-F-]{36}--weekly-review\.md$"
)
OLD_SESSION_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-\d{4}\.md$")
NEW_SESSION_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2})-\d{6}--[0-9a-fA-F-]{36}--session\.md$"
)
COMPLETION_LINE_RE = re.compile(
    r"^completion:\s*([^\r\n#]+?)\s*$", re.MULTILINE | re.IGNORECASE
)
LEADING_FRONTMATTER_RE = re.compile(
    r"^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)"
)


@dataclass(frozen=True)
class ReviewCheckResult:
    status: str
    today: date
    week_start: date
    timezone: str
    timezone_status: str
    reason: str
    matches: list[str]
    prior_sessions: list[str]


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_reviews_dir() -> Path:
    return workspace_root() / "archive" / "reviews"


def default_sessions_dir() -> Path:
    return workspace_root() / "sessions"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Decide whether a session-triggered weekly review is due."
    )
    parser.add_argument(
        "--date", dest="date_override", help="Override today's date (YYYY-MM-DD)."
    )
    parser.add_argument("--timezone", help="Confirmed IANA timezone name.")
    parser.add_argument(
        "--reviews-dir",
        default=str(default_reviews_dir()),
        help="Path to archive/reviews.",
    )
    parser.add_argument(
        "--sessions-dir",
        default=str(default_sessions_dir()),
        help="Path to sessions.",
    )
    return parser.parse_args()


def resolve_clock(
    date_override: str | None, timezone_name: str | None
) -> tuple[date, str, str]:
    if date_override:
        if timezone_name:
            try:
                ZoneInfo(timezone_name)
            except ZoneInfoNotFoundError as exc:
                raise ValueError(f"unknown IANA timezone: {timezone_name}") from exc
        return date.fromisoformat(date_override), timezone_name or "date-override", "date_override"
    if timezone_name:
        try:
            zone = ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(f"unknown IANA timezone: {timezone_name}") from exc
        return datetime.now(zone).date(), timezone_name, "confirmed"
    local = datetime.now().astimezone()
    local_name = getattr(local.tzinfo, "key", None) or str(local.tzinfo) or "system-local"
    return local.date(), local_name, "unconfirmed"


def current_review_week_start(today: date) -> date:
    return today - timedelta(days=today.weekday())


def require_directory(path: Path, label: str) -> None:
    if not path.exists():
        raise FileNotFoundError(f"{label} directory not found: {path}")
    if not path.is_dir():
        raise NotADirectoryError(f"{label} path is not a directory: {path}")


def normalize_completion_value(value: str) -> str:
    return value.strip().lower()


def completion_values(text: str) -> list[str]:
    return [normalize_completion_value(match.group(1)) for match in COMPLETION_LINE_RE.finditer(text)]


def leading_frontmatter(text: str) -> str | None:
    match = LEADING_FRONTMATTER_RE.match(text)
    return match.group(1) if match else None


def is_countable_artifact(path: Path, legacy: bool) -> bool:
    text = path.read_text(encoding="utf-8")
    if not text.strip().removeprefix("\ufeff").strip():
        return False

    if legacy:
        markers = completion_values(text)
        if not markers:
            return True
        return markers == ["complete"]

    frontmatter = leading_frontmatter(text)
    if frontmatter is None:
        return False
    return completion_values(text) == ["complete"] and completion_values(frontmatter) == ["complete"]


def dated_matches(
    directory: Path, patterns: tuple[tuple[re.Pattern[str], bool], ...]
) -> list[tuple[Path, date]]:
    matches: list[tuple[Path, date]] = []
    for path in sorted(directory.iterdir()):
        if path.name.startswith("."):
            continue
        if path.is_symlink():
            raise ValueError(f"symlink entries are not allowed in {directory}: {path.name}")
        if not path.is_file():
            continue
        for pattern, legacy in patterns:
            match = pattern.match(path.name)
            if match:
                if is_countable_artifact(path, legacy=legacy):
                    matches.append((path, date.fromisoformat(match.group(1))))
                break
    return matches


def evaluate(
    today: date,
    timezone: str,
    timezone_status: str,
    reviews_dir: Path,
    sessions_dir: Path,
) -> ReviewCheckResult:
    require_directory(reviews_dir, "reviews")
    require_directory(sessions_dir, "sessions")

    week_start = current_review_week_start(today)
    reviews = dated_matches(
        reviews_dir, ((NEW_WEEKLY_REVIEW_RE, False), (OLD_WEEKLY_REVIEW_RE, True))
    )
    current_week_reviews = [
        path.name
        for path, created_on in reviews
        if week_start <= created_on <= today
    ]

    sessions = dated_matches(
        sessions_dir, ((NEW_SESSION_RE, False), (OLD_SESSION_RE, True))
    )
    prior_sessions = [
        path.name for path, session_on in sessions if session_on < week_start
    ]

    if current_week_reviews:
        return ReviewCheckResult(
            status="NOT_DUE",
            today=today,
            week_start=week_start,
            timezone=timezone,
            timezone_status=timezone_status,
            reason="weekly review already exists for the current calendar week",
            matches=current_week_reviews,
            prior_sessions=prior_sessions,
        )

    if not prior_sessions:
        return ReviewCheckResult(
            status="NOT_DUE",
            today=today,
            week_start=week_start,
            timezone=timezone,
            timezone_status=timezone_status,
            reason="no completed session exists before the current calendar week",
            matches=[],
            prior_sessions=[],
        )

    if timezone_status not in {"confirmed", "date_override"}:
        return ReviewCheckResult(
            status="NOT_DUE",
            today=today,
            week_start=week_start,
            timezone=timezone,
            timezone_status=timezone_status,
            reason="timezone is unconfirmed; confirm an IANA timezone before creating a calendar-week review",
            matches=[],
            prior_sessions=prior_sessions,
        )

    return ReviewCheckResult(
        status="DUE",
        today=today,
        week_start=week_start,
        timezone=timezone,
        timezone_status=timezone_status,
        reason="first returning session this week; prior-week session exists and no current-week review exists",
        matches=[],
        prior_sessions=prior_sessions,
    )


def main() -> int:
    args = parse_args()
    try:
        today, timezone, timezone_status = resolve_clock(
            args.date_override, args.timezone
        )
        result = evaluate(
            today=today,
            timezone=timezone,
            timezone_status=timezone_status,
            reviews_dir=Path(args.reviews_dir),
            sessions_dir=Path(args.sessions_dir),
        )
    except Exception as exc:
        print(f"ERROR={exc}")
        return 1

    print(f"STATUS={result.status}")
    print(f"TODAY={result.today.isoformat()}")
    print(f"REVIEW_WEEK_START={result.week_start.isoformat()}")
    print(f"TIMEZONE={result.timezone}")
    print(f"TIMEZONE_STATUS={result.timezone_status}")
    print(f"REASON={result.reason}")
    print("MATCHES=" + ",".join(result.matches))
    print("PRIOR_SESSION_MATCHES=" + ",".join(result.prior_sessions))
    return 0


if __name__ == "__main__":
    sys.exit(main())
