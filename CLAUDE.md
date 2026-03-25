# Claude Skills

A collection of reusable custom skills for Claude Code.

## Project Structure

```
skills/
  <skill-name>/
    SKILL.md
```

Each skill lives in its own folder under `skills/` and is defined by a `SKILL.md` file.

## Adding a New Skill

1. Create a new folder under `skills/` with the skill name (use kebab-case).
2. Add a `SKILL.md` file inside that folder.
3. The `SKILL.md` must include YAML frontmatter with `name` and `description` fields, followed by the skill prompt.

### SKILL.md Format

```markdown
---
name: <skill-name>
description: <Short description of what the skill does and when to trigger it.>
---

<Skill prompt content>
```

- `name`: The skill identifier, matching the folder name.
- `description`: Describes the skill's purpose and trigger conditions. Claude Code uses this to determine when the skill applies.
- The body after the frontmatter is the prompt that Claude will follow when the skill is invoked.
