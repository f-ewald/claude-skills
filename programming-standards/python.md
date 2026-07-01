# Python Standards

Language-specific standards and libraries for Python code. These build on the
always-on rules in `CLAUDE.md` / `COPILOT.md`; where this file is more specific
(e.g. formatting), it takes precedence over the general "follow PEP 8" guidance.

## Formatting

- **Line length:** hard limit of **120 characters**. Wrap longer lines.
- **Indentation:** always **2 spaces** per level. Never use tabs, and never use
  4-space indentation (this intentionally overrides PEP 8's 4-space rule).
- One statement per line; align continuation lines for readability.

## Documentation

Use **Google-style docstrings** — this is LinkedIn's Python convention.

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

## Testing

Use **pytest** as the test framework and runner.

- Name test files `test_*.py` and test functions `test_*`.
- Use plain `assert` statements (pytest rewrites them for rich failure output)
  rather than `unittest` assertion methods.
- Prefer fixtures over `setUp`/`tearDown`, and `@pytest.mark.parametrize` to
  cover multiple cases without duplication.
- Keep tests isolated and independent of execution order.

## Libraries & tooling

| Concern | Use |
| --- | --- |
| Testing | pytest |
