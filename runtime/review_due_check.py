#!/usr/bin/env python3
# version: 1.0.0
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
import re
import sys
from zoneinfo import ZoneInfo


WEEKLY_REVIEW_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-\d{4}-weekly-review\.md$")


@dataclass(frozen=True)
class ReviewCheckResult:
    status: str
    today: date
    week_start: date
    reason: str
    matches: list[str]


def default_reviews_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "archive" / "reviews"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Deterministically decide whether a weekly review is due."
    )
    parser.add_argument("--date", dest="date_override", help="Override today's date in YYYY-MM-DD format.")
    parser.add_argument("--timezone", help="Optional IANA timezone name.")
    parser.add_argument("--reviews-dir", default=str(default_reviews_dir()), help="Path to the reviews directory.")
    return parser.parse_args()


def resolve_today(date_override: str | None, timezone_name: str | None) -> date:
    if date_override:
        return date.fromisoformat(date_override)
    if timezone_name:
        return datetime.now(ZoneInfo(timezone_name)).date()
    return datetime.now().astimezone().date()


def current_review_week_start(today: date) -> date:
    return today - timedelta(days=today.weekday())


def weekly_review_files_for_week(reviews_dir: Path, week_start: date, today: date) -> list[str]:
    matches: list[str] = []
    for path in sorted(reviews_dir.iterdir()):
        name = path.name
        if name.startswith("._") or not path.is_file():
            continue
        match = WEEKLY_REVIEW_RE.match(name)
        if not match:
            continue
        file_date = date.fromisoformat(match.group(1))
        if file_date > today:
            continue
        if current_review_week_start(file_date) == week_start:
            matches.append(name)
    return matches


def evaluate(today: date, reviews_dir: Path) -> ReviewCheckResult:
    week_start = current_review_week_start(today)
    matches = weekly_review_files_for_week(reviews_dir, week_start, today)

    if matches:
        return ReviewCheckResult(
            status="NOT_DUE",
            today=today,
            week_start=week_start,
            reason="weekly review already exists for the current review week",
            matches=matches,
        )

    if today.weekday() == 0:
        return ReviewCheckResult(
            status="DUE",
            today=today,
            week_start=week_start,
            reason="it is Monday and no weekly review exists for the current review week",
            matches=[],
        )

    if today.weekday() == 1:
        return ReviewCheckResult(
            status="DUE",
            today=today,
            week_start=week_start,
            reason="Monday was missed and Tuesday late-review rule applies",
            matches=[],
        )

    return ReviewCheckResult(
        status="NOT_DUE",
        today=today,
        week_start=week_start,
        reason="automatic weekly reviews are only due on Monday or missed-Monday Tuesday",
        matches=[],
    )


def main() -> int:
    args = parse_args()
    reviews_dir = Path(args.reviews_dir)
    if not reviews_dir.exists():
        print(f"ERROR=reviews directory not found: {reviews_dir}")
        return 1

    try:
        today = resolve_today(args.date_override, args.timezone)
    except Exception as exc:
        print(f"ERROR=failed to resolve date: {exc}")
        return 1

    result = evaluate(today, reviews_dir)
    print(f"STATUS={result.status}")
    print(f"TODAY={result.today.isoformat()}")
    print(f"REVIEW_WEEK_START={result.week_start.isoformat()}")
    print(f"REASON={result.reason}")
    print("MATCHES=" + ",".join(result.matches) if result.matches else "MATCHES=")
    return 0


if __name__ == "__main__":
    sys.exit(main())
