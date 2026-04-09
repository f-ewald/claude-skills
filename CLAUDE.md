# Global Rules

## Code Style
- Prefer early return over nested if-else structures.
- Document each method that you write with the language-specific documentation style (e.g., Javadoc for Java, docstrings for Python)
- Avoid long methods; if a method exceeds 40 lines, consider refactoring it into smaller methods.
- Use best practices for specific languages, for example, in Python, follow PEP 8 guidelines for code style and formatting.
- Avoid using global variables; instead, pass necessary data through method parameters or use class-level variables when appropriate.
- Avoid big refactors unless specifically asked to do so. Focus on making minimal necessary changes to achieve the migration goals while maintaining code stability.
- When refactoring, or adding making major changes, make sure to update the CLAUDE.md to reflect the new structure and rules.
- When solving an issue and you encounter debug statements, explicitly ask the user if it is ok to remove them.
