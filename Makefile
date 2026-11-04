# 后端四道闸,与 .github/workflows/ci.yml 保持同一顺序:
# ruff -> mypy -> import-linter(分层契约)-> pytest。`make check` 一条跑完。

.PHONY: install run lint typecheck layers test check

install:
	python3 -m pip install -r requirements.txt -r requirements-dev.txt

run:
	uvicorn app.main:app --reload

lint:
	python3 -m ruff check app scripts tests migrations

typecheck:
	python3 -m mypy

layers:
	lint-imports

test:
	python3 -m pytest

check: lint typecheck layers test
