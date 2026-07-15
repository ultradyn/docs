# Terra-specific eval expectations

Run the shared core evals. Terra should be judged on quality per tool call/token, not maximal novelty.

Record:

- repository files read more than once without need;
- out-of-scope files changed;
- number of reopened settled decisions;
- visual passes and P0/P1 closure rate;
- missing states/themes;
- final score per quality gate.

Fail Terra-specific evaluation when the model wanders, repeatedly re-analyzes, creates more than two cosmetic variants, or claims completion without an observed render.
