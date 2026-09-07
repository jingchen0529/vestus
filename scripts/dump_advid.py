"""一次性导出：把 browser_page_visit.url_params 里的某个参数捞成 CSV。

url_params 存的是 urlencode 过的 query string（不带前导 ?），所以取值必须先
parse_qsl 解码，不能用字符串切割 —— 那样会把 %3D 之类的编码值带出来，也会让
advid 命中 aadvid。

用法：
    python -m scripts.dump_advid                      # 导出全部 advid
    python -m scripts.dump_advid --value 1859424992244810
    python -m scripts.dump_advid --param aadvid -o /tmp/out.csv
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path
from typing import Iterator, Optional, Tuple
from urllib.parse import parse_qsl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import asc, select

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


def extract(url_params: Optional[str], param: str) -> list[str]:
    """url_params 里该参数的所有取值，已解码。重复出现的都要。"""

    if not url_params:
        return []
    pairs = parse_qsl(url_params, keep_blank_values=True)
    return [value for name, value in pairs if name == param]


def rows(database: Database, param: str, value: Optional[str]) -> Iterator[Tuple]:
    with database.session() as session:
        # LIKE 只做粗筛，把不含该参数名的行挡在 Python 之外；精确判断在 extract()。
        stmt = (
            select(BrowserPageVisit, BrowserSession)
            .join(BrowserSession, BrowserPageVisit.session_id == BrowserSession.id)
            .where(BrowserPageVisit.url_params.like(f"%{param}%"))
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


def main() -> int:
    parser = argparse.ArgumentParser(description="导出 url_params 中的指定参数")
    parser.add_argument("--param", default="advid", help="要提取的参数名，默认 advid")
    parser.add_argument("--value", default=None, help="只导出该参数等于此值的记录")
    parser.add_argument("-o", "--output", default="advid-export.csv", help="输出 CSV 路径")
    args = parser.parse_args()

    # 只读脚本，跳过建表和首个管理员引导。
    database = Database(initialize=False)
    out = Path(args.output)
    count = 0
    seen: set[str] = set()

    with out.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        writer.writerow(COLUMNS)
        for row in rows(database, args.param, args.value):
            writer.writerow(row)
            seen.add(str(row[0]))
            count += 1

    print(f"导出 {count} 行，{len(seen)} 个不同的 {args.param} 值 -> {out}")
    if seen and len(seen) <= 20:
        for item in sorted(seen):
            print(f"  {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
