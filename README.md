# Collection of Claude Skills

* `skills/` contains the actual skills, organized by category.
* `CLAUDE.md` contains the global rules that apply to all Claude sessions.


## How to use

1. Clone this repository to your local machine
2. Create a symlink to the `skills/` directory inside your `~/.claude/` folder
```bash
ln -s /path/to/claude-skills/skills/ ~/.claude/skills
ln -s /path/to/claude-skills/CLAUDE.md ~/.claude/CLAUDE.md
ln -s /path/to/claude-skills/statusline.sh ~/.claude/statusline.sh
```

Update your `~/.claude/settings.json` and add the following as a root level key:

```
"statusLine": {
    "type": "command",
    "command": "bash /home/fewald/.claude/statusline.sh"
}
```

## Using these skills in GitHub Copilot

These skills use the open Agent Skills (`SKILL.md`) standard, which GitHub Copilot also supports —
see [docs/using-skills-in-copilot.md](docs/using-skills-in-copilot.md) for step-by-step instructions.
