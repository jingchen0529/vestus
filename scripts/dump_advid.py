"""一次性导出：把 browser_page_visit.url_params 里的某个参数捞成 CSV。

url_params 存的是 urlencode 过的 query string（不带前导 ?），所以取值必须先
parse_qsl 解码，不能用字符串切割 —— 那样会把 %3D 之类的编码值带出来，也会让
advid 命中 aadvid。

用法：
    # 导出全部 advid 明细
    python -m scripts.dump_advid

    # 导出指定日期的 advid 明细
    python -m scripts.dump_advid --date 2026-09-14

    # 导出指定日期范围的去重列表
    python -m scripts.dump_advid --start 2026-09-01 --end 2026-09-14 --unique

    # 仅导出指定日期去重后的 advid 纯列表（单列）
    python -m scripts.dump_advid --date 2026-09-14 --unique --values-only

    # 导出指定参数等于某值的记录
    python -m scripts.dump_advid --value 1859424992244810
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterator, Optional, Set, Tuple
from urllib.parse import parse_qsl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import asc, select

from app.db.base import iso_datetime, parse_datetime
from app.db.models import BrowserPageVisit, BrowserSession
from app.db.session import Database

COLUMNS = [
    "param_value",
    "session_id",
    "username",
    "platform_name",
    "url",
    "url_params",
    "visits",
    "clicks",
    "inputs",
    "submits",
    "first_seen_at",
    "last_seen_at",
    "session_started_at",
]

COLUMNS_UNIQUE = [
    "param_value",
    "occurrences",
    "total_visits",
    "first_seen_at",
    "last_seen_at",
    "usernames",
]


@dataclass
class ParamStat:
    value: str
    occurrences: int = 0
    total_visits: int = 0
    first_seen_at: Optional[datetime] = None
    last_seen_at: Optional[datetime] = None
    usernames: Set[str] = field(default_factory=set)

    def record(
        self,
        username: str,
        visits: int,
        first_seen_at: Optional[datetime],
        last_seen_at: Optional[datetime],
    ) -> None:
        self.occurrences += 1
        self.total_visits += (visits or 0)
        if username:
            self.usernames.add(username)
        if first_seen_at and (self.first_seen_at is None or first_seen_at < self.first_seen_at):
            self.first_seen_at = first_seen_at
        if last_seen_at and (self.last_seen_at is None or last_seen_at > self.last_seen_at):
            self.last_seen_at = last_seen_at


def extract(url_params: Optional[str], param: str) -> list[str]:
    """url_params 里该参数的所有取值，已解码。重复出现的都要。"""

    if not url_params:
        return []
    pairs = parse_qsl(url_params, keep_blank_values=True)
    return [value for name, value in pairs if name == param]


def rows(
    database: Database,
    param: str,
    value: Optional[str] = None,
    start_at: Optional[datetime] = None,
    end_at: Optional[datetime] = None,
) -> Iterator[Tuple]:
    with database.session() as session:
        # LIKE 只做粗筛，把不含该参数名的行挡在 Python 之外；精确判断在 extract()。
        # 使用 contains(..., autoescape=True) 确保参数化绑定与通配符转义。
        conditions = [
            BrowserPageVisit.url_params.contains(param, autoescape=True)
        ]
        if start_at is not None:
            conditions.append(BrowserPageVisit.last_seen_at >= start_at)
        if end_at is not None:
            conditions.append(BrowserPageVisit.first_seen_at <= end_at)

        stmt = (
            select(BrowserPageVisit, BrowserSession)
            .join(BrowserSession, BrowserPageVisit.session_id == BrowserSession.id)
            .where(*conditions)
            .order_by(asc(BrowserSession.id), asc(BrowserPageVisit.first_seen_at))
        )
        for visit, sess in session.execute(stmt):
            for found in extract(visit.url_params, param):
                if value is not None and found != value:
                    continue
                yield (
                    found,
                    sess.id,
                    sess.username,
                    sess.platform_name or "",
                    visit.url,
                    visit.url_params or "",
                    visit.visits,
                    visit.clicks,
                    visit.inputs,
                    visit.submits,
                    visit.first_seen_at,
                    visit.last_seen_at,
                    sess.started_at,
                )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="导出 url_params 中的指定参数")
    parser.add_argument("--param", default="advid", help="要提取的参数名，默认 advid")
    parser.add_argument("--value", default=None, help="只导出该参数等于此值的记录")
    parser.add_argument("--date", default=None, help="指定日期 (YYYY-MM-DD)，导出当天的记录")
    parser.add_argument("--start", default=None, help="起始时间/日期 (如 2026-09-01 或 2026-09-01 08:00:00)")
    parser.add_argument("--end", default=None, help="截止时间/日期 (如 2026-09-14 或 2026-09-14 18:00:00)")
    parser.add_argument("--unique", action="store_true", help="导出去重后的参数列表")
    parser.add_argument("--values-only", action="store_true", help="仅在去重模式下生效：只导出参数值单列")
    parser.add_argument("--db-url", default=None, help="数据库连接 URL (默认读取 .env 中的 VESTUS_DATABASE_URL)")
    parser.add_argument("-o", "--output", default="advid-export.csv", help="输出 CSV 路径")
    args = parser.parse_args(argv)

    if args.date and (args.start or args.end):
        parser.error("--date 不能与 --start 或 --end 同时使用")

    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    if args.date:
        start_at = parse_datetime(args.date)
        end_at = parse_datetime(args.date, end_of_day=True)
    else:
        if args.start:
            start_at = parse_datetime(args.start)
        if args.end:
            end_at = parse_datetime(args.end, end_of_day=True)

    # 只读脚本，跳过建表和首个管理员引导。
    database = Database(url=args.db_url, initialize=False)
    out = Path(args.output)

    if args.unique:
        stats: dict[str, ParamStat] = defaultdict(lambda: ParamStat(value=""))
        raw_count = 0
        for row in rows(database, args.param, args.value, start_at=start_at, end_at=end_at):
            found = str(row[0])
            username = row[2]
            visits = int(row[6] or 0)
            first_seen_at = row[10]
            last_seen_at = row[11]
            if found not in stats:
                stats[found] = ParamStat(value=found)
            stats[found].record(username, visits, first_seen_at, last_seen_at)
            raw_count += 1

        with out.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.writer(handle)
            if args.values_only:
                writer.writerow([args.param])
                for val in sorted(stats.keys()):
                    writer.writerow([val])
            else:
                writer.writerow(COLUMNS_UNIQUE)
                for _val, stat in sorted(stats.items()):
                    writer.writerow([
                        stat.value,
                        stat.occurrences,
                        stat.total_visits,
                        iso_datetime(stat.first_seen_at) if stat.first_seen_at else "",
                        iso_datetime(stat.last_seen_at) if stat.last_seen_at else "",
                        "; ".join(sorted(stat.usernames)),
                    ])

        print(
            f"共匹配 {raw_count} 条记录，导出 {len(stats)} 个去重的 {args.param} 值 -> {out}"
        )
        if stats and len(stats) <= 20:
            for item in sorted(stats.keys()):
                print(f"  {item}")
    else:
        count = 0
        seen: set[str] = set()
        with out.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.writer(handle)
            writer.writerow(COLUMNS)
            for row in rows(database, args.param, args.value, start_at=start_at, end_at=end_at):
                writer.writerow(row)
                seen.add(str(row[0]))
                count += 1

        print(f"导出 {count} 行明细，{len(seen)} 个不同的 {args.param} 值 -> {out}")
        if seen and len(seen) <= 20:
            for item in sorted(seen):
                print(f"  {item}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
