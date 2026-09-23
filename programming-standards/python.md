# Python Standards

Language-specific standards and libraries for Python code. These build on the
always-on rules in `AGENTS.md`; where this file is more specific
(e.g. formatting), it takes precedence over the general "follow PEP 8" guidance.

## Formatting

- **Line length:** hard limit of **120 characters**. Wrap longer lines.
- **Indentation:** always **4 spaces** per level (matching PEP 8). Never use tabs.
- One statement per line; align continuation lines for readability.

## Imports

- Put **all imports at the top of the file** — never inside functions, methods, or
  conditionals. The only lines above them are the module docstring and any
  `from __future__` imports.
- Group them in the standard order — standard library, third-party, then local —
  separated by a blank line. Ruff's import sorting enforces this.
- Avoid deferred/inline imports; use one only to break a genuine circular import
  or to guard a truly optional or heavy dependency, and add a short comment saying
  why.

## Documentation

Use **Google-style docstrings** as the documentation convention.

- Every module, public class, and public function/method has a docstring.
- Open with a one-line summary, then optional detail, then the
  `Args:` / `Returns:` / `Raises:` sections as applicable.
- Prefer type hints on public signatures so types live in the signature, not
  repeated in prose.

```python
def compute_score(events: list[Event], weight: float = 1.0) -> float:
    """Computes a weighted engagement score for a list of events.

    Args:
        events: The events to score. Must be non-empty.
        weight: Multiplier applied to the raw score.

    Returns:
        The weighted engagement score.

    Raises:
        ValueError: If ``events`` is empty.
    """
    if not events:
        raise ValueError("events must be non-empty")
    return sum(e.value for e in events) * weight
```

## Type hints

Prefer modern built-in generic and union syntax over the legacy `typing`
equivalents **when the project's minimum supported Python version allows it**:

- **Unions:** write `X | None` instead of `Optional[X]`, and `X | Y` instead of
  `Union[X, Y]`. The `|` operator works at runtime on **Python 3.10+** (PEP 604).
- **Built-in generics:** write `list[int]`, `dict[str, int]`, `tuple[str, ...]`
  instead of `typing.List` / `Dict` / `Tuple` (PEP 585, **Python 3.9+**).

If the project must still support older versions, add `from __future__ import
annotations` at the top of the module — annotations become lazy strings, so
`X | None` and `list[int]` are accepted in **annotation positions** back to
Python 3.7. Prefer that over reintroducing `typing`.

Keep `Optional` / `Union` (and `List` / `Dict`) only where the type is evaluated
at **runtime** and the `|` syntax genuinely isn't available — e.g. `isinstance()`,
`cast(...)`, a `TypeVar` bound, or a `< 3.10` target where the `__future__` import
can't be used. Don't mix the two styles within a file.

## Async

**Prefer async whenever the work is I/O-bound.** If a project serves requests,
queries a database, or calls another service, choose the async-capable option at
every layer: an ASGI web framework, an async database driver, an async HTTP
client. Stay synchronous only when the workload is genuinely CPU-bound, the code
is a short-lived script, or no async equivalent exists.

The rule that makes this pay off: **never call a blocking function from a
coroutine.** A single sync database call or `requests.get()` inside an `async def`
stalls the whole event loop, and the symptom is collapsing tail latency with
nothing in the logs to point at.

- Go async end to end. A half-async stack — async handlers over a sync driver —
  is usually worse than an honest sync one.
- To call a sync-only library (`boto3`, `psycopg2`, a vendor SDK), wrap it
  explicitly in `anyio.to_thread.run_sync()` or `asyncio.to_thread()`. Both are
  escape hatches for I/O only; the GIL means CPU-bound work needs a process pool.
- Don't lean on the framework's implicit threadpool. In FastAPI/Starlette a plain
  `def` endpoint is silently dispatched to AnyIO's shared pool, which defaults to
  **40 threads for the whole application** — sync endpoints queue behind each
  other under load.
- Write structured concurrency against **anyio** (task groups, cancel scopes) but
  target the **asyncio** runtime. Trio is not a realistic target: SQLAlchemy,
  asyncpg, aiohttp, and redis-py are all asyncio-only.
- Give every concurrent task its own SQLAlchemy `AsyncSession`. One session is
  not safe to share across `asyncio.gather()` tasks. Set `expire_on_commit=False`,
  eager-load relationships (lazy loading raises in async), and dispose the engine
  with `await engine.dispose()` on shutdown — there is no async destructor.

## Web stack

**Default to FastAPI served by uvicorn.** Not because FastAPI is the
best-engineered option — Litestar arguably is — but because a default should
optimise for recoverability: documentation, integrations, and answers when you
are stuck. FastAPI's ecosystem lead over every alternative is roughly two orders
of magnitude.

FastAPI is still `0.x` and ships breaking changes in **minor** releases by
documented policy, so **pin the minor** — e.g. `fastapi>=0.141,<0.142`. This is
not optional.

Acceptable alternatives, in order of when to reach for them:

- **Litestar** — when you want its explicit `sync_to_thread=True|False` contract
  (it warns if you don't choose, instead of silently threadpooling like FastAPI)
  or msgspec as the core serializer. Smaller ecosystem; 3.0 is unreleased.
- **Django + Django Ninja** — only when you actually want the Django ORM, admin,
  and migrations. Django's async support is retrofitted: **transactions still
  don't work in async mode** (wrap them in `sync_to_async()`), and `CONN_MAX_AGE`
  persistent connections must be disabled.
- **Quart** — for migrating an existing Flask codebase to async, where keeping the
  Flask API matters more than built-in validation and OpenAPI. Not a greenfield
  choice.

**Do not start a new I/O-bound service on Flask.** Flask's `async def` support is
a shim, not async: it starts an event loop in a worker thread per request, so
each request still occupies one worker and total concurrency is unchanged.
`asyncio.create_task` doesn't survive the view returning. Flask's own docs
recommend Quart for mainly-async codebases.

### Serving

- Run **uvicorn** directly — `fastapi run --workers N` or `uvicorn --workers N` —
  or one process per container when an orchestrator handles scaling.
- **Never use `gunicorn -k uvicorn.workers.UvicornWorker`.** `uvicorn.workers` is
  deprecated and slated for removal; the old recipe is still widely copied.
- Reach for **granian** when you need HTTP/2 or hit a throughput ceiling — uvicorn
  is HTTP/1.1 only. Treat granian's published benchmarks as vendor claims.
- Keep a reverse proxy in front for TLS termination, static files, and slow-client
  buffering. Verify HTTP/2 end to end if you chose a server for it — a proxy that
  doesn't pass it through silently downgrades you.

## Streaming JSON

**Use ijson to consume large JSON responses incrementally.** `response.json()`
/ `json.loads()` buffer the whole body and build the full object tree in memory;
ijson parses the stream and yields objects as they complete, so memory stays flat
regardless of payload size.

- Use `ijson.items(source, prefix)` to yield the objects under a prefix (e.g.
  `"results.item"` for each element of a top-level `results` array), and
  `ijson.kvitems` when individual objects are themselves too large. Drop to
  `ijson.parse` only when you need raw events.
- Pass a file-like object with `read()` (sync) or `async read()` directly. For a
  chunk iterator such as httpx's `iter_bytes()` / `aiter_bytes()`, push chunks
  into `ijson.items_coro()` as below — it works on every 3.x release. Feed
  **bytes**, not `str`.
- In async code, drive ijson from an async source — consistent with the async
  rules above, never read a blocking stream from a coroutine.
- Numbers come back as `Decimal` by default; pass `use_float=True` when floats
  are acceptable.
- Check `ijson.backend` is `yajl2_c`. The pure-Python fallback is much slower and
  is selected silently when the C extension isn't available.
- **Always close the stream.** This is the most common pitfall. Open it with
  `async with client.stream(...)` / `with client.stream(...)` (or `with urlopen(...)`)
  so the connection returns to the pool even when parsing raises. A stream left
  open keeps its connection checked out until the pool runs dry and httpx raises
  `PoolTimeout`.
- A streaming generator like the one below only leaves its `async with` when it is
  exhausted or closed — `break`ing out of the loop does **not** close it. When the
  caller may stop early, wrap it in `contextlib.aclosing()` (`contextlib.closing()`
  for sync generators) so the stream closes immediately rather than whenever the
  garbage collector finalizes the generator.
- Call `parser.close()` after the last chunk: it flushes the final items and
  raises `IncompleteJSONError` if the body was truncated.

```python
async def fetch_records(client: httpx.AsyncClient, url: str) -> AsyncIterator[dict]:
    """Yields each record from a large JSON response without buffering the body.

    Args:
        client: The HTTP client to issue the request with.
        url: Endpoint returning ``{"results": [...]}``.

    Yields:
        Each element of the ``results`` array.
    """
    records = ijson.sendable_list()
    parser = ijson.items_coro(records, "results.item")
    async with client.stream("GET", url) as response:
        response.raise_for_status()
        async for chunk in response.aiter_bytes():
            parser.send(chunk)
            for record in records:
                yield record
            del records[:]
    parser.close()
    for record in records:
        yield record


async def first_match(client: httpx.AsyncClient, url: str) -> dict | None:
    """Returns the first matching record, closing the stream as soon as it is found."""
    async with contextlib.aclosing(fetch_records(client, url)) as records:
        async for record in records:
            if is_match(record):
                return record
    return None
```

## Testing

Use **pytest** as the test framework and runner.

- Name test files `test_*.py` and test functions `test_*`.
- Use plain `assert` statements (pytest rewrites them for rich failure output)
  rather than `unittest` assertion methods.
- Prefer fixtures over `setUp`/`tearDown`, and `@pytest.mark.parametrize` to
  cover multiple cases without duplication.
- Keep tests isolated and independent of execution order.

## Tooling

- **Linting & formatting:** prefer **Ruff**. But if a project already has a
  different linter/formatter configured (e.g. flake8, pylint, black, isort), leave
  it in place — do not swap it out or layer Ruff on top.
- **Package management:** prefer **uv** for dependency resolution, virtual
  environments, and installing/running packages.

## Libraries & tooling

| Concern | Use |
| --- | --- |
| Testing | pytest |
| Linting & formatting | Ruff (unless another is already set up) |
| Package management | uv |
| YAML | yamlrocks |
| Web framework | FastAPI (pin the minor); Litestar as alternative |
| ASGI server | uvicorn; granian when HTTP/2 is needed |
| Concurrency API | anyio, on the asyncio runtime |
| ORM / SQL toolkit | SQLAlchemy 2.x async (`sqlalchemy[asyncio]`) |
| Migrations | Alembic (`alembic init -t async`) |
| PostgreSQL driver | psycopg 3 — `postgresql+psycopg://` |
| MySQL driver | asyncmy |
| Redis | redis-py — `import redis.asyncio`. Never `aioredis` |
| HTTP client | httpx (async API); aiohttp when asyncio-only is fine |
| Streaming JSON parsing | ijson (C `yajl2_c` backend) |
