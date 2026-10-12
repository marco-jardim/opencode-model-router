// src/verify/runner.ts
//
// RUNNER ADAPTER: design note (plan Task 1.3.1) and typed contract.
// Implementation: Task 1.3.2 (parts 1 and 2).
//
// Plan:     docs/plans/verification-resource-budget-plan.md, section 1.5 (decisions 1-6, 10, 11), Phase 1.3.
// Evidence: docs/qa/verification-resource-budget/phase-1.3.md (Spike C: vitest 4.1.11, jest 30.5.2,
//           pytest 9.x + pytest-xdist 3.8), reports in test/fixtures/runner/reports/, and the
//           extra runs made for this design, listed in section R below.
//
// This module plans verification commands. It never spawns anything and must not import
// child_process. It turns (check command, cwd, changed files, budget) into one of three results:
// an argv spec, a "nothing to run" note, or an S6 `unverifiable` reason. After a run, it turns the
// result into failing test identities. It reaches the outside world only through injected seams:
// FsSeam/PlannerFs/RunnerFs for the filesystem, TestSearchSeam for test-file searches (the caller runs git)
// and RunnerHost for platform, execPath, tmpdir, core count, PATH and ids.
//
// Sections: B detection, C script parsing, D user arguments, E worker cap, F entry resolution,
// G changed files, H argv construction, I results and identities, J S5 decision, K lint,
// L allowlist, M reasons, N security, O deviations, P unverified, Q consumers, R extra evidence.
//
// Notation: P = (host.platform === "win32" ? path.win32 : path.posix), used for every path
// operation so Windows cases can be unit-tested on Linux. key(p) = win32 ? p.toLowerCase() : p.
// <where> = "command" (the check command) or "scripts.<name>". <rel> = gitRoot-relative path with
// "/" separators.
//
// ------------------------------------------------------------------------------------------------
// B. RUNNER DETECTION (detectRunner; section 1.5-4)
//
//   Step 0  gitRoot: walk up from cwd until fs.fileExists(<dir>/.git), which accepts a dir or a
//           file, so worktrees work. No .git found -> S6 no-git-root.
//   Step 1  Composite scan (C.2) of the raw command, <where> = "command".
//   Step 2  Tokenize (C.1) and match the head. Tokens must match exactly: no path, no extension.
//
//   head                                                   result
//   -----------------------------------------------------  ------------------------------------------
//   vitest ...                                             vitest, launcher "direct"
//   npx vitest ...          (token[1] is exactly vitest)   vitest, launcher "npx"
//   pnpm exec vitest ...                                   vitest, launcher "pnpm-exec"
//   jest ... | npx jest ... | pnpm exec jest ...           jest, same launchers
//   pytest ...                                             pytest, launcher "direct"
//   uv run pytest ...       (exactly these three tokens)   pytest, launcher "uv-run"
//   npm test | npm t | npm run <s> | npm run-script <s>    package script s ("test" for test/t)
//   pnpm test | pnpm t | pnpm run <s>                      package script
//   yarn test | yarn run <s>                               package script
//   bun run <s>                                            package script
//   bun test ...                                           S6 bun-test (Bun's built-in runner; O.1)
//   NAME=value ... (no cross-env)                          S6 inline-env
//   anything else: dotenv, node, sh, env, npx -y, pnpm dlx, uv run python, uvx, mocha,
//   node --test, cross-env-shell, ...                      S6 unsupported-command
//
//   The unsupported-command construct is the accepted-form prefix plus the first offending token:
//   "dotenv", "npx -y", "pnpm dlx", "uv run python", "npm" (a package manager inside a script).
//
//   Package scripts:
//   - package.json is the nearest one, walking up from cwd to gitRoot (inclusive). None found ->
//     S6 no-package-json. JSON parse error or not an object -> S6 bad-package-json. scripts[s]
//     missing or not a string -> S6 no-script.
//   - Extra args. npm: tokens after "--" are appended to the script. Tokens between the script
//     name and "--" are npm's own flags. Only the harmless ones (-s --silent -q --quiet -d
//     --if-present --ignore-scripts --color[=v] --no-color --loglevel=v) are ignored, with a
//     note; any other token there (-w, --workspace[s], -ws, --prefix, --include-workspace-root, a
//     positional, ...) -> S6 unsupported-command "npm <token>", because it can select another
//     package's script (QA-1.3-6). pnpm, yarn and bun: tokens after the script name are appended,
//     minus a leading "--". Without that "--", a location option (-w -ws -C -F -r -g --workspace
//     --workspaces --include-workspace-root --workspace-root --prefix --dir --cwd --filter
//     --recursive --global, also "=v" forms) -> S6 unsupported-command "<pm> <token>". Options
//     before the subcommand are already S6 ("npm -w", "pnpm --filter").
//   - npm configuration that selects a workspace (QA-1.3-24): a `workspace` or `workspaces` key
//     (also `workspace[]`) in any .npmrc from cwd up to gitRoot -> S6 unsupported-command
//     "npm workspace" in <.npmrc path>; an unreadable one -> "npm" in "<path> (unreadable)"; a
//     non-empty npm_config_workspace(s) variable, any case, in the host env or cross-env -> S6
//     "npm <NAME>" in "the environment" / "cross-env". npm 12.0.2 ran the workspace's script for
//     each. `prefix` and `include-workspace-root` are not checked: set there they did not move
//     `npm test` off the root script (prefix only moves the global prefix). QA-1.3-32: keys are
//     read the way npm's ini parser reads them (a BOM, quotes around the key and JSON escapes
//     inside them, a key without "=", `;`/`#` cutting an unquoted key), and the same check runs
//     for the npx launcher (npm exec honours the workspace config and runs in the workspace's
//     directory), from runnerCwd, in commands and scripts alike. An .npmrc over
//     CONFIG_SIZE_LIMIT -> S6 config-too-large.
//   - The script text goes through C.2 (<where> = "scripts.<s>"), C.1, C.3 and the head table,
//     restricted to the DIRECT forms (vitest, jest, pytest, npx, pnpm exec, uv run pytest).
//     Only one level of script resolution: a package-manager head inside a script (npm run x,
//     pnpm build) -> S6 unsupported-command.
//   - runnerCwd = dirname(package.json). For direct commands, runnerCwd = cwd.
//   - pre<s>/post<s> scripts are not run. Each one present adds the note
//     `scripts.pre<s> is not run by the scoped command` (no S6: see O.11).
//
// ------------------------------------------------------------------------------------------------
// C. SCRIPT PARSING
//
//   C.1 Tokenizer (a POSIX-style subset, identical on every platform)
//     - Spaces and tabs separate tokens.
//     - "..." groups, and inside it only \" is an escape (it yields "). The quotes are removed.
//     - '...' groups literally. The quotes are removed.
//     - A backslash outside quotes is a literal character, so Windows paths survive.
//     - Adjacent parts join into one token: a"b c"d -> "ab cd".
//     - An unterminated quote -> S6 unterminated-quote.
//     Known divergence: npm on Windows runs scripts through cmd.exe, where '...' does not quote
//     (see P).
//
//   C.2 Composite scan (raw text, quotes IGNORED, like FORBIDDEN_SHELL in deterministic.ts)
//     Scan left to right. The first position with a match wins, and at one position the longer
//     construct wins (&& over &). The constructs are:
//       newline (\r or \n), &&, ||, ;, |, &, >, <, `, $(, $, %VAR% (regex %[A-Za-z_][A-Za-z0-9_]*%;
//       a bare "50%" is not a construct).
//     Reason: composite <where>: "<construct>", where a newline is reported as "newline".
//     Examples: `vitest run && eslint .` -> composite scripts.test: "&&".
//               `npm run a; npm run b` -> composite scripts.test: ";".
//
//   C.3 cross-env (section 1.5-4)
//     If token[0] is "cross-env", every following token matching /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
//     is consumed into env, and a later assignment of the same name wins. The first other token
//     starts the command. `cross-env X=1 Y="a b" vitest run` gives env {X:"1", Y:"a b"} and
//     runner vitest. cross-env with no command -> S6 unsupported-command "cross-env". cross-env
//     followed by a composite is already S6 composite (C.2 runs first).
//
// ------------------------------------------------------------------------------------------------
// D. USER ARGUMENTS (the tokens after the runner head)
//
//   D.0 Spelling normalization (QA-1.3-3b, QA-1.3-10), applied before every table lookup:
//     - vitest and jest: "--kebab-case" is compared as "--camelCase" (yargs and cac accept both);
//       "--no-" stays a negation prefix. The table names are normalized the same way. A kept
//       token keeps the user's spelling.
//     - Grouped short options are split the way the runner's parser splits them:
//         vitest (mri)      flags w u h v, values c r t. Every letter but the last must be a
//                           flag; the last takes "=v" or the next token. "-cfoo", "-w4" -> S6.
//         jest (yargs)      flags b e f h i o u v, values c t w. Flags chain until a value
//                           letter, whose attached value must be "=v" or a number ("-w4",
//                           "-iw4"); "-cjest.config.js" (yargs: c, j, e, s, t=".config.js")
//                           -> S6.
//         pytest (argparse) flags q v x s l h V f, values k m c o W r p n. Flags chain until a
//                           value letter, which takes the rest or the next token: "-qn3" is
//                           "-q -n3", "-vrA" is "-v -rA".
//       A group containing any other letter -> S6 unsupported-argument. eslint is not split.
//   D.1 Algorithm, one token t at a time, left to right:
//     a. t === "--"              -> S6 unsupported-argument "--".
//     b. DROP entry              -> remove t and its value tokens.
//     c. CAP entry               -> remove t and its value, and record the value (E). Special
//                                   entries are noted as "kept" below.
//     d. KEEP-value entry        -> keep t and its value tokens, in order.
//     e. KEEP-flag entry         -> keep t.
//     f. S6 entry                -> S6 unsupported-argument t (lint: Unscoped).
//     g. any other option (a token starting with "-"):
//          vitest and jest: S6 unsupported-argument (QA-1.3-10: an unknown spelling of a DROP
//          option, such as "--update-snapshot", must never pass through). pytest and eslint:
//          if it contains "=", keep it verbatim;
//          if the next token is absent or starts with "-", keep it verbatim (a flag);
//          otherwise -> S6 ambiguous-option (we cannot tell whether the next token is its value).
//     h. positional (no leading "-"):
//          vitest: the FIRST positional equal to run|watch|dev|related is dropped silently.
//                  One equal to bench|list|init|typecheck -> S6 unsupported-subcommand.
//                  Every other positional is a filter: dropped, with one note
//                  `vitest filters dropped: a, b`.
//          jest:   positionals are testPathPatterns: dropped, note `jest filters dropped: ...`.
//          pytest: a path scope. It is resolved against runnerCwd. If it contains "::" or any of
//                  * ? [ ] { }, or resolves outside gitRoot -> S6 unsupported-argument.
//          eslint: a path scope, with the same rules (-> Unscoped instead of S6).
//   Matching rules:
//     - "--name" matches both "--name" and "--name=v". With the inline "=v" form, the arity is
//       ignored.
//     - An entry ending in ".*" matches by prefix: "--coverage.*" matches "--coverage.reporter=text".
//     - A short entry "-x" with arity 1 also matches the attached form "-xVALUE" (-rA, -n4,
//       -pno:cacheprovider).
//   Arity:
//     0  no value;
//     1  the next token, unconditionally;
//     ?  the next token only if it does not start with "-";
//     *  every following token up to the first one that starts with "-".
//
//   D.2 vitest
//     DROP 0  --run --watch -w --no-watch --ui --open --standalone --update -u --passWithNoTests
//             --clearScreen --inspect --inspect-brk --coverage --no-coverage   (coverage adds the
//             note "coverage disabled for the scoped run")
//     DROP ?  --changed --api --mergeReports --coverage.*
//     DROP 1  --bail   (note "early-exit option dropped for a full failure inventory": a new
//             failure could hide behind an old one, QA-1.3-2)
//     DROP 1  --reporter --outputFile --outputFile.* --shard --minWorkers --min-workers --api.*
//     CAP  1  --maxWorkers --max-workers
//     CAP  0  --no-file-parallelism, "--fileParallelism=false": the token is KEPT and the user
//             cap is {count: 1}
//     KEEP 1  --config -c --root -r --dir --project --environment --pool --testNamePattern -t
//             --mode --testTimeout --hookTimeout --teardownTimeout --retry --exclude
//             --maxConcurrency --slowTestThreshold
//     KEEP ?  --browser --sequence.* --typecheck.* --browser.*
//     KEEP 0  --globals --dom --isolate --no-isolate --allowOnly --silent --hideSkippedTests
//             --logHeapUsage --color --no-color --expandSnapshotDiff --disableConsoleIntercept
//             --typecheck --printConsoleTrace --includeTaskLocation
//     Example: `vitest run --coverage` -> run dropped, --coverage dropped, note added.
//
//   D.3 jest
//     DROP 0  --watch --watchAll --json --findRelatedTests --listTests --onlyChanged -o --lastCommit
//             --changedFilesWithAncestor --updateSnapshot -u --passWithNoTests --runTestsByPath
//             --onlyFailures -f --coverage --collectCoverage --no-coverage   (coverage adds the
//             note from D.2)
//     DROP ?  --bail -b   (the early-exit note from D.2)
//     DROP 1  --outputFile --changedSince --shard --collectCoverageFrom --coverageDirectory
//             --coverageProvider --coverageThreshold
//     DROP *  --reporters --coverageReporters --coveragePathIgnorePatterns
//     CAP  1  --maxWorkers --max-workers -w
//     CAP  0  --runInBand -i   (the token is removed; the user cap is {count: 1})
//     KEEP 1  --config -c --rootDir --testNamePattern -t --testEnvironment --env --testTimeout
//             --testRunner --testSequencer --cacheDirectory --workerIdleMemoryLimit --seed
//             --maxConcurrency --openHandlesTimeout
//     KEEP *  --roots --selectProjects --ignoreProjects --projects --testPathPatterns
//             --testPathPattern --testPathIgnorePatterns --testMatch
//     KEEP 0  --ci --silent --verbose --detectOpenHandles --detectLeaks --forceExit --cache
//             --no-cache --colors --watchman --no-watchman --errorOnDeprecated --injectGlobals
//             --noStackTrace --useStderr --workerThreads --randomize --showSeed --clearMocks
//             --resetMocks --restoreMocks --expand -e --logHeapUsage
//     S6      --showConfig --clearCache --init
//
//   D.4 pytest
//     DROP 0  -q --quiet --lf --last-failed --ff --failed-first --nf --new-first --sw --stepwise
//             --sw-skip --stepwise-skip --cache-clear --pdb --trace -f --looponfail --cov-append
//             --cov-branch --no-cov --no-cov-on-fail --self-contained-html --json-report
//     DROP 0  -x --exitfirst; DROP 1 --maxfail   (the early-exit note from D.2). The argv also
//             ends the options with "--maxfail=0", which overrides an -x or --maxfail from
//             addopts or PYTEST_ADDOPTS (argparse: the last value of dest "maxfail" wins).
//     DROP ?  --cov
//     DROP 1  --junitxml --junit-xml --pdbcls --cov-report --cov-config --cov-fail-under
//             --cov-context --html --json-report-file
//     -p      "-p no:cacheprovider" (and "-pno:cacheprovider") is dropped, because the adapter
//             adds it once. "-p no:xdist" is kept and forces xdist = false. Any other -p value
//             is KEEP 1.
//     CAP  1  -n --numprocesses --maxprocesses   (values: N, auto, logical; attached "-n4")
//     KEEP 1  -k -m -c --config-file --rootdir -o --override-ini -W --pythonwarnings --tb -r
//             --import-mode --basetemp --durations --durations-min --timeout --ignore
//             --ignore-glob --deselect --confcutdir --dist --capture --log-level --log-cli-level
//     KEEP 0  -v -vv --verbose -s -l --showlocals --strict-markers --strict-config
//             --disable-warnings --no-header --runxfail
//     S6      --co --collect-only --fixtures --fixtures-per-test --markers --setup-plan
//             --setup-only --version -V -h --help --tx --rsyncdir   (--tx starts xdist workers
//             that no -n caps)
//     xdist evidence (QA-1.3-3). pytest reads options from three places, in this order, and the
//     last cap wins: the config file's addopts, PYTEST_ADDOPTS, the command. The adapter reads
//     all three the way pytest does:
//       - Config file (pytest 9 findpaths): the -c/--config-file file alone, when given on the
//         command line or in PYTEST_ADDOPTS (read by its extension, always accepted). Otherwise walk from the start directory up to the
//         FILESYSTEM ROOT (not gitRoot: pytest does not stop there) and, in each directory,
//         take the first of pytest.toml, .pytest.toml, pytest.ini, .pytest.ini, pyproject.toml,
//         tox.ini, setup.cfg that pytest accepts: pytest.toml/.pytest.toml ([pytest] table) and
//         pytest.ini/.pytest.ini ([pytest] section) always, even empty; pyproject.toml only
//         with a [tool.pytest.ini_options] or [tool.pytest] table; tox.ini only with [pytest];
//         setup.cfg only with [tool:pytest]. --rootdir does not change this search.
//         Older release lines (QA-1.3-21) are looked up too, because the adapter cannot tell
//         which pytest will run: pytest 8 (pytest.ini, .pytest.ini, pyproject.toml with
//         [tool.pytest.ini_options] only, tox.ini, setup.cfg) and pytest 7.0 (the same without
//         .pytest.ini). Each line picks its own first accepted file; the evidence is the union
//         (xdist and cov from any file, the LOWEST cap among the files, "-p no:xdist" only when
//         every line's file says so). A false xdist hit only costs exit 4 (unverifiable).
//         `-o addopts=<v>` / `--override-ini addopts=<v>` replaces the file's addopts.
//         The keys read are addopts and python_files (G.8, QA-1.3-33).
//         ini files follow iniconfig (column-0 [section], indented continuation lines, # and ;
//         comment lines). A key line splits on its first "=" unless the name before it contains
//         ":", otherwise on its first ":"; whitespace is optional (QA-1.3-31: "addopts:-n 3").
//         TOML is scanned line by line with every value skipped whole (strings, multi-line
//         strings, nested arrays and inline tables), so a header inside a string is not one.
//         Header and key parts are compared DECODED (QA-1.3-31: `"add\u006fpts"`,
//         `[tool."py\u0074est".ini_options]` are the plain names); a quoted part whose escapes
//         do not decode -> S6 `unsupported pytest argument "<raw key>" in <file>`. A key is read
//         only as a single key directly below a [table] header from the line's tables, as a
//         basic, literal or multi-line string, or an array of strings; a string is split with
//         C.1. Anything else (a bare value, a bad escape, an unterminated quote, a second
//         occurrence in any pytest table) -> S6 unsupported-argument `unsupported pytest
//         argument "<key>" in <file>`. So is any other TOML spelling that reaches the same key
//         (QA-1.3-20: a dotted key at the root or under [tool], an inline table such as
//         `ini_options = { addopts = ... }`, an array table), which pytest 9.1.1 honours: the
//         adapter would append no -n. (An appended "-n N" does win over each of those shapes,
//         verified with xdist 3.8.0, but it can only be appended when xdist is known to be
//         present; otherwise pytest exits 4.) A key the command line overrides with -o is not
//         S6 for its spelling in the file. An unreadable file is noted and skipped. A file over
//         CONFIG_SIZE_LIMIT (1 MiB) -> S6 config-too-large, even one pytest would skip after
//         reading it (QA-1.3-34). Each file is read once per planner call and parsed once per
//         reading (ctx.cache); with PlannerFs.stat the size is checked before the read.
//       - PYTEST_ADDOPTS: host.pytestAddopts and the cross-env value (C.3). Both are scanned for
//         xdist and cov evidence; the cap and "-p no:xdist" come from the value the spawn will
//         see (cross-env wins). QA-1.3-39: pytest prepends that value to the command line before
//         it picks its config, so its -c/--config-file chooses the config file, its
//         -o addopts=/python_files= override the file's keys, and its --rootdir turns off the
//         fallback below, exactly like the command's, which comes later and wins (the last -c,
//         -o and --rootdir count). A -c from PYTEST_ADDOPTS is a config trigger too.
//       - The command (D.1).
//     Each addopts source goes through D.1 with the pytest table in "addopts" mode: a positional
//     -> S6 unsupported-argument `... "<p>" in addopts of <file>` / `in PYTEST_ADDOPTS` /
//     `in -o addopts`, because pytest would collect it on top of the inputs (QA-1.3-13). An
//     unknown option followed by a non-option token takes it as its value, unless that token
//     names an existing path (S6). Either reading is safe: a missing path makes pytest exit 4.
//     xdist = (a CAP entry or --dist in any source) and no "-p no:xdist" in any source.
//     covInConfig = a --cov option in the config or PYTEST_ADDOPTS. userWorkers = the last cap
//     over config, PYTEST_ADDOPTS and the command, so a config "-n 1" is never raised.
//     The lookup follows determine_setup (QA-1.3-43), per release (PYTEST_SETUPS: pytest 9,
//     8.1-8.4, 8.0/7.x, 7.0; read in 7.0.0, 7.4.4, 8.0.0, 8.1.0 and 9.1.1). -c: that file, its
//     directory the rootdir. Otherwise locate_config from the common ancestor of the path
//     arguments (runnerCwd without any); pytest >= 8.1 also takes the first table-less
//     pyproject.toml seen as the inifile and rootdir. When that finds nothing and no --rootdir is
//     given: a setup.py at or above the ancestor is the rootdir; else, when the argument
//     directories are not just the ancestor, locate_config runs again from each argument in
//     order (QA-1.3-40), stopping below the ancestor (QA-1.3-47); else the rootdir is the common
//     ancestor of runnerCwd and the ancestor. Detection runs it with no arguments (det.xdist and
//     friends) and with the path arguments (python_files). With tests/a/pytest.ini as the only
//     config, `pytest tests/a tests/b` reads it and a plain `pytest` does not.
//     QA-1.3-48: pytest picks its config before it loads plugins, so the path arguments of the
//     lookup are its free arguments then: the positional paths plus the separate values of the
//     plugin options in the table (PY_PLUGIN_VALUE_OPTIONS: --cov, --cov-config, --html, -n,
//     --timeout, --dist, ...) that exist, "::" stripped, PYTEST_ADDOPTS first (9.1.1:
//     parse_known_intermixed_args; 7.0-8.4: file_or_dir + unknown args). `pytest --cov src
//     tests/unit` looks from the common ancestor of src and tests/unit; `--cov=src` is one option
//     token and does not count.
//     Spec pinning (QA-1.3-43). The spec passes its inputs as file arguments, so pytest alone
//     would look from the inputs' common ancestor, where a nearer pytest.ini or a package's
//     pyproject.toml wins over the user's config and its addopts (-m, -k, --deselect) and
//     collection keys apply to the spawn only. At spec time the lookup is redone for the
//     user's run (runnerCwd and the path arguments; a rerun moves both into its tree), the
//     evidence comes from the configs it reads, and the spec adds, after "--maxfail=0":
//       - nothing, when -c/--config-file comes from the command or PYTEST_ADDOPTS (the spawn
//         sees it too, and every release takes the file's directory as the rootdir);
//       - "--rootdir=<the user's rootdir>" unless the run gives a non-empty --rootdir. The
//         releases must agree on it, else S6. pytest then skips the setup.py rule and the
//         fallback, so the spawn's own lookup is locate_config from the inputs' ancestor only;
//       - "-c <file>" when every release reads the same accepted config. The rootdir, the ini
//         values and the conftest cutoff (the inifile's directory, else the rootdir) then match
//         the user's run on every release. Otherwise (the releases read different files, a
//         table-less pyproject.toml, or none) nothing is pinned, and the spawn's lookup from the
//         inputs' ancestor must give every release the same inifile as the user's run (none
//         included). That covers pytest.toml, which only pytest 9 reads. The spawn's free
//         arguments include the existing values of the plugin options it keeps and of
//         PYTEST_ADDOPTS (QA-1.3-48).
//     QA-1.3-49, where the pins above fail (the releases pick different rootdirs, a rootdir with
//     "$"/"%", or a different inifile from the inputs' ancestor): no pin at all when the spawn's
//     own determine_setup (its free arguments, nothing pinned) gives every release the user's
//     inifile and rootdir (`pytest packages/a` with a table-less packages/a/pyproject.toml);
//     else "-c <pyproject.toml>" plus the --rootdir when the user's pytest >= 8.1 takes that
//     table-less file as its inifile, the older releases read none, and no conftest.py lies
//     above the rootdir (pytest < 8.1 cuts no conftests without an inifile, and cuts at the -c
//     file's directory); else S6 unsupported-argument.
//     pytest expands variables in --rootdir, so a rootdir with "$" (or "%" on win32) is S6.
//     A false xdist match can only add "-n N" without xdist: pytest exit 4, readResult
//     complete=false, unverifiable, never a false pass. Residual (P): a conftest.py or plugin
//     that adds -n through a hook.
//
//   D.5 eslint (lint scoping, K)
//     DROP 0  --fix --fix-dry-run
//     DROP 1  --fix-type -o --output-file
//     CAP  1  --concurrency   (N or auto; "off" is KEEP, not a cap)
//     KEEP 1  -c --config --ext --parser --parser-options --resolve-plugins-relative-to --rulesdir
//             --plugin --rule --env --global --ignore-path --ignore-pattern --cache-location
//             --cache-strategy -f --format --max-warnings --report-unused-disable-directives-severity
//             --flag
//     KEEP 0  --cache --quiet --no-eslintrc --no-config-lookup --no-ignore --no-inline-config
//             --report-unused-disable-directives --color --no-color --no-error-on-unmatched-pattern
//             --exit-on-fatal-error --pass-on-no-patterns --stats --debug
//             (--no-warn-ignored is deduplicated: dropped here, re-added by K)
//     UNSCOPED --init --print-config --inspect-config --env-info -v --version -h --help --stdin
//              --stdin-filename
//
// ------------------------------------------------------------------------------------------------
// E. WORKER CAP (section 1.5-11; S4)
//
//   B = budget.maxWorkers if it is a safe integer >= 1, else 1.
//   C = input.cores ?? host.cores (default os.availableParallelism()), a safe integer >= 1, else 1.
//   The user value V comes from the LAST cap token (the runners use last-wins too). For pytest,
//   when the command has no cap token, V comes from the config (D.4).
//     /^\d+$/                            -> {count: n}. n = 0 is valid only for pytest -n;
//                                           for vitest/jest, 0 is invalid.
//     /^(\d{1,3})%$/, p in 1..100        -> {percent: p}   (vitest, jest)
//     "auto" | "logical"                 -> {auto: true}   (pytest; eslint "auto")
//     anything else (abc, 1.5, -1, 0%, 150%)
//                                        -> invalid. The value is ignored and a note
//                                           `invalid worker cap "<V>" ignored` is added.
//                                           Spike C: vitest and jest accept --maxWorkers=abc
//                                           silently and run with their own default, so the
//                                           budget applies instead.
//   effectiveWorkers(user, budget, C):
//     none or invalid -> B
//     count n         -> min(n, B)   (pytest 0 -> 0: runs in-process, never raised)
//     percent p       -> min(max(1, ceil(p * C / 100)), B)
//     auto            -> min(C, B)
//   Test values, with B = 2:
//     none -> 2; 1 -> 1; 8 -> 2; 50% with C=16 -> 2; 50% with C=1 -> 1;
//     "--maxWorkers 4" (two tokens) -> 2; "--maxWorkers=abc" -> 2 plus the note.
//   Every user cap token is removed in D, and the adapter emits exactly one flag (H). The router
//   never raises a cap.
//
// ------------------------------------------------------------------------------------------------
// F. ENTRY RESOLUTION (resolveEntry)
//
//   JS tools: vitest -> package "vitest", bin key "vitest"; jest -> "jest"/"jest";
//   eslint -> "eslint"/"eslint".
//     - For dir = cwd, its parent, ... up to gitRoot (inclusive, never above), check
//       pj = P.join(dir, "node_modules", pkg, "package.json") with fs.fileExists; the first hit
//       wins. This covers hoisted monorepos (found at the root) and pnpm, where
//       node_modules/<pkg> is a symlink into .pnpm/... that fileExists and readFile follow. The
//       lexical path goes into argv.
//     - Nothing found -> S6 runner-not-installed "<pkg>", or yarn-pnp when <gitRoot>/.pnp.cjs
//       exists.
//     - Unparseable package.json, or its "name" is not <pkg> -> S6 bad-bin.
//     - bin is either a string (Spike C: jest "./bin/jest.js") or an object keyed by the bin name
//       (vitest {"vitest": "./vitest.mjs"}). Missing -> bad-bin.
//     - entry = P.resolve(pkgDir, bin). It must stay inside pkgDir (P.relative(pkgDir, entry) has
//       no ".." segment and is not absolute), end in .js, .mjs or .cjs, and exist. Otherwise
//       -> bad-bin.
//     - Result: {file: node (F.1), prefix: [entry], entry, version}.
//     - npx and pnpm exec resolve exactly like direct invocations. They are never executed, so
//       npx can never download a runner.
//   F.1 node (QA-1.3-18). The plugin runtime is Bun, and a compiled opencode reports itself as
//     process.execPath; jest 30 fails every suite under bun.exe ("Attempted to assign to readonly
//     property"). So the JS tools never inherit the runtime blindly:
//       1. host.nodePath when given (absolute, and on win32 with a drive or UNC host; otherwise
//          S6 node-not-found "node path is not absolute: <p>"; with PlannerFs.stat, not an
//          existing file -> "node path is not a file: <p>").
//       2. host.execPath when its basename is node or node.exe. The DEFAULT execPath
//          (process.execPath) also needs process.versions.bun to be undefined. With
//          PlannerFs.stat it must be an existing file, else step 3.
//       3. The first node on a usable host.pathEnv entry: posix "<dir>/node"; win32
//          "<dir>\node<ext>" for each PATHEXT ext in order (the shell's rule). A usable entry is
//          absolute and, on win32, starts with a drive ("C:\") or a UNC host: a root-relative
//          "\Users\..." resolves against whichever drive is current (QA-1.3-36). A hit that stat
//          reports as a directory is skipped (QA-1.3-36). A win32 hit that is not .exe (node.cmd,
//          node.bat) needs a shell -> S6 node-not-found "node on PATH is not an executable file:
//          <f>". Bun's temporary node is skipped three ways (QA-1.3-18, QA-1.3-30): its
//          directory is named bun-node-<hex> (%TEMP%\bun-node-0d9b296af); its realpath is bun or
//          bun.exe (posix symlink); or stat gives it the dev and ino of host.execPath, the
//          non-node runtime (the win32 hard link, nlink=4). fileExists, realpath and stat only.
//       4. Nothing -> S6 node-not-found "node not found: no absolute PATH entry has a node
//          executable".
//     Only JS tools resolve node, after their package entry (a missing package is reported
//     first). pytest and uv are native executables.
//   pytest (launcher "direct"): the first PATH hit, then a venv.
//     - PATH: for each usable entry of host.pathEnv split by P.delimiter (F.1 step 3: relative
//       entries such as "." and win32 root-relative ones are skipped), check win32
//       "<dir>\pytest.exe" or posix "<dir>/pytest"; a hit stat reports as a directory is skipped.
//     - venv fallback: for dir = runnerCwd ... gitRoot, check win32 ".venv\Scripts\pytest.exe" or
//       posix ".venv/bin/pytest", and add the note `pytest resolved from <path>`.
//     - Nothing found -> S6 runner-not-installed "pytest".
//     - Result: {file: exe, prefix: [], entry: exe}.
//     PATH comes first so the adapter runs the program the shell would have run for the same
//     command.
//   uv (launcher "uv-run"): PATH only, "uv.exe" or "uv". Result: {file: uv, prefix: ["run",
//     "pytest"], entry: uv}. Nothing found -> runner-not-installed "uv".
//
// ------------------------------------------------------------------------------------------------
// G. CHANGED FILES (planScopedRun, planStaticScoping, planScopedLint)
//
//   1. changedFiles === "unavailable" -> S6 attribution-unavailable (lint: Unscoped).
//      [] -> NoAffected "no changed files, no affected tests" (section 1.5-6).
//   2. The candidates are each c.path, plus c.previousPath when present (the source of a rename).
//   3. abs = P.resolve(cwd, candidate). This resolves "..", "." and mixed separators, and an
//      absolute input keeps its drive. A path containing "\0" is dropped, with a note.
//   3a. Canonical spelling (QA-1.3-1, QA-1.3-7). win32 first strips the \\?\, \\.\ and \\?\UNC\
//      prefixes. Then abs goes through realOf: fs.realpath (PlannerFs), which resolves symlinks,
//      junctions and 8.3 short names. A missing file keeps its lexical tail below the realpath of
//      its nearest existing ancestor. cwd (hence gitRoot, the package.json and runnerCwd), path
//      scopes, rerun test files and the tmpdir are canonicalized the same way, so every path in a
//      spec is a real path. Reason: jest realpaths rootDir and then matched none of the lexical
//      --findRelatedTests paths (0 tests, exit 0 under --passWithNoTests) for an 8.3 or junction
//      cwd. Without fs.realpath the paths stay lexical and the spec carries lexicalPaths (I 2a).
//      The trigger check (7) also looks at the lexical basename, so a symlink named
//      vitest.config.ts still triggers.
//   4. rel = P.relative(gitRoot, abs). The file is outside the root when rel === "", rel starts
//      with a ".." segment, or P.isAbsolute(rel) (another drive). Outside files are dropped with
//      the note `dropped outside the git root: <candidate>`.
//   4a. A non-empty change set in which EVERY candidate was dropped (outside, NUL) -> S6
//      attribution-unavailable (lint: Unscoped), never NoAffected (QA-1.3-7).
//        "src/../../x" is outside -> dropped.
//        "packages/a/../b/x.ts" is inside -> kept as packages/b/x.ts (see O.9).
//        win32 P.relative compares case-insensitively, so "c:\repo\a.ts" is inside a gitRoot of
//        "C:\repo".
//   4b. Cross-link inputs (cross-repo P3a, planScopedRun and planStaticScoping only; lint ignores
//      them). With input.crossLinkRoot (W's git top, SD-P3a-5), a candidate outside gitRoot but
//      inside realOf(crossLinkRoot) is kept as an external file (FileRef.external) instead of being
//      dropped; outside both it is dropped as in 4. For external files: any one that is not a
//      non-input (8) needs vitest -> S6 cross-link-unsupported otherwise (jest, pytest); a W
//      package.json, lockfile, tsconfig*.json or vitest/vite config -> S6 config-changed; a W test
//      file (JS_TEST_RE, __tests__) is dropped with a note; a gone one (deleted, rename source) ->
//      S6 cross-link-gone; the resolved vitest's major must be CROSS_LINK_VITEST_MAJOR (checked
//      after the entry, F) -> S6 cross-link-unsupported. G.7a reads only the in-repo files' dirs,
//      never W. Each existing one is an input in every spelling of SD-P3a-2: its real path, then
//      crossLinkRoot + rel and each crossLinkAliases entry + rel, deduplicated by exact string
//      (vitest matches related ids exactly, so case-only variants are kept), never a spelling with
//      a node_modules segment (vitest skips those ids). The spec then has crossLink: true.
//      Without crossLinkRoot nothing here applies.
//   5. canonical = P.join(gitRoot, rel), so drive-letter case and separators follow gitRoot.
//      Deduplicate by key and sort by key. Spaces and unicode need nothing special: each path is
//      one argv element.
//   6. exists = fs.fileExists(canonical). A path that does not exist is "gone": deleted, or the
//      source side of a rename. Git status strings are NOT trusted, because tool statuses are
//      "written"/"modified" and porcelain codes differ. tree.ts records only rename
//      destinations, so 2.1 should pass previousPath.
//   7. Config triggers are checked on every canonical path, gone or not. The first hit in sorted
//      order -> S6 config-changed. Matching is by basename (real or lexical, 3a), anywhere
//      under gitRoot:
//        vitest  package.json, vitest.config.*, vite.config.*, vitest.workspace.*,
//                vitest.projects.*, tsconfig*.json.
//                Evidence (R): `vitest related package.json` ran every test file.
//        jest    package.json, jest.config.*, babel.config.*, .babelrc, .babelrc.*, tsconfig*.json
//        vitest and jest, also (QA-1.3-8): package-lock.json, npm-shrinkwrap.json,
//                pnpm-lock.yaml, yarn.lock, bun.lock, bun.lockb, pnpm-workspace.yaml, .npmrc,
//                .yarnrc, .yarnrc.yml, .pnpmfile.cjs (a lockfile-only change can upgrade a
//                dependency within its range); and setup files that are not test files
//                (QA-1.3-15: vitest adds setupFiles to forceRerunTriggers and reran every test
//                file; QA-1.3-29: jest's related graph never reaches a setup file, so
//                `--findRelatedTests <setup>` ran 0 tests with exit 0). By name, a SUPERSET of
//                the rule 1.6 risk.ts uses, case-insensitive, JS/TS extensions: *.setup.<ext>;
//                the risk.ts basenames (setupTests, setup-tests, test-setup, global-setup,
//                globalSetup, vitest.setup, jest.setup, setup-jest, jest-setup, vitest-setup,
//                global-teardown); (jest|vitest|test|tests)[._-]?(setup|teardown)<anything>
//                (jest.setupAfterEnv.js, testSetup.ts); setup[._-]?(tests|jest|vitest|env|
//                after-env|files|files-after-env) (setupVitest.ts, setupFilesAfterEnv.ts);
//                global[._-]?(setup|teardown)<anything>; and a bare setup.<ext> or teardown.<ext>
//                below a test, tests, spec, specs, testing, jest, vitest or __tests__ directory
//                (test/setup.js). src/setup.ts and SetupWizard.tsx stay application code. And
//                (G.7a) any file a vitest/jest config names statically.
//   7a. (QA-1.3-29) vitest.config.*/vite.config.* (vitest) or jest.config.*/package.json (jest)
//      in every directory from runnerCwd up to gitRoot, plus the --config file, are read once
//      (CONFIG_SIZE_LIMIT; over it -> S6 config-too-large). QA-1.3-44: so are those in every
//      directory from each changed JS/TS module that is not a test file (existing or gone) up to
//      gitRoot, because a project's own config (jest/vitest `projects`) sits in the project's
//      directory, at or above its setup files; those directories are bases for their configs.
//      Before those reads, the S6s a large change reaches without them come first: more than
//      SEARCH_LIMIT gone modules (too-many-searches), and existing inputs whose quoted paths
//      alone exceed MAX_ARGV_CHARS (argv-too-long); the reads are then bounded by one command
//      line. QA-1.3-51: with PlannerFs.readdir each of those directories is listed once per
//      plan (all listings started together) instead of checking each config name with
//      fileExists; a name listed only in another case is confirmed with fileExists, and a
//      directory that cannot be listed falls back to it. The string literals of setupFiles,
//      setupFilesAfterEnv, globalSetup and globalTeardown resolve against the config's
//      directory and runnerCwd (vitest, plus every literal `root`, against both: QA-1.3-44's
//      inline projects) or rootDir (jest: `<rootDir>`
//      is the config's directory, every literal rootDir, and QA-1.3-45 the command line's
//      --rootDir, which jest-config's setFromArgv puts over the config's); a reference without
//      an extension also matches <ref>.<ext> and <ref>/index.<ext>. QA-1.3-45: a key's value is
//      the whole expression up to the next "," or ";" at depth 0 or the bracket that closes the
//      object, and every string literal in it counts: 'x', [...defaults, 'x'],
//      require.resolve('x'), path.resolve(__dirname, 'x'), c ? 'x' : 'y'. QA-1.3-50: in a
//      call, each run of lone literal arguments is also joined with "/": after the call's start
//      or __dirname, import.meta.dirname or process.cwd() it resolves like a literal
//      (path.join(__dirname, 'src', 'testing', 'boot.js') is src/testing/boot.js); after any
//      other argument (path.join(ROOT, 'testing', 'boot.js'), path.join(__dirname, 'src', dir,
//      'boot.js')) it is a path tail, taken after its last "..", and every file whose path ends
//      with it counts. Each such file is a trigger. A value with no literal names nothing; the
//      name rule above still applies (P).
//      QA-1.3-41: jest's inline JSON `--config '{...}'` (a
//      value that starts with "{" and ends with "}", jest's own test) is the config itself: it
//      is parsed with JSON.parse (S6 unsupported-argument when it does not parse), rooted at
//      runnerCwd, and is not a config file path. JSON configs (jest.config.json, package.json)
//      are also read with JSON.parse, so escaped keys and paths count; QA-1.3-46: after
//      strip-json-comments' rules, as jest-config reads them (`//` and `/* */` outside strings
//      become whitespace). A .json config that still does not parse fails the user's run -> S6
//      unsupported-argument; an unparseable package.json is skipped, as jest's lookup skips it
//      (its text scan still counts). QA-1.3-42: a reference is
//      resolved only when its last segment names a changed file (basename, stem, or the
//      directory of an index file), each distinct one once, and at most SETUP_REF_LIMIT (1000)
//      resolutions (references times bases, plus rootDir literals) per plan; beyond that, S6
//      config-too-large "too many setup references in <path> (limit 1000)".
//        pytest  conftest.py, pyproject.toml, pytest.ini, setup.cfg, tox.ini (section 1.5-3),
//                plus .pytest.ini, pytest.toml, .pytest.toml (QA-1.3-4: pytest 9 reads them;
//                plan amendment to section 1.5-3, fixtures in 3.2) and uv.lock, poetry.lock,
//                pdm.lock, Pipfile.lock, requirements*.txt (QA-1.3-8), plus (QA-1.3-23) Pipfile,
//                setup.py, requirements*.in, constraints*.txt, and any *.txt or *.in below a
//                directory named "requirements" (requirements/base.txt)
//        all     the package.json that supplied the script (DetectedRunner.source), and every
//                file named by a config option (DetectedRunner.configFiles: vitest/jest
//                --config -c, pytest -c --config-file, eslint -c --config), resolved against
//                runnerCwd and canonicalized (QA-1.3-5)
//        eslint  (K)
//   8. Classification:
//        test file (JS): /\.(test|spec)\.[cm]?[jt]sx?$/ or a "__tests__" segment.
//        test file (py): a .py file matching pytest's python_files (QA-1.3-33; plan amendment to
//                section 1.5-3, which names only test_<stem>.py/<stem>_test.py). The patterns
//                are DetectedRunner.pythonFiles: the union over the configs each pytest release
//                line picks from runnerCwd, and, with path arguments, from their common ancestor
//                (a line whose config sets none, or that finds no config, adds the default
//                "test_*.py *_test.py"), plus every `-o python_files=` in the command, addopts or
//                PYTEST_ADDOPTS. Matching follows pytest's fnmatch_ex: a pattern without a
//                separator matches the basename, one with a separator the whole path (relative
//                patterns get "*" plus a separator in front); win32 folds case. pytest-django's
//                `python_files = tests.py test_*.py *_tests.py` makes pkg/tests.py a test file.
//                A union only ever classifies more files as tests, and an explicit test file is
//                always collected by pytest.
//        non-input (skipped, counted in a note):
//          - extensions .md .mdx .markdown .rst .adoc .txt;
//          - any path with a ".github" segment;
//          - basenames LICENSE, LICENCE, .gitignore, .gitattributes, .editorconfig, .npmignore,
//            .prettierignore. (Lockfiles are triggers now, 7.)
//        vitest/jest:
//          - an existing file becomes an input. A changed test file runs itself (evidence R).
//          - 8a (QA-1.3-37, QA-1.3-38) a test file the runner's own config excludes (a Playwright
//            spec under vitest's `test.exclude` or jest's testPathIgnorePatterns, say) is still
//            an input. The planner does not model runner exclusions: round 3's static reading
//            (an `exclude` literal plus a Playwright testDir) dropped real vitest tests through
//            coverage.exclude and typecheck.exclude, and a sound model needs vitest's
//            test.exclude/root/dir/mergeConfig and Playwright's projects/testMatch/testIgnore.
//            An e2e-only change therefore runs 0 tests, and the I 2a guard makes that run
//            unverifiable (fail-closed; see P and Q 2.1). With a source file in the same change
//            the source's related tests run, and the excluded spec adds nothing, as in the
//            user's own run.
//          - a gone test file adds the note `deleted test file not run: <rel>`; the risk signal
//            covers it.
//          - any other gone file goes to the stem search (9).
//        pytest: only .py files count; others are skipped.
//          - an existing test file becomes an input, if it lies under runnerCwd and under a path
//            scope (when path scopes exist).
//          - an existing module (E2E-1) maps to the union of:
//            (i) its importers: search.findByContent(gitRoot, name, [...pytest globs (9),
//                ":(glob)**/conftest.py"], {word: true}), where name is the module's Python name
//                (the basename without ".py"; for __init__.py the package directory name). A
//                longer name (mod020) does not match. QA-G-10: every whole-word hit is kept (any
//                import layout: a name anywhere in a wrapped, isort-grid, backslash-continued or
//                CRLF list, importlib strings, attribute chains). One exception, the QA-G-2
//                over-match: for a module named like the regular package that holds it
//                (app/app.py beside app/__init__.py), keepImporters reads each hit through the fs
//                seam and drops it only when every whole-word occurrence of name heads a longer
//                module path in a one-line import statement (`from app.mod01 import x`,
//                `import app.mod01`), where name is the package. An unreadable file, one over
//                CONFIG_SIZE_LIMIT, or one the read finds no occurrence in is kept. Other modules
//                read nothing: a module can serve its own dotted names (six.py's
//                `from six.moves import x`). QA-G-2's import-shaped git grep -E missed wrapped
//                imports (a false pass). A package's __init__.py keeps every hit: importing any
//                submodule runs it. Then conftest hits -> S6 (below); hits re-checked against
//                python_files; more than STEM_MATCH_LIMIT -> S6 stem-too-common.
//            (ii) the tests named after it: search.findByName(gitRoot, names), where each
//                basename pattern with exactly one "*" and no other wildcard gives a name
//                ("test_*.py" -> test_<stem>.py; by default ["test_<stem>.py", "<stem>_test.py"]).
//                A literal pattern (tests.py) or a path pattern gives none; with no names at all
//                there is no name search.
//            Both keep only in-scope hits (G.8b). It fails closed, never NoAffected: either search
//            undefined -> S6 search-failed; a conftest.py anywhere in gitRoot that names the stem
//            -> S6 unmapped-module (its fixtures reach tests that never name the module); no
//            in-scope test at all -> S6 unmapped-module. One unmapped module makes the whole
//            change S6. Before E2E-1 an existing module was looked up by name only and "no hits"
//            was a note, so tests/test_mod02_1.py (`from app.mod02 import ...`) was never found
//            and a broken app/mod02.py passed as NoAffected.
//            Residual (not mapped, documented): a test that reaches the module only through
//            another source module (app/mod02.py imports app/mod01.py, test_mod02_1 uses it) or
//            through a dynamic import. The direct importers run; the indirect ones do not.
//          - G.8b (E2E-1) "in scope" for a pytest test input: under runnerCwd and under a path
//            scope; with no path scopes, under DetectedRunner.collectScopes when testpaths decide
//            the user's collection (Config._decide_args: no path argument, pytest started in its
//            rootdir). They apply only when every release line's config sets testpaths, its
//            rootdir is runnerCwd, no source gives -o testpaths=, --pyargs or --rootdir, and every
//            entry is a plain path; the scopes are the entries that exist (none -> runnerCwd, as
//            pytest does). An unreadable testpaths value is dropped, never S6. Anything else
//            keeps every test under runnerCwd: an extra input can only add a failure, never hide
//            one. Without this, extra/test_preexisting.py (outside testpaths = ["tests"], never
//            collected by `uv run pytest`) became an input of every app/mod01.py change.
//          - a gone test file adds a note. A gone module uses the stem search plus findByName,
//            and gets S6 when both find nothing. QA-G-17: its content search uses the module's
//            Python name, as for an existing module (a deleted app/index.py searches "index",
//            not "app"); findByName keeps the stem. The deleted-file rules below fail closed.
//            QA-G-19: the content search covers ":(glob)**/conftest.py" too; a conftest hit that
//            exists -> S6 unmapped-module (unscoped, as for an existing module).
//            QA-G-20: a gone test file is a module other tests may import (`from test_base import
//            Base`): search.findByContent(gitRoot, <basename without .py>, [...pytest globs,
//            conftest glob], {word: true}); in-scope test hits join the inputs, a conftest hit
//            -> S6 unmapped-module, more than STEM_MATCH_LIMIT -> S6 stem-too-common, no hit ->
//            the note only.
//            QA-G-21..23: a gone __init__.py (deleted, or the source of a rename; compared with
//            ctx.key), anywhere in the change set -> S6 unmapped-module "package structure
//            changed: <rel> deleted; pytest import paths may shift", decided while classifying,
//            before any search, so planStaticScoping returns it too. It is checked before
//            python_files, so a python_files pattern that matches __init__.py changes nothing.
//            Removing it changes how pytest's rootdir-based import (prepend mode by default)
//            names and imports every module under the directory: a relative `from . import
//            helper` fails (QA-G-21), each test module becomes top-level and can collide with a
//            namesake ("import file mismatch"), and the directory goes to the front of sys.path,
//            where its modules shadow same-named ones that tests anywhere import (QA-G-22). No
//            static mapping of those effects was trustworthy: 68edf52's per-directory listing
//            missed the shadowed importers (QA-G-22) and a directory whose case drifted from the
//            index (QA-G-23).
//            QA-G-18: a gone module whose package's __init__.py still exists and names it as a
//            whole word (unreadable or over CONFIG_SIZE_LIMIT counts as naming it) adds the
//            importers of the package name: the QA-G-20 search with that name.
//        stem = the basename without its last extension. "index" and "__init__" use the parent
//        directory name instead.
//   9. Stem search (section 1.5-5): search.findByContent(gitRoot, stem, globs), with JS_TEST_GLOBS
//      or the pytest globs: ":(glob)**/<pattern>" per python_files basename pattern
//      (PY_TEST_GLOBS for the default), ":(glob)**/*.py" for a path pattern. pytest hits are
//      re-checked against python_files before they are counted.
//        undefined               -> S6 search-failed.
//        []                      -> S6 deleted-no-tests.
//        more than STEM_MATCH_LIMIT files -> S6 stem-too-common.
//        otherwise               -> the existing, inside-root results join the inputs.
//   9a. (QA-1.3-26) The searches run one process each, in sequence (a pytest module, gone or
//      existing, runs a content search and a name search, and a gone one up to one more, but
//      counts once; a gone pytest test file counts once). More than SEARCH_LIMIT (50)
//      pending searches (the count below) -> S6 too-many-searches, decided before the first
//      search. 5000 changed pytest modules made 5000 git calls (about 26 minutes at 0.3 s each).
//      Batching (one git grep with several -e, one ls-files) would need a TestSearchSeam change;
//      the cap is the simpler bound, and planStaticScoping applies it identically.
//   10. Inputs empty after steps 8 and 9 -> NoAffected, with the note from M.2. Every pytest
//      module has added an input or returned S6 by then (E2E-1), so this only happens when no
//      changed file is a module or an in-scope test input.
//   planStaticScoping stops before every search. A gone pytest __init__.py is S6 there too
//   (QA-G-22). Each gone non-test source, each pytest module (existing or gone), and each gone
//   pytest test file (QA-G-20) counts as a pending search. It applies 9a, and (QA-1.3-27) runs the spec-time
//   pytest config lookup (D.4) over the test inputs it already knows, so an addopts S6 there is
//   seen by 1.6 too. When nothing is decidable, the result is {scopable: true, runner,
//   pendingSearches}.
//
// ------------------------------------------------------------------------------------------------
// H. ARGV CONSTRUCTION
//   Notation: F = the sorted absolute inputs, K = runner.keptArgs, N = the effective workers,
//   R = reportPath, E = entry.prefix.
//
//   vitest scoped (mode "related"): file = node (F.1)
//     [...E, "related", ...F, ...K, "--run", "--passWithNoTests", `--maxWorkers=${N}`,
//      "--coverage.enabled=false", "--reporter=json", `--outputFile=${R}`]
//     NEVER add "--" here: cac takes the tokens after "--" out of related's file list, and that
//     ran 0 tests with exit 0 (R).
//   vitest rerun:
//     [...E, "run", ...F, ...K, "--passWithNoTests", `--maxWorkers=${N}`, "--coverage.enabled=false",
//      "--reporter=json", `--outputFile=${R}`]
//     Filters match as substrings. An absolute path selects that file, and at most a longer name
//     with the same prefix (see P).
//   jest scoped: file = node (F.1)
//     [...E, ...K, "--findRelatedTests", "--passWithNoTests", `--maxWorkers=${N}`, "--coverage=false",
//      "--json", `--outputFile=${R}`, "--", ...F]
//   jest rerun: the same, with "--runTestsByPath" in place of "--findRelatedTests".
//   pytest (scoped and rerun are the same; F are test files). E is [] for direct pytest and
//   ["run", "pytest"] for uv:
//     [...E, ...K, "-q", "-p", "no:cacheprovider", `--junitxml=${R}`, "--maxfail=0", ...PIN,
//      ...(xdist ? ["-n", String(N)] : []), ...(covInConfig ? ["--no-cov"] : []), "--", ...F]
//     PIN is D.4's spec pinning: ["-c", <config>]? then [`--rootdir=${rootdir}`]?, each only
//     when the run does not give it already (QA-1.3-43).
//     env.PYTEST_XDIST_AUTO_NUM_WORKERS = String(N >= 1 ? N : min(C, B)). It is always set:
//     harmless without xdist, and it caps `-n auto|logical` from sources the adapter cannot see.
//     Spike C: it does not override a numeric -n, so the appended "-n N" does that job, because
//     the last -n wins over addopts.
//     workers = xdist ? N : null.
//   env = the cross-env assignments, then the adapter's own entries. The ArgvSeam merges env
//   over process.env.
//   reportPath = P.join(P.resolve(host.tmpdir), `omr-verify-${host.randomId()}.json`); pytest
//   uses ".xml". A relative host.tmpdir -> S6 tmpdir-in-repo "temp dir is not an absolute path"
//   (the runner would resolve it against spec.cwd, inside the repo: QA-1.3-11). The tmpdir inside
//   gitRoot, lexically or after realpath -> S6 tmpdir-in-repo.
//   The command line must not exceed MAX_ARGV_CHARS; otherwise -> S6 argv-too-long. It is
//   counted as CreateProcess receives it (QA-1.3-14): file plus args, one separator each, and on
//   win32 each argument quoted the way libuv quotes it (+2 for a space, tab or quote, 2n+1
//   backslashes before a quote, doubled trailing backslashes, "" for an empty argument).
//   QA-1.3-47: for pytest the argv without PIN, "-n N" and "--no-cov" (a lower bound) is checked
//   first, before the spec-time config lookup, in planScopedRun, planStaticScoping (over the
//   test inputs it knows) and planRerun.
//
// ------------------------------------------------------------------------------------------------
// I. RESULTS AND IDENTITIES (readResult; plan 1.3.2.f)
//
//   In a finally block, always call fs.unlink(spec.reportPath) when it passes the N.4 check.
//   Errors are ignored.
//   Step 1  Read the report. If it is missing, unreadable or unparseable (for example
//           truncated), go to step 4.
//   Step 2  vitest/jest JSON (the top level is jest-compatible). Require an object whose
//           testResults is an array.
//     total = numTotalTests, when it is a number.
//     For each suite s:
//       rel    = P.relative(spec.cwd, s.name) with "/" separators. s.name is absolute, with
//                forward slashes in vitest and backslashes in jest. QA-1.3-35: computed by
//                prefix when s.name lies plainly below spec.cwd (same result; Bun's
//                path.win32.relative is about 13 times slower than node's), else P.relative.
//       failed = the assertionResults with status "failed".
//       For each a in failed: id = `${rel} > ${[...a.ancestorTitles, a.title].join(" > ")}`.
//         This is the same form vitest prints in text ("FAIL test/str.test.js > str > bad").
//         fullName is NOT used: it is space-joined and ambiguous.
//       If s.status === "failed" and failed is empty, the whole file failed: an import-time
//         throw, jest's "Test suite failed to run", or a jest syntax error. Then id = rel (a bare
//         file id) and collectionError = true.
//       Any failure adds P.normalize(s.name) to failingFiles.
//     jest: numRuntimeErrorTestSuites > 0 -> collectionError = true.
//     complete = true. Exception: exit != 0 with no failing id and no collection error ->
//     complete = false, note `runner exited <code> but its report lists no failure` (vitest
//     unhandled errors, coverage thresholds).
//   Step 2a (QA-1.3-1, QA-1.3-19) Zero-test guard, for JSON and junit and for EVERY runner. A
//     complete report with total 0, no failing id and no collection error, from a spec with
//     non-empty inputs, becomes complete = false when
//       - mode is "rerun" (every input is an existing test file), note `rerun ran no tests
//         although every input is a test file`;
//       - the inputs are test files (inputsAreTests: pytest), or related was given a JS test file
//         (G.8 rule; a test file passed to related runs itself), note `<runner> ran no tests
//         although a test file was passed`;
//       - the spec has lexicalPaths, note `<runner> ran no tests and the paths were not
//         canonicalized (no realpath seam)`. QA-1.3-19: vitest through a junction cwd without
//         realpath also ran 0 tests with exit 0, exactly like jest.
//     A legitimately empty selection (a -k/-m/-t filter that deselects every test of a changed
//     test file, or a test file with no tests) is therefore unverifiable, never a pass.
//     realpath stays OPTIONAL in PlannerFs: making it required would break every planner caller
//     that passes a plain FsSeam (1.6 static scoping included), and the lexical run is already
//     fail-closed by this guard. 2.1 must still pass the native realpath (Q).
//     A parser exception is an unusable report: step 4 with the note `report could not be
//     parsed: <message>` (QA-1.3-12). readResult never rejects.
//   Step 3  pytest junit XML, parsed without an XML library, in linear time (QA-1.3-25).
//     - Read each <testcase .../> and <testcase ...>...</testcase> with a forward indexOf scan,
//       with its classname and name attributes. A testcase with no </testcase>, or one that
//       contains another <testcase, makes the report unusable (step 4). Decode &amp; &lt; &gt;
//       &quot; &apos; &#N; and &#xN;. A numeric reference outside 0..0xD7FF and 0xE000..0x10FFFF
//       stays literal text (QA-1.3-12).
//     - A <failure> child marks a failing test.
//     - Only an <error message="collection failure"> child marks a collection error
//       (QA-1.3-22). classname="" alone does not: pytest writes it for a real test outside its
//       rootdir (-c/--config-file elsewhere, --rootdir), and a green run of those tests must stay
//       green. A FAILING case with classname="" is unmapped (below), so it is never a pass. Any
//       other <error> (fixture setup or teardown) marks a failing test.
//     - <skipped> is not a failure.
//     - QA-1.3-35: a case with no <failure>/<error> only counts toward total; its attributes are
//       not decoded. Each input's cwd-relative id prefix is computed once.
//     Module mapping (QA-2.2-1). pytest's classname is the case's nodeid path relative to its
//     rootdir, without ".py" and with "/" replaced by ".", followed by the enclosing class names.
//       The rootdir R is the last `--rootdir=<v>` or `--rootdir <v>` of spec.args (D.4's pin, or
//       the user's kept value; argv follows PYTEST_ADDOPTS, so its last value wins), resolved
//       against spec.cwd. A value pytest would expand ("$", or "%" on win32) is not trusted.
//       Keys: with R, each input f inside R has exactly ONE key, dotted(P.relative(R, f)).
//       Without R (an explicit -c, a --rootdir in PYTEST_ADDOPTS, QA-1.3-49's unpinned spawn),
//       each input's keys are every segment-suffix of its gitRoot-relative dotted path: the
//       true file is always among them while R lies inside gitRoot.
//       A classname is resolved by walking ALL of its dot prefixes, one map lookup each. It maps
//       only when exactly one input answers (a key two inputs share answers for both). rest = the
//       part of classname after the matching prefix, split on ".".
//       id = `${P.relative(spec.cwd, f) with "/"}::${[...rest, name].join("::")}`. This matches
//       pytest's "FAILED <nodeid>" text.
//       A collection pseudo-case maps `name` the same way and gets a bare file id.
//       An unmatched case gets id `${classname}::${name}`, complete = false, and the note
//       `pytest classname not mapped to a test file: <classname>`.
//       A classname that more than one input answers is never charged to either (a suffix
//       shared by tests/test_x.py and sub/tests/test_x.py, or a module next to a package of the
//       same name). Failing or passing, it makes the result complete = false with the note
//       `pytest classname maps to more than one test file: <classname>`, and it is left out of
//       testsByFile. Fail closed: "the first input wins" let a batch union charge one request's
//       failure to another request and pass its producer (QA-2.2-1).
//     total = the number of testcases that are not collection pseudo-cases.
//     Exit codes:
//       5 -> total 0 and no failures (no tests collected).
//       4 -> complete = false, note "pytest usage error (exit 4)".
//       3 -> complete = false, note "pytest internal error (exit 3)".
//       Collection errors come from the XML, never from the exit code. Spike C: 2 without xdist,
//       1 with it.
//   Step 4  Fallback when there is no usable report: obs = observeTests(execResult) from
//           ./baseline.
//     failingIds = obs.failures. vitest "FAIL <rel> > ..." and pytest "FAILED <nodeid>" already
//     have the formats above.
//     failingFiles = the part before " > " or "::", resolved against spec.cwd, when present.
//     total = undefined. complete = false. source = "text".
//     collectionError = (execResult.code !== 0). Spike C: a syntax error in ANY vitest test file
//     aborts `related` with exit 1 and writes no report. It must never read as a pass.
//     Exit 0 with no report -> note "runner exited 0 without writing its report" (still
//     complete = false).
//   Output lists are deduplicated and sorted. The ids are cwd-relative, so a reference worktree
//   rerun (same relative layout) produces ids that compare equal.
//
// ------------------------------------------------------------------------------------------------
// J. S5 ATTRIBUTION DECISION: planListRelated does NOT exist, and 2.2 uses mode B.
//
//   Evidence (Spike C): vitest 4.1.11 has no non-executing "related" listing.
//     - `list --related` is an unknown option.
//     - `list <file>` treats the files as test-name filters.
//     - `list --changed` is git-based and cannot take the caller's file set.
//   jest 30 does have one (`--findRelatedTests ... --listTests`). A jest-only planListRelated is
//   still rejected, for two reasons:
//     - mode B must exist for vitest anyway. A jest-only mode A would double 2.2's attribution
//       paths and test matrix, for a saving that only appears on the failure path of a batch
//       with two or more requests;
//     - --listTests is still one process per request (a haste-map build) under the slot and caps.
//   pytest needs no listing: this module computes its affected set, so ScopedSpec.inputs ARE the
//   test files (inputsAreTests = true). 2.2 charges a failing pytest file f to every request
//   whose own plan's inputs contain f, without starting a process.
//   Mode B for vitest and jest, when the union run fails and the batch has more than one request:
//   run each request's own planScopedRun spec (vitest cannot intersect `related` with a file
//   filter), all under one slot hold. Each request is charged the failures its own run
//   reproduces. A union failure that no per-request run reproduces (a flaky test) must not
//   become a pass for any request. A batch of one needs no attribution.
//
// ------------------------------------------------------------------------------------------------
// K. LINT SCOPING (planScopedLint; section 1.5-10)
//
//   The result is LintSpec | NoAffected | Unscoped. Unscoped means "run the resolved command as
//   today (runShell with the allowlist, under S3/S4)". Lint never returns Unverifiable.
//   - Detection uses the B and C rules with the heads eslint, npx eslint and pnpm exec eslint,
//     plus package scripts (the default lint command is "npm run lint"). Anything else (tsc &&
//     eslint, next lint, biome, a wrapper) -> Unscoped, with the reason text B/C would produce.
//   - Arguments follow D.1 and D.5. Positionals are path scopes, and there are none by default,
//     meaning runnerCwd. A positional containing * ? [ ] { } -> Unscoped
//     `eslint glob pattern in <where>: "<p>"`.
//   - A lintable file exists and lies inside gitRoot and inside a path scope. eslint >= 9: that
//     is all (QA-1.3-9): the flat config decides what it lints and --no-warn-ignored silences
//     the rest, so a .vue or .md file the config covers is not skipped. eslint < 9 or an
//     unknown version: it must also have an extension from --ext (comma-separated, leading dots
//     optional), by default .js .mjs .cjs .jsx .ts .mts .cts .tsx, because eslintrc lints every
//     explicitly passed file. The entry is resolved before this filter, so "no changed lintable
//     files" before resolution means no existing in-scope file at all.
//   - Config triggers (basename): eslint.config.*, .eslintrc, .eslintrc.*, .eslintignore,
//     package.json, tsconfig*.json, the JS lockfiles and workspace files of G.7, and the
//     --config/-c file -> Unscoped `eslint config changed: <rel>`.
//   - "unavailable" -> Unscoped "change attribution unavailable".
//   - No lintable files -> NoAffected "no changed lintable files".
//   - Entry: node_modules/eslint (F). Missing -> Unscoped "runner not installed: eslint".
//   - version major >= 9 -> add "--no-warn-ignored"; otherwise explicitly passed ignored files
//     emit warnings that break --max-warnings. major < 9 with --max-warnings -> Unscoped
//     "eslint <9 cannot scope ignored files under --max-warnings".
//   - Worker cap: only when the user set --concurrency N|auto -> `--concurrency=<E rule>`.
//   - argv = [...E, ...K, ...(v9 ? ["--no-warn-ignored"] : []), ...F]. F is absolute, with no
//     "--" (not verified for eslint). Exit code: 0 pass, 1 lint errors, 2 fatal.
//
// ------------------------------------------------------------------------------------------------
// L. ALLOWLIST CHANGE (Task 1.3.3, in deterministic.ts; this module does not implement it)
//
//   DEFAULT_ALLOWLIST gains "pytest", and NOT "uv".
//   In isCommandAllowed, after the FORBIDDEN_SHELL check and tokenization: when the first
//   token's basename, minus .exe/.cmd/.bat, is "uv", return
//     allowlist.includes("pytest") && tokens[1] === "run" && tokens[2] === "pytest".
//   This runs BEFORE the generic allowlist test, so it holds even when a user allowlist contains
//   "uv". Refused: `uv run python -c ...`, `uv run --with x pytest`, `uv pip ...`. `uvx` is not
//   on the allowlist. Every existing allowlist test stays green.
//
// ------------------------------------------------------------------------------------------------
// M. REASON STRINGS (stable: they reach the orchestrator, and tests assert them verbatim)
//
//   M.1 S6 reasons, as code -> template:
//     attribution-unavailable  change attribution unavailable
//                              change attribution unavailable: no changed path lies inside the
//                              git root   (G.4a)
//     no-git-root              no git repository at or above <cwd>
//     no-package-json          no package.json between <cwd> and the git root
//     bad-package-json         unreadable package.json: <path>
//     no-script                package.json has no string scripts.<s>: <path>
//     composite                composite <where>: "<construct>"
//     unterminated-quote       unterminated quote in <where>
//     inline-env               inline environment assignment "<NAME>=" in <where> (only cross-env
//                              is supported)
//     unsupported-command      unsupported command "<prefix>" in <where>
//     bun-test                 "bun test" runs Bun's built-in test runner, not scripts.test (use
//                              "bun run test")
//     unsupported-subcommand   unsupported vitest subcommand "<sub>" in <where>
//     unsupported-argument     unsupported <runner> argument "<token>" in <where>
//                              unsupported pytest config for the scoped inputs: <file|none>
//                              instead of <file|none>   (D.4 pinning, QA-1.3-43)
//                              unsupported pytest rootdir: the pytest releases pick <a> or <b>
//                              unsupported pytest rootdir: pytest expands variables in <dir>
//                              unsupported <vitest|jest> config: <path> does not parse as JSON
//                              (G.7a, QA-1.3-46)
//     ambiguous-option         ambiguous <runner> option "<opt>" in <where>: cannot tell whether
//                              "<next>" is its value
//     runner-not-installed     runner not installed: <vitest|jest|pytest|uv>
//     yarn-pnp                 yarn Plug'n'Play has no node_modules to resolve <pkg> from
//     bad-bin                  invalid bin for <pkg>: <detail>
//     config-changed           config file changed: <rel>
//                              config file changed in the linked repository: <rel>   (G.4b)
//     deleted-no-tests         deleted source <rel>: no test file references "<stem>"
//     stem-too-common          deleted source <rel>: "<stem>" appears in <n> test files (limit 20)
//     search-failed            test search failed for <rel>
//     tmpdir-in-repo           temp dir is inside the repository: <tmpdir>
//                              temp dir is not an absolute path: <tmpdir>   (H)
//     argv-too-long            too many inputs for one command line: <n> files
//     node-not-found           node not found: no absolute PATH entry has a node executable
//                              node path is not absolute: <path>
//                              node on PATH is not an executable file: <f>   (F.1)
//     too-many-searches        too many changed modules to map: <n> test searches (limit 50)
//                              (G.9a)
//     config-too-large         config file too large to read: <path> (limit 1048576 bytes)
//                              (QA-1.3-34)
//                              too many setup references in <path> (limit 1000)   (G.7a,
//                              QA-1.3-42; <path> is "the inline jest --config" for QA-1.3-41)
//     unmapped-module          no test file maps to the changed module <rel>   (G.8, E2E-1)
//                              changed module <rel> is referenced by <conftest rel>: the tests
//                              its fixtures reach cannot be mapped
//                              package structure changed: <rel> deleted; pytest import paths
//                              may shift   (G.8, QA-G-22; <rel> ends in __init__.py)
//     cross-link-unsupported   a change in a linked repository needs vitest 5 to scope: this
//                              check runs <jest|pytest>
//                              ... the resolved vitest is <version|of an unknown version>
//                              every spelling of <rel> in the linked repository lies under
//                              node_modules, which vitest related skips   (G.4b, cross-repo P3a)
//     cross-link-gone          changed file gone in the linked repository (deleted or renamed
//                              away): <rel>   (G.4b; <rel> is relative to the linked repository)
//   M.2 NoAffected notes:
//     "no changed files, no affected tests"                          (section 1.5-6, exactly)
//     "no affected tests: no changed file is a test input"           (docs only, dropped paths,
//                                                                     deleted tests, test files
//                                                                     outside the scopes (G.8b))
//     (E2E-1 removed "no affected tests: no test files map to the changed modules": a changed
//      pytest module is never NoAffected.)
//     "no changed lintable files"                                    (lint)
//     "no rerun: none of the test files exist in this tree"          (planRerun)
//   M.3 Unscoped (lint) reasons: the B/C/D texts above with "S6" read as "Unscoped", plus the K
//       texts.
//
// ------------------------------------------------------------------------------------------------
// N. SECURITY INVARIANTS (the 1.3 QA review checks each one in code)
//
//   1. No shell, ever. This module never imports child_process. spec.file is one of: node (F.1:
//      host.nodePath, a node-named host.execPath, or node(.exe) from an absolute PATH entry); or a
//      native file named pytest(.exe) or uv(.exe) from an absolute PATH entry or the .venv
//      fallback. It is never a .cmd/.bat/.ps1/.sh shim, and never Bun. npx, pnpm, yarn and bun are
//      only parsed, never executed.
//   2. File arguments are argv elements, each absolute, normalized and inside gitRoot, so no
//      file argument can start with "-". A file literally named "--config=evil" becomes
//      "<root>/--config=evil". As a second guard, an input starting with "-" after normalization
//      is dropped with a note. jest and pytest also get "--" before the files (verified in R);
//      vitest never does.
//   3. No input list is ever empty. "vitest related" with no files runs nothing and exits 0 (R),
//      while "vitest run" and "pytest" with no files run the WHOLE suite. An empty list becomes
//      NoAffected.
//   4. reportPath lives in host.tmpdir and randomId is a UUID. A relative tmpdir, or one inside
//      gitRoot (lexically or after realpath) -> S6. readResult reads and unlinks only an
//      absolute path whose dirname equals the absolute host.tmpdir (case-insensitive on win32)
//      and whose basename matches REPORT_NAME_RE.
//   5. A JS entry resolves inside <dir>/node_modules/<pkg>/, for some dir from runnerCwd up to
//      gitRoot. The package name must match, and bin must stay inside the package dir with a
//      .js/.mjs/.cjs extension.
//   6. User script tokens only ever become argv of the executable the planner chose. They can
//      add runner options (the same trust as `npm test` today), but they cannot choose the
//      program. The package.json that supplied the script is a config trigger, so a producer
//      that rewrites the script gets S6 instead of a run of its own command.
//   7. Paths that leave gitRoot are dropped, and PATH entries must be absolute (win32: with a
//      drive or UNC host, QA-1.3-36). Outside gitRoot,
//      the module reads only the runner's own package under node_modules, executables on
//      absolute PATH entries, and the pytest config candidates pytest itself would read above
//      gitRoot (D.4).
//   8. The adapter-owned flags appear exactly once, because D removes user copies: the worker
//      cap, reporter, outputFile, passWithNoTests, run, the coverage switch, junitxml,
//      -p no:cacheprovider and --maxfail=0. pytest's pinned -c and --rootdir (D.4) are added only
//      when the command and PYTEST_ADDOPTS give none, so they appear at most once too.
//   9. The argv-length cap (H) exists so that a failed spawn (Windows' limit is 32767 chars)
//      never masquerades as a test failure. It counts the program path and win32 quoting.
//
// ------------------------------------------------------------------------------------------------
// O. DEVIATIONS FROM PLAN (evidence wins, and each one is deliberate)
//
//   1. `bun test` is S6, not scripts.test, although section 1.5-4 lists it. Bun runs its built-in
//      test runner for `bun test` (Bun docs, R). `bun run test` resolves scripts.test.
//   2. "--" before the file arguments is used for jest and pytest only. vitest's cac drops the
//      tokens after "--" from related's file list, which ran 0 tests with exit 0 (R). The
//      universal guard against flag injection is the absolute-path rule (N.2).
//   3. planScopedRun returns ScopedSpec | NoAffected | Unverifiable (the plan says ScopedSpec |
//      Unverifiable). Section 1.5-6 needs a "pass with a note, spawn nothing" outcome.
//   4. planStaticScoping is new. Section 1.5-17 requires the risk signal's "scoping impossible"
//      flag to be decided with no process at all. The section 1.5-5 git grep and the pytest name
//      mapping need one, so planStaticScoping is planScopedRun minus the searches. 1.6 codes
//      against it.
//   5. planListRelated does not exist (J), even though jest has --listTests.
//   6. vitest and jest have config triggers too. Section 1.5-3 lists pytest only, but S6 names
//      "config-file change", and `vitest related package.json` ran the whole suite (R).
//   7. readResult returns more than {failingIds, failingFiles, collectionError, total}: total is
//      number | undefined (unknown in the text fallback), and it adds complete, source and note,
//      because a text fallback is never a complete inventory.
//   8. planRerun takes a fifth argument, deps. It has to drop test files missing from the target
//      tree (R: jest --runTestsByPath on a missing file exits 1; pytest exits 4). It may also
//      reuse the current tree's entry for a reference worktree that has no node_modules.
//   9. "`..` traversal (dropped)" is implemented as resolve first, then drop if outside the
//      root. "a/../b" inside the repo is a real change, so it is kept, normalized.
//   10. Unverifiable carries a stable `code` next to `reason`, for risk.ts and the tests.
//   11. pre/post lifecycle scripts are not run and are not S6 (a note only). A hook is not a
//       test, and skipping one can at worst produce a failure or a collection error.
//
// ------------------------------------------------------------------------------------------------
// P. NOT YET VERIFIED. The 3.1 fixtures must cover these; a failure means a design bug.
//
//   - jest `--coverage=false` overrides collectCoverage: true set in the config.
//   - pytest `--no-cov` also suppresses a --cov-fail-under that comes from addopts.
//   - vitest behaves consistently with "--no-file-parallelism" plus "--maxWorkers=1".
//   - Custom vitest forceRerunTriggers in the user's config cannot be read statically and can
//     make `related` run every file. This is an accepted residual risk (plan section 5,
//     config-driven tests). vitest adds setupFiles to them (QA-1.3-15 evidence; globalSetup is
//     not verified). Setup files are triggers by name (G.7) and by static reference (G.7a); what
//     remains is a setup file under an unconventional name that a config names only through a
//     non-literal expression whose last segment is not a literal either (a variable holding the
//     whole path, a template with ${}), or that a project config outside
//     the file's own directory chain names (packages/a's config naming ../../shared/boot.js).
//     Such a change is not verified by either runner: jest's related graph does not see it, and
//     vitest does not rerun a project's setupFiles either (QA-1.3-44: `vitest related` ran 0
//     tests for a changed packages/a setup file under `test.projects`); round 3's "vitest reruns
//     every test file" held only without projects.
//   - A change made only to test files the vitest/jest config excludes (Playwright specs in the
//     create-vue and Vite layouts) is unverifiable, not a pass: the specs stay inputs (G.8a,
//     QA-1.3-38) and the run reports 0 tests (I 2a). This is the pre-round-3 behaviour, restored
//     after round 3's static exclusion dropped real vitest tests. An exact answer needs the
//     runner itself (Q 2.1).
//   - A conftest.py or plugin hook (pytest_load_initial_conftests, pytest_cmdline_main) that
//     adds -n cannot be seen statically; the appended "-n N" only lands when D.4 found xdist.
//   - Tokenizing: npm on Windows (cmd.exe) does not treat '...' as quotes, while C.1 applies
//     POSIX rules everywhere.
//   - A vitest `run <absolute path>` filter may also select a longer name with the same prefix
//     (a.test.ts also selects a.test.tsx). That runs extra tests but never misses one.
//   - A `bail` set in a vitest or jest config file (not on the command line) still cuts the run
//     short: the JS config cannot be read statically. 2.1's S2 comparison inherits this residual
//     (QA-1.3-2 covers the command line; pytest addopts are covered by --maxfail=0).
//   - npm workspace selection from the user or global npmrc (~/.npmrc, $PREFIX/etc/npmrc, or a
//     npm_config_userconfig/globalconfig file) is not read (QA-1.3-24 covers the project .npmrc
//     files and the environment).
//
// ------------------------------------------------------------------------------------------------
// Q. CONSUMER CONTRACT
//
//   1.6 risk.ts takes `ScopingPlan | StaticScoping`. "Scoping impossible" holds when
//       isUnverifiable(plan). Show plan.reason and branch on plan.code. Callers obtain the plan
//       from planStaticScoping, which starts no process. S6Code only grows (round 2 added
//       node-not-found and too-many-searches, round 3 config-too-large), so a switch over it
//       needs a default branch.
//   2.1 testsPass: plan = planScopedRun(...).
//       - NoAffected -> pass, with the note.
//       - Unverifiable -> S6.
//       - ScopedSpec -> run argv(spec.file, spec.args, {cwd: spec.cwd, env: spec.env,
//         lowPriority, signal, timeoutMs}) under the slot. Then ALWAYS call
//         readResult(spec, result, fs), even after a timeout or abort, because it deletes the
//         report.
//       Green means !timedOut && complete && !collectionError && failingIds is empty. total === 0
//       means green with the note "no affected tests ran" (I step 2a already turned the
//       untrustworthy zeros into complete = false). The fs passed to the planners must be a
//       PlannerFs with the native realpath (G.3a).
//       S2: map failingFiles into the reference worktree (gitRoot-relative), call
//       planRerun(runner, mapped, refRunnerCwd, budget, {fs, entry}), and compare failingIds.
//       testScope "full" is outside this module, except that its recheck uses planRerun.
//       Known source of unverifiable results (G.8a, QA-1.3-38): a change made only to test files
//       the runner's config excludes (Playwright specs). If 2.1 wants those to pass, it must ask
//       the runner, not a static reading: `vitest list --filesOnly --json <file>` (Spike C: no
//       test module is imported) or `jest --listTests --findRelatedTests <file>` listing nothing
//       for every such input would justify NoAffected.
//   2.2 batch: the key is (spec.gitRoot, spec.runner, spec.entry, key-sorted JSON of spec.env).
//       The union run is planScopedRun over the union of the requests' changed files, with the
//       same command and cwd. Attribution follows J.
//
// ------------------------------------------------------------------------------------------------
// R. EXTRA EVIDENCE (runs made for this design, with Spike C's fixtures %TEMP%\omr-spikeC and
//    versions)
//
//   vitest related test/math.test.js --run          -> exit 0, ran math.test.js: a test file passed
//                                                      to related runs itself.
//   vitest related --run ... -- src/math.js         -> exit 0, 0 tests.
//   vitest related src/str.js ... -- src/math.js    -> ran str only: cac drops the tokens after
//                                                      "--" from the file list.
//   vitest related --run (no files)                 -> exit 0, testResults [].
//   vitest related package.json --run               -> ran ALL test files (forceRerunTriggers).
//   vitest run <file> (absolute \, absolute /, relative) -> exactly that file.
//   vitest run <absent absolute file> --passWithNoTests  -> exit 0, total 0.
//   vitest related src/math.js --run --coverage.enabled=false -> exit 0; accepted without a
//                                                      coverage provider installed.
//   jest --findRelatedTests test/math.test.js --listTests -> math.test.js (runs itself).
//   jest --findRelatedTests --listTests -- src/math.js    -> math.test.js ("--" works).
//   jest --runTestsByPath --listTests -- <absolute>       -> exactly that file.
//   jest --runTestsByPath ... -- <absent file>            -> exit 1, numTotalTests 0.
//   jest --findRelatedTests --listTests (no files)        -> exit 1, "requires file paths".
//   jest --findRelatedTests package.json --listTests      -> nothing listed.
//   pytest -q -p no:cacheprovider -o addopts= -- <absolute> -> exit 0 ("--" works).
//   pytest ... -- --config=evil.py -> exit 4 "file or directory not found: --config=evil.py".
//   Bun docs (oven-sh/bun docs/runtime/index.mdx): "If a built-in bun command has the same name,
//   the built-in command takes precedence; use the explicit bun run <script>".

import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as nodePath from "node:path";
import { observeTests } from "./baseline";
import type { ExecResult, FsSeam } from "./types";

// ---------------------------------------------------------------------------------------------
// Constants (contract values quoted by the design above)
// ---------------------------------------------------------------------------------------------

/** git pathspecs for the section 1.5-5 stem search over JS/TS test files. */
export const JS_TEST_GLOBS: readonly string[] = [":(glob)**/*.test.*", ":(glob)**/*.spec.*", ":(glob)**/__tests__/**"];
/** git pathspecs for the section 1.5-5 stem search over pytest test files (the default python_files; G.8). */
export const PY_TEST_GLOBS: readonly string[] = [":(glob)**/test_*.py", ":(glob)**/*_test.py"];
/** pytest's default python_files (G.8, QA-1.3-33). */
export const DEFAULT_PYTHON_FILES: readonly string[] = ["test_*.py", "*_test.py"];
/** Config files above this many bytes are not parsed: S6 config-too-large (QA-1.3-34). */
export const CONFIG_SIZE_LIMIT = 1024 * 1024;
/** Path resolutions of vitest/jest setup references per plan (G.7a, QA-1.3-42); beyond it, S6 config-too-large. */
export const SETUP_REF_LIMIT = 1000;
/** A deleted source whose stem appears in more test files than this is S6 stem-too-common. */
export const STEM_MATCH_LIMIT = 20;
/** More changed files needing a process-backed test search than this is S6 too-many-searches (G.9a). */
export const SEARCH_LIMIT = 50;
/** Upper bound on the summed (arg.length + 1) of a spec's args (Windows CreateProcess: 32767). */
export const MAX_ARGV_CHARS = 30000;
/** Report files: `${tmpdir}/omr-verify-<uuid>.json|.xml`. readResult touches nothing else. */
export const REPORT_NAME_RE = /^omr-verify-[0-9a-f-]{36}\.(json|xml)$/;

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** Test runners the adapter can scope. */
export type RunnerKind = "vitest" | "jest" | "pytest";
/** Every tool whose entry resolveEntry can locate. */
export type ToolKind = RunnerKind | "eslint";
/** How the runner was invoked. The launcher is parsed, never executed. */
export type Launcher = "direct" | "npx" | "pnpm-exec" | "uv-run";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Stable S6 reason codes (section M.1). */
export type S6Code =
  | "attribution-unavailable"
  | "no-git-root"
  | "no-package-json"
  | "bad-package-json"
  | "no-script"
  | "composite"
  | "unterminated-quote"
  | "inline-env"
  | "unsupported-command"
  | "bun-test"
  | "unsupported-subcommand"
  | "unsupported-argument"
  | "ambiguous-option"
  | "runner-not-installed"
  | "yarn-pnp"
  | "bad-bin"
  | "config-changed"
  | "deleted-no-tests"
  | "stem-too-common"
  | "search-failed"
  | "tmpdir-in-repo"
  | "argv-too-long"
  | "node-not-found"
  | "too-many-searches"
  | "config-too-large"
  | "unmapped-module"
  | "cross-link-unsupported"
  | "cross-link-gone";

/** S6: scoping is impossible. The reason names the construct (section M.1) and never triggers a full suite. */
export interface Unverifiable {
  readonly unverifiable: true;
  readonly reason: string;
  readonly code: S6Code;
}

/** Nothing to run: the check passes with this note (section 1.5-6, M.2). */
export interface NoAffected {
  readonly noAffected: true;
  readonly note: string;
}

/** Lint only: run the resolved lint command unchanged, as today (section 1.5-10). */
export interface Unscoped {
  readonly unscoped: true;
  readonly reason: string;
}

/** One changed file as attributed to the producer. Structurally compatible with dispatch.ts ChangedFile. */
export interface ChangedPath {
  /** Absolute, or relative to the planner's cwd. */
  readonly path: string;
  /** Informational only. Existence is decided through the fs seam (G.6). */
  readonly status?: string;
  /** The source path of a rename, when known. It is treated as a gone file. */
  readonly previousPath?: string;
}

export interface RunnerBudget {
  /** enforcement.verify.maxWorkers (integer >= 1, default 2). Invalid values are treated as 1. */
  readonly maxWorkers: number;
}

/** A user worker-cap value after parsing (section E). */
export type UserWorkerCap =
  | { readonly count: number }
  | { readonly percent: number }
  | { readonly auto: true };

/** Host facts, injectable for tests. Defaults come from process/os/crypto. */
export interface RunnerHost {
  /** Picks path.win32 or path.posix for every path operation. Default: process.platform. */
  readonly platform: NodeJS.Platform;
  /**
   * The running process's executable. Default: process.execPath. JS tools run under it only when
   * it is node (basename node or node.exe; the default also requires a non-Bun runtime). Under Bun,
   * or inside a compiled binary, node comes from PATH instead (F.1, QA-1.3-18).
   */
  readonly execPath: string;
  /** An explicit absolute node executable for JS tools (F.1). It wins over execPath and PATH. */
  readonly nodePath?: string;
  /** Default: os.tmpdir(). */
  readonly tmpdir: string;
  /** Default: os.availableParallelism(). */
  readonly cores: number;
  /** Default: process.env.PATH ?? "". */
  readonly pathEnv: string;
  /** win32 only, the node PATH lookup (F.1). Default: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD". */
  readonly pathExt?: string;
  /** Default: process.env.PYTEST_ADDOPTS ?? "" (xdist/cov evidence, D.4). */
  readonly pytestAddopts: string;
  /** The environment npm itself sees, read for npm_config_workspace(s) only (B, QA-1.3-24). Default: process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Default: crypto.randomUUID. It must return a UUID (REPORT_NAME_RE). */
  readonly randomId: () => string;
}

/**
 * The planners' filesystem seam (G.3a, QA-1.3-1). `realpath` must be the NATIVE realpath
 * (fs.promises.realpath or fs.realpathSync.native): it resolves symlinks, junctions and win32
 * 8.3 short names, and it rejects for a missing path. The JS fs.realpathSync does not expand 8.3
 * names and must not be used. `fileExists` must accept directories as well as files (B step 0).
 * Without `realpath`, paths stay lexical, every spec carries `lexicalPaths: true`, and readResult
 * never trusts a run that reports 0 tests (I step 2a, any runner: QA-1.3-19). It stays optional so
 * a plain FsSeam still type-checks; 2.1 must pass the native realpath.
 * `stat` (optional, round 3) is fs.promises.stat(path, { bigint: true }) mapped to FileStat. With it,
 * config files are size-checked before they are read (QA-1.3-34), a directory named node(.exe) is
 * not a node (QA-1.3-36), and a PATH node that is the same file as a non-node runtime (Bun's
 * temporary hard link, QA-1.3-30) is skipped. 2.1 should pass it.
 * `readdir` (optional, QA-1.3-51) is fs.promises.readdir(path): the entry names of a directory,
 * files and directories alike. With it, the JS config probe (G.7a) lists each directory once per
 * plan instead of checking every config name with fileExists; a directory it cannot list falls
 * back to fileExists. 2.1 should pass it.
 */
export interface PlannerFs extends FsSeam {
  realpath?(path: string): Promise<string>;
  stat?(path: string): Promise<FileStat>;
  readdir?(path: string): Promise<readonly string[]>;
}

/** What PlannerFs.stat reports. bigint dev/ino keep win32 file ids exact. */
export interface FileStat {
  readonly isFile: boolean;
  readonly size: number | bigint;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

/** Filesystem seam extended with the one mutation readResult needs. */
export interface RunnerFs extends PlannerFs {
  /** Delete a file. It must resolve, not reject, when the file is already gone. */
  unlink(path: string): Promise<void>;
}

/**
 * Process-backed searches, implemented by the caller (2.1 wiring) with git through the ArgvSeam.
 * No shell is involved: use `git ls-files -z --cached --others --exclude-standard -- <pathspecs>`
 * and `git grep -l -z -F --untracked -e <needle> -- <globs>`, where git grep exit 1 means [].
 * `undefined` means the search could not run. It is never the same as "no match".
 */
export interface TestSearchSeam {
  /** Absolute paths under gitRoot whose basename is one of `names`. */
  findByName(gitRoot: string, names: readonly string[]): Promise<readonly string[] | undefined>;
  /**
   * Absolute paths under gitRoot that match a pathspec in `globs` and contain `needle` literally.
   * With `options.word` the needle must stand as a whole word (git grep -w: not preceded or
   * followed by a letter, digit or "_").
   */
  findByContent(
    gitRoot: string,
    needle: string,
    globs: readonly string[],
    options?: { readonly word?: boolean },
  ): Promise<readonly string[] | undefined>;
}

export type CommandSource =
  | { readonly type: "command" }
  | {
      readonly type: "script";
      readonly manager: PackageManager;
      readonly name: string;
      /** Absolute path of the package.json that supplied the script. It is a config trigger (G.7). */
      readonly packageJson: string;
    };

/** detectRunner's output: a fully classified invocation (sections B, C, D). */
export interface DetectedRunner {
  readonly kind: RunnerKind;
  readonly launcher: Launcher;
  readonly source: CommandSource;
  readonly gitRoot: string;
  /** The runner's working directory: cwd for direct commands, the package.json dir for scripts. */
  readonly runnerCwd: string;
  /** cross-env assignments. */
  readonly env: Readonly<Record<string, string>>;
  /** User arguments kept verbatim, in order (D). */
  readonly keptArgs: readonly string[];
  /** The last user cap value (D, E). Undefined when there is none or it was invalid. */
  readonly userWorkers?: UserWorkerCap;
  /** pytest: absolute path scopes from the user's positionals (empty means runnerCwd). Always empty for vitest/jest. */
  readonly pathScopes: readonly string[];
  /** pytest: xdist is known to be present and is not disabled (D.4). Always false for vitest/jest. */
  readonly xdist: boolean;
  /** pytest: pytest-cov options found in the pytest config (D.4). Always false for vitest/jest. */
  readonly covInConfig: boolean;
  readonly notes: readonly string[];
  /** pytest: what the command itself says, so each spec can redo the config lookup from its inputs (D.4). */
  readonly pytestFacts?: PytestFacts;
  /** Absolute canonical paths of the --config/-c (pytest: -c/--config-file) values. Config triggers (G.7, QA-1.3-5). */
  readonly configFiles?: readonly string[];
  /**
   * jest: the inline JSON `--config` values (QA-1.3-41), which jest reads as the config itself.
   * They are not in configFiles; the setup files they name are triggers (G.7a).
   */
  readonly inlineConfigs?: readonly string[];
  /**
   * pytest: the python_files patterns the user's run can use (G.8, QA-1.3-33): the union over the
   * configs every pytest release line picks (defaults where a line's config sets none) and every
   * `-o python_files=` override. Undefined means DEFAULT_PYTHON_FILES.
   */
  readonly pythonFiles?: readonly string[];
  /**
   * pytest (G.8b, E2E-1): the directories and files the user's run collects from when that is
   * decided by `testpaths`: no path argument, and every pytest release line reads a config that
   * sets testpaths and has runnerCwd as its rootdir. Test inputs outside them are never collected
   * by the user's run. Undefined: the run collects from runnerCwd (or the path scopes).
   */
  readonly collectScopes?: readonly string[];
}

/** The pytest command's own worker, xdist and config facts (D.4, QA-1.3-3). */
export interface PytestFacts {
  /** The raw value of the last cap token on the command line. */
  readonly cap?: string;
  /** The command has a cap entry or --dist. */
  readonly xdist: boolean;
  /** The command has "-p no:xdist". */
  readonly noXdist: boolean;
  /** -c / --config-file, absolute and canonical: pytest reads only this file. */
  readonly configFile?: string;
  /** The value of `-o addopts=<v>` / `--override-ini addopts=<v>`: it replaces the config's addopts. */
  readonly overrideAddopts?: string;
  /** The patterns of every `-o python_files=<v>` on the command line (QA-1.3-33): they replace the config's. */
  readonly pythonFiles?: readonly string[];
  /** The last `--rootdir` value on the command line. A non-empty one turns off pytest's per-argument config fallback (D.4, QA-1.3-40). */
  readonly rootdir?: string;
  /**
   * QA-1.3-48: every argument pytest's config lookup takes as a path argument, in order, when the
   * command gives a plugin option a separate value (`--cov src`). Undefined: the path arguments
   * (pathScopes) alone.
   */
  readonly freeArgs?: readonly PytestFreeArg[];
}

/**
 * QA-1.3-48: pytest picks its config (determine_setup) before it loads plugins from entry points,
 * so a plugin option's separate value (`--cov src`, `--cov-config .coveragerc`, `-n 4`) is a free
 * argument there, and an existing one moves the arguments' common ancestor like a path argument.
 */
export interface PytestFreeArg {
  /** Absolute, with a `::` node-id part removed. */
  readonly path: string;
  /** The value of a plugin option: it counts only when the path exists (get_dirs_from_args). */
  readonly plugin: boolean;
  /** The option stays in the spec's argv (--timeout, --dist), so the spawn's lookup sees it too. */
  readonly kept: boolean;
}

/** What resolveEntry needs. DetectedRunner satisfies it. */
export interface EntryRequest {
  readonly kind: ToolKind;
  readonly launcher: Launcher;
  readonly gitRoot: string;
}

export interface ResolvedEntry {
  /** node (F.1) for JS tools; the native pytest/uv executable otherwise. */
  readonly file: string;
  /** Leading args: [entryJs] for JS tools, [] for pytest, ["run", "pytest"] for uv. */
  readonly prefix: readonly string[];
  /** The resolved JS entry or native executable. Part of the S5 batch key. */
  readonly entry: string;
  /** The package.json "version" (JS tools only). */
  readonly version?: string;
}

/** An executable test run (sections H, N). Spawn it with ArgvSeam(file, args, {cwd, env, ...}). */
export interface ScopedSpec {
  readonly runner: RunnerKind;
  readonly mode: "related" | "rerun";
  /** node (F.1) for vitest/jest; the native pytest/uv executable otherwise. Never a shim, never Bun. */
  readonly file: string;
  /** The complete argv after `file` (H). */
  readonly args: readonly string[];
  readonly cwd: string;
  /** cross-env assignments plus the adapter's env. The ArgvSeam merges it over process.env. */
  readonly env: Readonly<Record<string, string>>;
  /** Under os.tmpdir(), never inside gitRoot. readResult deletes it. */
  readonly reportPath: string;
  readonly gitRoot: string;
  /** Same as ResolvedEntry.entry. */
  readonly entry: string;
  /** Absolute files handed to the runner, sorted. They are sources (vitest/jest related) or test files. */
  readonly inputs: readonly string[];
  /** True when `inputs` are test files (pytest, every rerun), so S5 attribution can be static. */
  readonly inputsAreTests: boolean;
  /** The worker cap emitted. null when no cap flag applies (pytest without xdist). */
  readonly workers: number | null;
  readonly notes: readonly string[];
  /**
   * Set when the fs seam had no realpath, so cwd and inputs may not be the canonical spelling
   * (G.3a). jest and vitest match files against a realpath'd root, so readResult treats a run
   * reporting 0 tests as incomplete (I step 2a).
   */
  readonly lexicalPaths?: true;
  /**
   * Cross-repo P3a (G.4b): some inputs are files of another repository (crossLinkRoot) that the
   * consumer reaches through a link. Always a vitest `related` spec.
   */
  readonly crossLink?: true;
}

/** An executable scoped eslint run (section K). Pass or fail comes from the exit code. */
export interface LintSpec {
  readonly runner: "eslint";
  /** node (F.1). */
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly gitRoot: string;
  readonly entry: string;
  readonly inputs: readonly string[];
  /** The --concurrency emitted. null when the user set none (eslint's default is "off"). */
  readonly workers: number | null;
  readonly notes: readonly string[];
}

/** planScopedRun's result. */
export type ScopingPlan = ScopedSpec | NoAffected | Unverifiable;

/** planStaticScoping's "no S6 decidable without a search" outcome. */
export interface StaticScopable {
  readonly scopable: true;
  readonly runner: RunnerKind;
  /** Gone sources and pytest modules whose tests still need a search (G, end of section). */
  readonly pendingSearches: number;
  readonly notes: readonly string[];
}

/** planStaticScoping's result: the risk signal's input (section 1.5-17, Q). */
export type StaticScoping = StaticScopable | NoAffected | Unverifiable;

export interface PlanScopedRunInput {
  /** The resolved check command (resolveRepoCommand). It already passed isCommandAllowed. */
  readonly command: string;
  readonly cwd: string;
  /** "unavailable" when change attribution is unavailable (section 1.5-6). */
  readonly changedFiles: readonly ChangedPath[] | "unavailable";
  readonly budget: RunnerBudget;
  /** Injected core count (percent and auto caps). Default: host.cores. */
  readonly cores?: number;
  readonly fs: PlannerFs;
  readonly search: TestSearchSeam;
  readonly host?: Partial<RunnerHost>;
  /**
   * Cross-repo P3a (G.4b): the git top of the repository W whose change this consumer check in `cwd`
   * covers (SD-P3a-5). With it, a changed path inside W becomes a vitest `related` input, in every
   * spelling of SD-P3a-2, instead of being dropped as outside the git root. planScopedLint ignores
   * it (a foreign lint stays full-only). Unset by every caller today.
   */
  readonly crossLinkRoot?: string;
  /**
   * Other spellings of crossLinkRoot's directory, such as the JS fs.realpathSync of a consumer link
   * into W (it keeps the link's stored target text, which vite uses). Each one + the relative path
   * is an input too (SD-P3a-2). Used only with crossLinkRoot.
   */
  readonly crossLinkAliases?: readonly string[];
}

/** planScopedRun's input without the process-backed search. */
export type StaticScopingInput = Omit<PlanScopedRunInput, "search">;

/** Lint needs no search: deleted files are simply not linted. */
export type PlanScopedLintInput = Omit<PlanScopedRunInput, "search">;

export interface RerunDeps {
  readonly fs: PlannerFs;
  /** Reuse an entry resolved elsewhere, such as the current tree for a reference worktree. Default: resolveEntry(runner, cwd). */
  readonly entry?: ResolvedEntry;
  readonly cores?: number;
  readonly host?: Partial<RunnerHost>;
}

/** readResult's output (section I). */
export interface RunResult {
  /** Stable ids, cwd-relative with "/" separators, sorted: "<file> > a > b", "<file>::Cls::test", or a bare "<file>" for a file-level failure. */
  readonly failingIds: readonly string[];
  /** Absolute paths (native separators) of files with any failure, sorted. */
  readonly failingFiles: readonly string[];
  /** A collection, import or syntax error, or a missing report after a non-zero exit. */
  readonly collectionError: boolean;
  /** Tests executed. undefined when unknown (text fallback). */
  readonly total: number | undefined;
  /** failingIds is a full inventory of the failures. false never yields a pass. */
  readonly complete: boolean;
  readonly source: "report" | "text";
  /** A stable explanation when complete is false or the report and exit code disagree. */
  readonly note?: string;
  /**
   * Tests the report lists per file (S5 attribution, Phase 2.2 P1): id-space file key (cwd-relative,
   * "/" separators, the prefix of failingIds) -> count. JSON: each suite's assertionResults; junit:
   * the testcases mapped to an input, without collection pseudo-cases. undefined for the text fallback.
   */
  readonly testsByFile?: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------------------------

export function isUnverifiable(x: object): x is Unverifiable {
  return "unverifiable" in x && x.unverifiable === true;
}

export function isNoAffected(x: object): x is NoAffected {
  return "noAffected" in x && x.noAffected === true;
}

export function isUnscoped(x: object): x is Unscoped {
  return "unscoped" in x && x.unscoped === true;
}

export function isScopedSpec(x: object): x is ScopedSpec {
  return "reportPath" in x && "runner" in x;
}

// ---------------------------------------------------------------------------------------------
// Internal helpers (host, paths, reasons)
// ---------------------------------------------------------------------------------------------

type PathApi = typeof nodePath.posix;

interface Ctx {
  readonly host: RunnerHost;
  readonly P: PathApi;
  readonly win: boolean;
  key(p: string): string;
  /** host.execPath is a node executable JS tools can run under (F.1, QA-1.3-18). */
  readonly execIsNode: boolean;
  /** Per-call caches (QA-1.3-34): a config file is read, and parsed per reading, once per plan. */
  readonly cache: {
    readonly texts: Map<string, Promise<TextRead>>;
    readonly parsed: Map<string, ConfigParse>;
    readonly exists: Map<string, Promise<boolean>>;
    /** QA-1.3-51: directory listings (PlannerFs.readdir); undefined when the directory could not be listed. */
    readonly dirs: Map<string, Promise<DirListing | undefined>>;
  };
}

/** A directory's entry names, as listed and lower-cased (QA-1.3-51). */
interface DirListing {
  readonly exact: ReadonlySet<string>;
  readonly folded: ReadonlySet<string>;
}

function resolveHost(h: Partial<RunnerHost> | undefined): RunnerHost {
  return {
    platform: h?.platform ?? process.platform,
    execPath: h?.execPath ?? process.execPath,
    ...(h?.nodePath !== undefined ? { nodePath: h.nodePath } : {}),
    tmpdir: h?.tmpdir ?? os.tmpdir(),
    cores: h?.cores ?? os.availableParallelism(),
    pathEnv: h?.pathEnv ?? process.env.PATH ?? "",
    pathExt: h?.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    pytestAddopts: h?.pytestAddopts ?? process.env.PYTEST_ADDOPTS ?? "",
    env: h?.env ?? process.env,
    randomId: h?.randomId ?? randomUUID,
  };
}

function makeCtx(h: Partial<RunnerHost> | undefined): Ctx {
  const host = resolveHost(h);
  const win = host.platform === "win32";
  const P = win ? nodePath.win32 : nodePath.posix;
  const named = /^node(?:\.exe)?$/.test(win ? P.basename(host.execPath).toLowerCase() : P.basename(host.execPath));
  // F.1: an explicit execPath is trusted by name; the default also needs a runtime that is not Bun.
  // Neither may sit in Bun's temporary bun-node-<hex> directory (QA-1.3-30: `bun --bun run`).
  const bunDir = BUN_NODE_DIR_RE.test(P.basename(P.dirname(host.execPath)));
  const execIsNode = named && !bunDir && (h?.execPath !== undefined || process.versions.bun === undefined);
  const cache = { texts: new Map(), parsed: new Map(), exists: new Map(), dirs: new Map() };
  return { host, P, win, key: (p: string) => (win ? p.toLowerCase() : p), execIsNode, cache };
}

/** A config file's text (BOM removed), or why it could not be used (QA-1.3-34). */
type TextRead = { readonly text: string } | "unreadable" | "too-large";

/**
 * QA-1.3-34: every config file the planners parse (pytest configs, .npmrc, the JS runner configs)
 * is read at most once per call, through this cache, and never parsed above CONFIG_SIZE_LIMIT: a
 * 100 MB pytest config cost up to 86 s and 9 GB. With fs.stat the size is checked before the
 * read; without it, after. A leading UTF-8 BOM is dropped (npm's ini parser trims it, QA-1.3-32).
 */
async function readConfigText(ctx: Ctx, fs: PlannerFs, p: string): Promise<TextRead> {
  const k = ctx.key(p);
  const hit = ctx.cache.texts.get(k);
  if (hit) return hit;
  const read = (async (): Promise<TextRead> => {
    try {
      const st = fs.stat ? await fs.stat(p) : undefined;
      if (st && !st.isFile) return "unreadable";
      if (st && Number(st.size) > CONFIG_SIZE_LIMIT) return "too-large";
      const text = await fs.readFile(p);
      return text.length > CONFIG_SIZE_LIMIT ? "too-large" : { text: text.replace(/^\uFEFF/, "") };
    } catch {
      return "unreadable";
    }
  })();
  ctx.cache.texts.set(k, read);
  return read;
}

function tooLarge(p: string): Unverifiable {
  return s6("config-too-large", `config file too large to read: ${p} (limit ${CONFIG_SIZE_LIMIT} bytes)`);
}

/** fileExists, cached per call (the pytest config walk probes the same names from several starts). */
function existsCached(ctx: Ctx, fs: FsSeam, p: string): Promise<boolean> {
  const k = ctx.key(p);
  let r = ctx.cache.exists.get(k);
  if (!r) {
    r = fs.fileExists(p);
    ctx.cache.exists.set(k, r);
  }
  return r;
}

/**
 * QA-1.3-51: `dir` holds an entry `name` (a file or a directory, as fileExists answers). With
 * PlannerFs.readdir each directory is listed once per plan; without it, or when the directory
 * cannot be listed, this is fileExists. A name the listing has only in another case (win32, or a
 * case-insensitive file system elsewhere) is confirmed with fileExists, so the answer stays the
 * one fileExists would give.
 */
async function hasEntry(ctx: Ctx, fs: PlannerFs, dir: string, name: string): Promise<boolean> {
  const p = ctx.P.join(dir, name);
  const l = await dirListing(ctx, fs, dir);
  if (l === undefined) return existsCached(ctx, fs, p);
  if (l.exact.has(name)) return true;
  return l.folded.has(name.toLowerCase()) && existsCached(ctx, fs, p);
}

/** QA-1.3-51: the cached PlannerFs.readdir listing of `dir`; undefined without readdir or when it rejects. */
function dirListing(ctx: Ctx, fs: PlannerFs, dir: string): Promise<DirListing | undefined> {
  const rd = fs.readdir;
  if (!rd) return Promise.resolve(undefined);
  const k = ctx.key(dir);
  let listing = ctx.cache.dirs.get(k);
  if (!listing) {
    listing = rd.call(fs, dir).then(
      (xs): DirListing => ({ exact: new Set(xs), folded: new Set(xs.map((x) => x.toLowerCase())) }),
      () => undefined,
    );
    ctx.cache.dirs.set(k, listing);
  }
  return listing;
}

function s6(code: S6Code, reason: string): Unverifiable {
  return { unverifiable: true, code, reason };
}

function noAffected(note: string): NoAffected {
  return { noAffected: true, note };
}

function isS6(x: object): x is Unverifiable {
  return isUnverifiable(x);
}

/** True when `abs` is `root` itself or lies below it (G.4 rules; win32 compares case-insensitively). */
function isInside(ctx: Ctx, root: string, abs: string): boolean {
  const rel = ctx.P.relative(root, abs);
  if (rel === "") return true;
  if (ctx.P.isAbsolute(rel)) return false;
  return rel.split(/[\\/]/)[0] !== "..";
}

/** Directories from `from` up to `root`, inclusive. Empty when `from` is not inside `root`. */
function ancestors(ctx: Ctx, from: string, root: string): string[] {
  if (!isInside(ctx, root, from)) return [];
  const out: string[] = [];
  let d = ctx.P.resolve(from);
  for (;;) {
    out.push(d);
    if (ctx.key(d) === ctx.key(ctx.P.resolve(root))) break;
    const parent = ctx.P.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return out;
}

function toSlash(ctx: Ctx, rel: string): string {
  return ctx.win ? rel.replace(/\\/g, "/") : rel;
}

async function findGitRoot(ctx: Ctx, cwd: string, fs: FsSeam): Promise<string | undefined> {
  let d = ctx.P.resolve(cwd);
  for (;;) {
    if (await fs.fileExists(ctx.P.join(d, ".git"))) return d;
    const parent = ctx.P.dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}

/**
 * G.3a (QA-1.3-19): a changed or rerun path as the producer spelled it, minus win32 spellings of
 * the same file: the prefixes (stripWinPrefix) and the unnamed data stream suffix `::$DATA`, which
 * writes the file itself. realpath resolves those too; this keeps lexical mode equal.
 */
function lexicalSpelling(ctx: Ctx, p: string): string {
  const q = stripWinPrefix(ctx, p);
  return ctx.win ? q.replace(/::\$DATA$/i, "") : q;
}

/** G.3a: drop the win32 `\\?\`, `\\.\` and `\\?\UNC\` prefixes (QA-1.3-7). Other platforms: unchanged. */
function stripWinPrefix(ctx: Ctx, p: string): string {
  if (!ctx.win) return p;
  if (/^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(p)) return `\\\\${p.slice(8)}`;
  if (/^[\\/]{2}[?.][\\/]/.test(p)) return p.slice(4);
  return p;
}

/**
 * G.3a (QA-1.3-1): the canonical spelling of the absolute path `p`, with symlinks, junctions and
 * 8.3 names resolved. A missing tail (a deleted file) is kept lexically below its nearest
 * existing ancestor. Without fs.realpath the result is `p` itself.
 */
async function realOf(ctx: Ctx, fs: PlannerFs, p: string): Promise<string> {
  const rp = fs.realpath;
  if (!rp) return p;
  const tail: string[] = [];
  let head = p;
  for (;;) {
    const real = await rp.call(fs, head).then(
      (x) => stripWinPrefix(ctx, x),
      () => undefined,
    );
    if (real !== undefined) return tail.length === 0 ? real : ctx.P.join(real, ...tail.reverse());
    const up = ctx.P.dirname(head);
    if (up === head) return p;
    tail.push(ctx.P.basename(head));
    head = up;
  }
}

/** An absolute, canonical directory for a caller-supplied cwd. */
async function canonicalCwd(ctx: Ctx, fs: PlannerFs, cwd: string): Promise<string> {
  return realOf(ctx, fs, ctx.P.resolve(stripWinPrefix(ctx, cwd)));
}

async function readJson(fs: FsSeam, path: string): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: JSON.parse(await fs.readFile(path)) as unknown };
  } catch {
    return { ok: false };
  }
}

/** JSON.parse, or undefined when the text does not parse (JSON itself has no undefined). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * QA-1.3-46: strip-json-comments 3, which jest-config runs before parsing a JSON config file: `//`
 * and `/* *\/` comments outside strings become whitespace, and an unterminated comment runs to the
 * end. A quote preceded by an odd number of backslashes does not end a string.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let from = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let k = i - 1;
      while (text[k] === "\\") k--;
      if ((i - 1 - k) % 2 === 0) inString = !inString;
      continue;
    }
    const n = text[i + 1];
    if (inString || c !== "/" || (n !== "/" && n !== "*")) continue;
    const close = text.indexOf(n === "/" ? "\n" : "*/", i + 2);
    const end = close < 0 ? text.length : n === "/" ? close : close + 2;
    out += text.slice(from, i) + text.slice(i, end).replace(/\S/g, " ");
    from = end;
    i = end - 1;
  }
  return out + text.slice(from);
}

/** jest-config's isJSONString: a `--config` value it parses as the config itself (QA-1.3-41). */
function isInlineJson(v: string): boolean {
  return v.startsWith("{") && v.endsWith("}");
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// ---------------------------------------------------------------------------------------------
// C. Script parsing
// ---------------------------------------------------------------------------------------------

/** C.1: POSIX-style subset. Returns undefined on an unterminated quote. */
function tokenize(s: string): string[] | undefined {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t") {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
    } else if (ch === '"') {
      has = true;
      i++;
      let closed = false;
      while (i < s.length) {
        if (s[i] === "\\" && s[i + 1] === '"') {
          cur += '"';
          i += 2;
        } else if (s[i] === '"') {
          closed = true;
          i++;
          break;
        } else {
          cur += s[i];
          i++;
        }
      }
      if (!closed) return undefined;
    } else if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return undefined;
      cur += s.slice(i + 1, end);
      has = true;
      i = end + 1;
    } else {
      cur += ch;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

const COMPOSITE_MULTI = ["&&", "||", "$("];
const COMPOSITE_SINGLE = new Set([";", "|", "&", ">", "<", "`", "$"]);
const PERCENT_VAR_RE = /%[A-Za-z_][A-Za-z0-9_]*%/y;

/** C.2: the first composite construct in the raw text (quotes ignored), or undefined. */
function findComposite(s: string): string | undefined {
  for (let i = 0; i < s.length; i++) {
    const two = s.slice(i, i + 2);
    if (COMPOSITE_MULTI.includes(two)) return two;
    const ch = s[i];
    if (ch === "\r" || ch === "\n") return "newline";
    if (COMPOSITE_SINGLE.has(ch)) return ch;
    if (ch === "%") {
      PERCENT_VAR_RE.lastIndex = i;
      const m = PERCENT_VAR_RE.exec(s);
      if (m) return m[0];
    }
  }
  return undefined;
}

const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

type Invocation<K extends ToolKind> =
  | { readonly type: "direct"; readonly kind: K; readonly launcher: Launcher; readonly env: Record<string, string>; readonly args: string[] }
  | {
      readonly type: "script";
      readonly manager: PackageManager;
      readonly name: string;
      readonly env: Record<string, string>;
      readonly extra: string[];
      readonly notes: string[];
    };

/** npm options between the script name and "--" that are safe to ignore (B, QA-1.3-6). */
const NPM_HARMLESS_RE = /^(?:-s|--silent|-q|--quiet|-d|--if-present|--ignore-scripts|--no-color|--color(?:=.*)?|--loglevel=.*)$/s;
/** pnpm/yarn/bun options that select another package or directory (QA-1.3-6). */
const PM_LOCATION_RE =
  /^(?:-w|-ws|-C|-F|-r|-g|--workspace|--workspaces|--include-workspace-root|--workspace-root|--prefix|--dir|--cwd|--filter|--recursive|--global)(?:=.*)?$/s;

function unsupported(prefix: string, where: string): Unverifiable {
  return s6("unsupported-command", `unsupported command "${prefix}" in ${where}`);
}

/** The runner heads a detection accepts: JS tools by bare name, plus pytest when `py` is set. */
interface Heads<K extends ToolKind> {
  readonly js: readonly K[];
  readonly py?: K & "pytest";
}
const TEST_HEADS: Heads<RunnerKind> = { js: ["vitest", "jest"], py: "pytest" };
const LINT_HEADS: Heads<"eslint"> = { js: ["eslint"] };

/** B step 2 + C.3: classify a token list. `allowScripts` is false inside a package script. */
function parseInvocation<K extends ToolKind>(
  tokens: readonly string[],
  where: string,
  allowScripts: boolean,
  heads: Heads<K>,
): Invocation<K> | Unverifiable {
  const env: Record<string, string> = {};
  let t = tokens;
  if (t[0] === "cross-env") {
    let i = 1;
    for (; i < t.length; i++) {
      const m = ASSIGN_RE.exec(t[i]);
      if (!m) break;
      env[m[1]] = m[2];
    }
    if (i >= t.length) return unsupported("cross-env", where);
    t = t.slice(i);
  }
  const h = t[0] ?? "";
  const inline = ASSIGN_RE.exec(h);
  if (inline) {
    return s6("inline-env", `inline environment assignment "${inline[1]}=" in ${where} (only cross-env is supported)`);
  }
  const direct = (kind: K, launcher: Launcher, args: string[]): Invocation<K> => ({ type: "direct", kind, launcher, env, args });
  const jsKind = (x: string | undefined): K | undefined => heads.js.find((k) => k === x);
  const hk = jsKind(h);
  if (hk) return direct(hk, "direct", t.slice(1));
  if (h === "pytest" && heads.py) return direct(heads.py, "direct", t.slice(1));
  if (h === "npx") {
    const r = jsKind(t[1]);
    return r ? direct(r, "npx", t.slice(2)) : unsupported(`npx ${t[1] ?? ""}`.trim(), where);
  }
  if (h === "uv") {
    if (t[1] === "run" && t[2] === "pytest" && heads.py) return direct(heads.py, "uv-run", t.slice(3));
    return unsupported(t[1] === "run" ? `uv run ${t[2] ?? ""}`.trim() : `uv ${t[1] ?? ""}`.trim(), where);
  }
  if (h === "pnpm" && t[1] === "exec") {
    const r = jsKind(t[2]);
    return r ? direct(r, "pnpm-exec", t.slice(3)) : unsupported(`pnpm exec ${t[2] ?? ""}`.trim(), where);
  }
  if (h !== "npm" && h !== "pnpm" && h !== "yarn" && h !== "bun") return unsupported(h, where);
  if (!allowScripts) return unsupported(h, where);

  const sub = t[1];
  const script = (name: string | undefined, rest: string[]): Invocation<K> | Unverifiable => {
    if (name === undefined) return unsupported(`${h} ${sub}`, where);
    if (h === "npm") {
      const dd = rest.indexOf("--");
      const ignored = dd < 0 ? rest : rest.slice(0, dd);
      // B (QA-1.3-6): only npm options that cannot pick another package, directory or script.
      const bad = ignored.find((x) => !NPM_HARMLESS_RE.test(x));
      if (bad !== undefined) return unsupported(`npm ${bad}`, where);
      const notes = ignored.length > 0 ? [`npm options ignored: ${ignored.join(" ")}`] : [];
      return { type: "script", manager: "npm", name, env, extra: dd < 0 ? [] : rest.slice(dd + 1), notes };
    }
    const location = rest[0] === "--" ? undefined : rest.find((x) => PM_LOCATION_RE.test(x));
    if (location !== undefined) return unsupported(`${h} ${location}`, where);
    return { type: "script", manager: h, name, env, extra: rest[0] === "--" ? rest.slice(1) : rest, notes: [] };
  };
  if (h === "npm") {
    if (sub === "test" || sub === "t") return script("test", t.slice(2));
    if (sub === "run" || sub === "run-script") return script(t[2], t.slice(3));
  } else if (h === "pnpm") {
    if (sub === "test" || sub === "t") return script("test", t.slice(2));
    if (sub === "run") return script(t[2], t.slice(3));
  } else if (h === "yarn") {
    if (sub === "test") return script("test", t.slice(2));
    if (sub === "run") return script(t[2], t.slice(3));
  } else {
    if (sub === "test") {
      return s6("bun-test", `"bun test" runs Bun's built-in test runner, not scripts.test (use "bun run test")`);
    }
    if (sub === "run") return script(t[2], t.slice(3));
  }
  return unsupported(`${h} ${sub ?? ""}`.trim(), where);
}

// ---------------------------------------------------------------------------------------------
// D. User arguments
// ---------------------------------------------------------------------------------------------

type Arity = "0" | "1" | "?" | "*";
type ArgAction = "drop" | "cap" | "cap1-keep" | "cap1-drop" | "keep" | "s6";
interface ArgEntry {
  readonly names: readonly string[];
  readonly action: ArgAction;
  readonly arity: Arity;
  readonly note?: string;
}

const COVERAGE_NOTE = "coverage disabled for the scoped run";
const EARLY_EXIT_NOTE = "early-exit option dropped for a full failure inventory";
const e = (names: string, action: ArgAction, arity: Arity, note?: string): ArgEntry => ({ names: names.split(" "), action, arity, note });

const VITEST_ARGS: readonly ArgEntry[] = [
  e("--run --watch -w --no-watch --ui --open --standalone --update -u --passWithNoTests --clearScreen --inspect --inspect-brk", "drop", "0"),
  e("--coverage --no-coverage", "drop", "0", COVERAGE_NOTE),
  e("--changed --api --mergeReports", "drop", "?"),
  e("--coverage.*", "drop", "?", COVERAGE_NOTE),
  e("--bail", "drop", "1", EARLY_EXIT_NOTE),
  e("--reporter --outputFile --outputFile.* --shard --minWorkers --min-workers --api.*", "drop", "1"),
  e("--maxWorkers --max-workers", "cap", "1"),
  e("--no-file-parallelism --fileParallelism=false", "cap1-keep", "0"),
  e("--config -c --root -r --dir --project --environment --pool --testNamePattern -t --mode --testTimeout --hookTimeout --teardownTimeout --retry --exclude --maxConcurrency --slowTestThreshold", "keep", "1"),
  e("--browser --sequence.* --typecheck.* --browser.*", "keep", "?"),
  e("--globals --dom --isolate --no-isolate --allowOnly --silent --hideSkippedTests --logHeapUsage --color --no-color --expandSnapshotDiff --disableConsoleIntercept --typecheck --printConsoleTrace --includeTaskLocation", "keep", "0"),
];

const JEST_ARGS: readonly ArgEntry[] = [
  e("--watch --watchAll --json --findRelatedTests --listTests --onlyChanged -o --lastCommit --changedFilesWithAncestor --updateSnapshot -u --passWithNoTests --runTestsByPath --onlyFailures -f", "drop", "0"),
  e("--coverage --collectCoverage --no-coverage", "drop", "0", COVERAGE_NOTE),
  e("--bail -b", "drop", "?", EARLY_EXIT_NOTE),
  e("--outputFile --changedSince --shard --collectCoverageFrom --coverageDirectory --coverageProvider --coverageThreshold", "drop", "1"),
  e("--reporters --coverageReporters --coveragePathIgnorePatterns", "drop", "*"),
  e("--maxWorkers --max-workers -w", "cap", "1"),
  e("--runInBand -i", "cap1-drop", "0"),
  e("--config -c --rootDir --testNamePattern -t --testEnvironment --env --testTimeout --testRunner --testSequencer --cacheDirectory --workerIdleMemoryLimit --seed --maxConcurrency --openHandlesTimeout", "keep", "1"),
  e("--roots --selectProjects --ignoreProjects --projects --testPathPatterns --testPathPattern --testPathIgnorePatterns --testMatch", "keep", "*"),
  e("--ci --silent --verbose --detectOpenHandles --detectLeaks --forceExit --cache --no-cache --colors --watchman --no-watchman --errorOnDeprecated --injectGlobals --noStackTrace --useStderr --workerThreads --randomize --showSeed --clearMocks --resetMocks --restoreMocks --expand -e --logHeapUsage", "keep", "0"),
  e("--showConfig --clearCache --init", "s6", "0"),
];

const PYTEST_ARGS: readonly ArgEntry[] = [
  e("-q --quiet --lf --last-failed --ff --failed-first --nf --new-first --sw --stepwise --sw-skip --stepwise-skip --cache-clear --pdb --trace -f --looponfail --cov-append --cov-branch --no-cov --no-cov-on-fail --self-contained-html --json-report", "drop", "0"),
  e("-x --exitfirst", "drop", "0", EARLY_EXIT_NOTE),
  e("--maxfail", "drop", "1", EARLY_EXIT_NOTE),
  e("--cov", "drop", "?"),
  e("--junitxml --junit-xml --pdbcls --cov-report --cov-config --cov-fail-under --cov-context --html --json-report-file", "drop", "1"),
  e("-n --numprocesses --maxprocesses", "cap", "1"),
  e("-k -m -c --config-file --rootdir -o --override-ini -W --pythonwarnings --tb -r --import-mode --basetemp --durations --durations-min --timeout --ignore --ignore-glob --deselect --confcutdir --dist --capture --log-level --log-cli-level", "keep", "1"),
  e("-v -vv --verbose -s -l --showlocals --strict-markers --strict-config --disable-warnings --no-header --runxfail", "keep", "0"),
  e("--co --collect-only --fixtures --fixtures-per-test --markers --setup-plan --setup-only --version -V -h --help --tx --rsyncdir", "s6", "0"),
];

const ESLINT_ARGS: readonly ArgEntry[] = [
  e("--fix --fix-dry-run --no-warn-ignored", "drop", "0"),
  e("--fix-type -o --output-file", "drop", "1"),
  e("--concurrency", "cap", "1"),
  e("-c --config --ext --parser --parser-options --resolve-plugins-relative-to --rulesdir --plugin --rule --env --global --ignore-path --ignore-pattern --cache-location --cache-strategy -f --format --max-warnings --report-unused-disable-directives-severity --flag", "keep", "1"),
  e("--cache --quiet --no-eslintrc --no-config-lookup --no-ignore --no-inline-config --report-unused-disable-directives --color --no-color --no-error-on-unmatched-pattern --exit-on-fatal-error --pass-on-no-patterns --stats --debug", "keep", "0"),
  e("--init --print-config --inspect-config --env-info -v --version -h --help --stdin --stdin-filename", "s6", "0"),
];

/**
 * D.0 (QA-1.3-10): yargs (jest) and cac (vitest) read `--kebab-case` as `--camelCase`. Both the
 * tables and the user tokens are compared in camelCase; "--no-" stays a negation prefix.
 */
function camelOption(t: string): string {
  if (!t.startsWith("--")) return t;
  const eq = t.indexOf("=");
  const name = eq < 0 ? t : t.slice(0, eq);
  const neg = name.startsWith("--no-") ? "--no-" : "--";
  return neg + name.slice(neg.length).replace(/-([A-Za-z0-9])/g, (_m, c: string) => c.toUpperCase()) + (eq < 0 ? "" : t.slice(eq));
}

const camelTable = (t: readonly ArgEntry[]): readonly ArgEntry[] => t.map((x) => ({ ...x, names: x.names.map(camelOption) }));

const ARG_TABLES: Record<ToolKind, readonly ArgEntry[]> = {
  vitest: camelTable(VITEST_ARGS),
  jest: camelTable(JEST_ARGS),
  pytest: PYTEST_ARGS,
  eslint: ESLINT_ARGS,
};

/**
 * D.0 (QA-1.3-3b, QA-1.3-10): short options per parser. `flags` take no value, `values` take one.
 *   mri (vitest/cac): every letter of a group is a flag except the last, which takes "=v" or the
 *                     next token; attached values ("-cfoo") do not exist.
 *   yargs (jest):     flags chain until a value letter; an attached value must be "=v" or a number.
 *   argparse (pytest): flags chain until a value letter, which takes the rest or the next token.
 */
const SHORT_GROUPS: Partial<Record<ToolKind, { readonly style: "mri" | "yargs" | "argparse"; readonly flags: string; readonly values: string }>> = {
  vitest: { style: "mri", flags: "wuhv", values: "crt" },
  jest: { style: "yargs", flags: "befhiouv", values: "ctw" },
  pytest: { style: "argparse", flags: "qvxslhVf", values: "kmcoWrpn" },
};

/**
 * Split a grouped short-option token the way the runner's parser does: `-qn3` -> `-q -n3`,
 * `-ou` -> `-o -u`. Returns [t] when t is not a group, undefined for a group the adapter cannot
 * model (an unknown letter, or an attached value the parser would read differently) -> S6.
 */
function expandShort(kind: ToolKind, t: string): string[] | undefined {
  const g = SHORT_GROUPS[kind];
  if (!g || t.startsWith("--") || !/^-[A-Za-z]./s.test(t)) return [t];
  const yargsValue = (rest: string) => g.style !== "yargs" || rest === "" || /^(?:=.*|-?\d+(?:\.\d*)?)$/s.test(rest);
  if (g.style === "mri") {
    const eq = t.indexOf("=");
    const letters = t.slice(1, eq < 0 ? undefined : eq);
    const out: string[] = [];
    for (let i = 0; i < letters.length; i++) {
      const c = letters[i];
      const last = i === letters.length - 1;
      if (!g.flags.includes(c) && !(last && g.values.includes(c))) return undefined;
      out.push(last && eq >= 0 ? `-${c}${t.slice(eq)}` : `-${c}`);
    }
    return out;
  }
  if (g.values.includes(t[1])) return yargsValue(t.slice(2)) ? [t] : undefined;
  const out: string[] = [];
  for (let i = 1; i < t.length; i++) {
    const c = t[i];
    if (g.values.includes(c)) {
      const rest = t.slice(i + 1);
      if (!yargsValue(rest)) return undefined;
      out.push(`-${c}${rest}`);
      return out;
    }
    if (!g.flags.includes(c)) return undefined;
    out.push(`-${c}`);
  }
  return out;
}

interface ArgMatch {
  readonly entry: ArgEntry;
  readonly name: string;
  /** The value was attached ("--x=v", "-xV"): arity is ignored. */
  readonly inline: boolean;
  readonly value?: string;
}

function matchArg(table: readonly ArgEntry[], t: string): ArgMatch | undefined {
  for (const entry of table) {
    for (const name of entry.names) {
      if (name.endsWith(".*")) {
        const p = name.slice(0, -1);
        if (t.startsWith(p) && t.length > p.length) {
          const eq = t.indexOf("=");
          return { entry, name, inline: eq >= 0, value: eq >= 0 ? t.slice(eq + 1) : undefined };
        }
      } else if (t === name) {
        return { entry, name, inline: false };
      } else if (t.startsWith(`${name}=`)) {
        return { entry, name, inline: true, value: t.slice(name.length + 1) };
      }
    }
  }
  for (const entry of table) {
    if (entry.arity !== "1") continue;
    for (const name of entry.names) {
      if (/^-[A-Za-z]$/.test(name) && t.startsWith(name) && t.length > 2) {
        return { entry, name, inline: true, value: t.slice(2) };
      }
    }
  }
  return undefined;
}

/** Section E: parse a user worker-cap value for one tool. undefined means invalid. */
function parseCap(kind: ToolKind, raw: string): UserWorkerCap | undefined {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return undefined;
    if (n === 0 && kind !== "pytest") return undefined;
    return { count: n };
  }
  const pm = /^(\d{1,3})%$/.exec(raw);
  if (pm && (kind === "vitest" || kind === "jest")) {
    const p = Number(pm[1]);
    return p >= 1 && p <= 100 ? { percent: p } : undefined;
  }
  if (kind === "pytest" && (raw === "auto" || raw === "logical")) return { auto: true };
  if (kind === "eslint" && raw === "auto") return { auto: true };
  return undefined;
}

/**
 * QA-1.3-48: the PYTEST_ARGS options with a value that come from plugins (pytest-cov, pytest-html,
 * pytest-json-report, xdist, pytest-timeout). pytest does not know them yet when it picks its
 * config, so their separate values are free arguments there. Every other option with a value in
 * PYTEST_ARGS is builtin (-k, -m, -c, --rootdir, -o, -p, --junitxml, --confcutdir, ...).
 */
const PY_PLUGIN_VALUE_OPTIONS: ReadonlySet<string> = new Set(
  "--cov --cov-report --cov-config --cov-fail-under --cov-context --html --json-report-file -n --numprocesses --maxprocesses --timeout --dist".split(" "),
);

const PY_SCOPE_BAD_RE = /::|[*?[\]{}]/;
const ESLINT_GLOB_RE = /[*?[\]{}]/;

interface ArgResult {
  readonly kept: string[];
  readonly capRaw: string | undefined;
  readonly userWorkers: UserWorkerCap | undefined;
  readonly pathScopes: string[];
  readonly noXdist: boolean;
  readonly xdistArg: boolean;
  /** pytest: a --cov option was seen (D.4). */
  readonly cov: boolean;
  /** The raw values of the config-file options (D.1 config values). */
  readonly configs: string[];
  /** pytest: the value of `-o addopts=<v>`. */
  readonly overrideAddopts: string | undefined;
  /** pytest: the values of every `-o python_files=<v>` (QA-1.3-33). */
  readonly overridePythonFiles: string[];
  /** pytest: a `-o testpaths=<v>` or `--pyargs` was seen, so the config's testpaths do not decide collection (G.8b). */
  readonly collectOverride: boolean;
  /** pytest: the last `--rootdir` value (QA-1.3-40: it turns off the per-argument config fallback). */
  readonly rootdir: string | undefined;
  /** pytest: the free arguments of pytest's config lookup, in order (QA-1.3-48). */
  readonly early: PytestFreeArg[];
  readonly notes: string[];
}

interface ArgOptions {
  /**
   * The tokens come from addopts or PYTEST_ADDOPTS (D.4, QA-1.3-13): a positional -> S6, and an
   * unknown option's next token is taken as its value unless it names an existing path (S6).
   */
  readonly addopts?: { readonly exists: (abs: string) => Promise<boolean> };
}

/** The options whose value is a config file (D.1 config values, QA-1.3-5). */
const CONFIG_OPTIONS: Record<ToolKind, readonly string[]> = {
  vitest: ["--config", "-c"],
  jest: ["--config", "-c"],
  pytest: ["-c", "--config-file"],
  eslint: ["-c", "--config"],
};

/** D.1 for vitest, jest, pytest and eslint. */
async function processArgs(
  ctx: Ctx,
  kind: ToolKind,
  input: readonly string[],
  where: string,
  runnerCwd: string,
  gitRoot: string,
  opts: ArgOptions = {},
): Promise<ArgResult | Unverifiable> {
  const table = ARG_TABLES[kind];
  const camel = kind === "vitest" || kind === "jest";
  const args = [...input];
  const kept: string[] = [];
  const notes = new Set<string>();
  const filters: string[] = [];
  const pathScopes: string[] = [];
  const configs: string[] = [];
  let capRaw: string | undefined;
  let noXdist = false;
  let xdistArg = false;
  let cov = false;
  let overrideAddopts: string | undefined;
  const overridePythonFiles: string[] = [];
  let collectOverride = false;
  let rootdir: string | undefined;
  const early: PytestFreeArg[] = [];
  let firstPositional = true;
  const badArg = (t: string) => s6("unsupported-argument", `unsupported ${kind} argument "${t}" in ${where}`);

  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "--") return badArg(t);
    const parts = expandShort(kind, t);
    if (!parts) return badArg(t);
    if (parts.length !== 1 || parts[0] !== t) {
      args.splice(i, 1, ...parts);
      i--;
      continue;
    }
    if (kind === "pytest" && t.startsWith("-p") && !t.startsWith("--")) {
      const attached = t.length > 2;
      const value = attached ? t.slice(2) : args[i + 1];
      if (value === "no:cacheprovider") {
        if (!attached) i++;
        continue;
      }
      if (value === "no:xdist") noXdist = true;
      kept.push(t);
      if (!attached && value !== undefined) {
        kept.push(value);
        i++;
      }
      continue;
    }
    const m = matchArg(table, camel ? camelOption(t) : t);
    if (m) {
      const values: string[] = [];
      if (!m.inline) {
        if (m.entry.arity === "1") {
          if (i + 1 < args.length) values.push(args[i + 1]);
        } else if (m.entry.arity === "?") {
          if (i + 1 < args.length && !args[i + 1].startsWith("-")) values.push(args[i + 1]);
        } else if (m.entry.arity === "*") {
          for (let j = i + 1; j < args.length && !args[j].startsWith("-"); j++) values.push(args[j]);
        }
      }
      i += values.length;
      if (m.entry.note) notes.add(m.entry.note);
      if (m.name === "--dist") xdistArg = true;
      if (m.name === "--cov") cov = true;
      const value = m.inline ? m.value : values[0];
      if (value !== undefined && CONFIG_OPTIONS[kind].includes(m.name)) configs.push(value);
      if (kind === "pytest" && (m.name === "-o" || m.name === "--override-ini") && value !== undefined) {
        if (value.startsWith("addopts=")) overrideAddopts = value.slice("addopts=".length);
        if (value.startsWith("python_files=")) overridePythonFiles.push(value.slice("python_files=".length));
        if (value.startsWith("testpaths=")) collectOverride = true;
      }
      if (kind === "pytest" && m.name === "--rootdir" && value !== undefined) rootdir = value;
      if (kind === "pytest" && PY_PLUGIN_VALUE_OPTIONS.has(m.name)) {
        // QA-1.3-48: get_dirs_from_args skips option-like tokens and drops a node id's "::" part.
        for (const v of values) {
          if (!v.startsWith("-")) early.push({ path: ctx.P.resolve(runnerCwd, v.split("::")[0]), plugin: true, kept: m.entry.action === "keep" });
        }
      }
      switch (m.entry.action) {
        case "drop":
          break;
        case "cap": {
          const raw = m.inline ? (m.value ?? "") : (values[0] ?? "");
          if (kind === "eslint" && raw === "off") {
            kept.push(t, ...values);
            break;
          }
          capRaw = raw;
          xdistArg = true;
          break;
        }
        case "cap1-keep":
          kept.push(t);
          capRaw = "1";
          break;
        case "cap1-drop":
          capRaw = "1";
          break;
        case "keep":
          kept.push(t, ...values);
          break;
        case "s6":
          return badArg(t);
      }
      continue;
    }
    if (t.startsWith("-")) {
      // D.1 g (QA-1.3-10): an option the vitest/jest tables do not know fails closed.
      if (camel) return badArg(t);
      const next = args[i + 1];
      if (t.includes("=") || next === undefined || next.startsWith("-")) {
        kept.push(t);
        continue;
      }
      if (opts.addopts) {
        // Either reading is safe: a path is S6 here, and a missing path makes pytest exit 4.
        if (await opts.addopts.exists(ctx.P.resolve(runnerCwd, next))) return badArg(next);
        kept.push(t, next);
        i++;
        continue;
      }
      return s6("ambiguous-option", `ambiguous ${kind} option "${t}" in ${where}: cannot tell whether "${next}" is its value`);
    }
    // Positional. In addopts it would widen the run to a directory or file (QA-1.3-13).
    if (opts.addopts) return badArg(t);
    const first = firstPositional;
    firstPositional = false;
    if (kind === "vitest") {
      if (first && ["run", "watch", "dev", "related"].includes(t)) continue;
      if (first && ["bench", "list", "init", "typecheck"].includes(t)) {
        return s6("unsupported-subcommand", `unsupported vitest subcommand "${t}" in ${where}`);
      }
      filters.push(t);
    } else if (kind === "jest") {
      filters.push(t);
    } else {
      if (kind === "eslint" && ESLINT_GLOB_RE.test(t)) return s6("unsupported-argument", `eslint glob pattern in ${where}: "${t}"`);
      const abs = ctx.P.resolve(runnerCwd, t);
      if (PY_SCOPE_BAD_RE.test(t) || !isInside(ctx, gitRoot, abs)) return badArg(t);
      pathScopes.push(abs);
      if (kind === "pytest") early.push({ path: abs, plugin: false, kept: true });
    }
  }
  if (filters.length > 0) notes.add(`${kind} filters dropped: ${filters.join(", ")}`);
  let userWorkers: UserWorkerCap | undefined;
  if (capRaw !== undefined) {
    userWorkers = parseCap(kind, capRaw);
    if (!userWorkers) notes.add(`invalid worker cap "${capRaw}" ignored`);
  }
  // G.8b: with --pyargs pytest reads testpaths (and positionals) as module names.
  if (kind === "pytest" && kept.includes("--pyargs")) collectOverride = true;
  return { kept, capRaw, userWorkers, pathScopes, noXdist, xdistArg, cov, configs, overrideAddopts, overridePythonFiles, collectOverride, rootdir, early, notes: [...notes] };
}

// ---------------------------------------------------------------------------------------------
// D.4 pytest configuration (QA-1.3-3, QA-1.3-13)
// ---------------------------------------------------------------------------------------------

/**
 * pytest's inifile names per release line, each in its search order (_pytest/config/findpaths.py
 * locate_config). QA-1.3-21: pytest 8 does not know pytest.toml/.pytest.toml or the native
 * [tool.pytest] table, and pytest 7.0 does not know .pytest.ini either, so an older pytest reads
 * a file that pytest 9 never reaches. The adapter cannot tell which pytest will run, so it reads
 * the file every line would pick and takes the union of the evidence.
 */
const PYTEST_CONFIG_LINES: readonly { readonly names: readonly string[]; readonly legacy: boolean }[] = [
  { names: ["pytest.toml", ".pytest.toml", "pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"], legacy: false },
  { names: ["pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"], legacy: true },
  { names: ["pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"], legacy: true },
];

/**
 * The pytest ini keys the adapter reads (D.4): addopts (QA-1.3-3), python_files (QA-1.3-33) and
 * testpaths (G.8b, E2E-1). An unreadable testpaths is never S6: it only narrows test inputs, so it
 * is dropped (the run is then taken to collect from runnerCwd, which only ever adds inputs).
 */
const PY_KEYS = ["addopts", "python_files", "testpaths"] as const;
type PyKey = (typeof PY_KEYS)[number];

interface ConfigValues {
  readonly addopts?: readonly string[];
  readonly pythonFiles?: readonly string[];
  readonly testpaths?: readonly string[];
}

/**
 * undefined: not a pytest config (pytest skips it). `bad` names what is present but not understood:
 * "addopts" or "python_files" (an unreadable value, or a TOML spelling other than the bare key
 * under its table), or a raw TOML key or header whose escapes do not decode.
 */
type ConfigParse = { readonly values: ConfigValues; readonly bad: readonly string[] } | undefined;

/**
 * One config file by pytest's per-format rules. `explicit` (-c) files always count. `legacy`
 * reads a TOML file the way pytest 7/8 do: [tool.pytest.ini_options] only, and pytest.toml is not
 * a native config there.
 */
function parsePytestConfig(ctx: Ctx, file: string, text: string, explicit: boolean, legacy: boolean): ConfigParse {
  const base = ctx.P.basename(file);
  let raw: Partial<Record<PyKey, string | readonly string[]>>;
  const bad: string[] = [];
  if (ctx.P.extname(base) === ".toml") {
    const own = !legacy && (base === "pytest.toml" || base === ".pytest.toml");
    const r = tomlPytest(text, own ? ["pytest"] : legacy ? ["tool.pytest.ini_options"] : ["tool.pytest.ini_options", "tool.pytest"]);
    if (r.bad.length === 0 && !r.found && !own && !explicit) return undefined;
    raw = r.values;
    bad.push(...r.bad);
  } else {
    const r = iniPytest(text, ctx.P.extname(base) === ".cfg" ? "tool:pytest" : "pytest");
    if (!r.found && base !== "pytest.ini" && base !== ".pytest.ini" && !explicit) return undefined;
    raw = r.values;
  }
  const values: { addopts?: readonly string[]; pythonFiles?: readonly string[]; testpaths?: readonly string[] } = {};
  for (const k of PY_KEYS) {
    const v = raw[k];
    if (v === undefined || bad.includes(k)) continue;
    // A string is split like pytest's shlex (ini values, TOML strings); a TOML array is taken as is.
    const tokens = typeof v === "string" ? tokenize(v.replace(/\r?\n/g, " ")) : v;
    if (tokens === undefined) bad.push(k);
    else if (k === "addopts") values.addopts = tokens;
    else if (k === "python_files") values.pythonFiles = tokens;
    else values.testpaths = tokens;
  }
  // G.8b: an unreadable testpaths is dropped, never S6 (see PY_KEYS).
  return { values, bad: bad.filter((b) => b !== "testpaths") };
}

/**
 * iniconfig rules: `[section]` at column 0, indented continuation lines, # and ; comment lines, and
 * `key = value` or `key: value` with optional whitespace (QA-1.3-31: `addopts:-n 3` is read). A
 * line splits on its first "=" unless the name before it contains ":", otherwise on its first ":".
 */
function iniPytest(text: string, section: string): { found: boolean; values: Partial<Record<PyKey, string>> } {
  let current: string | undefined;
  let found = false;
  let key: string | undefined;
  const values: Partial<Record<PyKey, string>> = {};
  const pyKey = (k: string | undefined): PyKey | undefined => PY_KEYS.find((x) => x === k);
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (/^\s*[#;]/.test(line) || line.trim() === "") continue;
    if (line.startsWith("[")) {
      const head = line.replace(/[#;].*$/, "").trimEnd();
      current = head.endsWith("]") ? head.slice(1, -1) : undefined;
      if (current === section) found = true;
      key = undefined;
    } else if (/^\s/.test(line)) {
      const k = pyKey(key);
      if (current === section && k) values[k] = `${values[k] ?? ""}\n${line.trim()}`;
    } else {
      const kv = iniSplit(line);
      key = kv?.[0];
      const k = pyKey(key);
      if (kv && current === section && k) values[k] = kv[1];
    }
  }
  return { found, values };
}

/** iniconfig's name/value split (QA-1.3-31). undefined: neither "=" nor ":" (iniconfig rejects the line). */
function iniSplit(line: string): [string, string] | undefined {
  const eq = line.indexOf("=");
  if (eq >= 0 && !line.slice(0, eq).includes(":")) return [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
  const colon = line.indexOf(":");
  return colon < 0 ? undefined : [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
}

const TOML_HEADER_RE = /^[ \t]*(\[\[?)([^\]\r\n]*)\]\]?[ \t]*(?:#.*)?\r?$/;
const TOML_KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')`;
const TOML_KEY_RE = new RegExp(String.raw`^[ \t]*(${TOML_KEY_PART}(?:[ \t]*\.[ \t]*${TOML_KEY_PART})*)[ \t]*=[ \t]*`);
const TOML_PART_RE = new RegExp(String.raw`[ \t]*(${TOML_KEY_PART})[ \t]*(?:\.|$)`, "y");
const TOML_ARRAY_GAP_RE = /(?:[\s,]|#[^\n]*)*/y;

/**
 * QA-1.3-31: a dotted TOML key or header, split into DECODED parts, so `"add\u006fpts"` and
 * `tool."py\u0074est"` compare equal to what pytest's TOML parser reads. []: not a key path (a
 * shell test such as `[[ -n "$X" ]]` inside a string, say); "bad": a quoted part whose escapes do
 * not decode.
 */
function tomlKeyParts(s: string): string[] | "bad" {
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    TOML_PART_RE.lastIndex = i;
    const m = TOML_PART_RE.exec(s);
    if (!m || m[0] === "") return [];
    const raw = m[1];
    if (raw.startsWith('"')) {
      const d = tomlString(raw, 0);
      if (!d) return "bad";
      out.push(d.value);
    } else {
      out.push(raw.startsWith("'") ? raw.slice(1, -1) : raw);
    }
    i = TOML_PART_RE.lastIndex;
  }
  return out;
}

const startsWithPath = (path: readonly string[], prefix: readonly string[]) => prefix.length <= path.length && prefix.every((p, i) => path[i] === p);
const samePath = (a: readonly string[], b: readonly string[]) => a.length === b.length && startsWithPath(a, b);

/**
 * D.4 (QA-1.3-20, QA-1.3-31): the pytest keys (PY_KEYS) of the first matching TOML table, in one
 * pass over the lines. Headers and keys are compared by their decoded parts. Only a bare key
 * directly below a [table] header from `tables` is read, as a string or an array of strings; the
 * same key reached any other way (a dotted key, a quoted key, an inline table on the way, an array
 * table, a second occurrence) is `bad`, and so is an undecodable quoted part anywhere. Each value is
 * skipped as a whole, so a header inside a multi-line string is not a header. `found`: some header
 * or key path outside an array table lies in a table from `tables` (pytest then accepts the file
 * as its config); a dotted key such as `tool.pytest.ini_options.markers` defines the table too.
 */
function tomlPytest(text: string, tables: readonly string[]): { found: boolean; values: Partial<Record<PyKey, string | readonly string[]>>; bad: string[] } {
  const tabs = tables.map((t) => t.split("."));
  const targets = PY_KEYS.flatMap((key) => tabs.map((t) => ({ key, table: t, path: [...t, key] })));
  const values: Partial<Record<PyKey, string | readonly string[]>> = {};
  const bad = new Set<string>();
  let found = false;
  let table: readonly string[] | undefined = [];
  let array = false;
  for (let pos = 0; pos < text.length; ) {
    let eol = text.indexOf("\n", pos);
    if (eol < 0) eol = text.length;
    const line = text.slice(pos, eol);
    const h = TOML_HEADER_RE.exec(line);
    const m = h ?? TOML_KEY_RE.exec(line);
    let next = eol + 1;
    if (m) {
      const raw = m[h ? 2 : 1];
      const parts = tomlKeyParts(raw);
      if (parts === "bad") {
        bad.add(raw.trim());
      } else if (h) {
        // A header that is not a key path (text inside a string) belongs to no table.
        table = parts.length > 0 ? parts : undefined;
        array = h[1] === "[[";
        if (!array && tabs.some((t) => startsWithPath(parts, t))) found = true;
      } else {
        const vStart = pos + m[0].length;
        let end = tomlSkipValue(text, vStart);
        if (table) {
          const full = [...table, ...parts];
          if (!array && tabs.some((t) => startsWithPath(full, t))) found = true;
          for (const t of targets) {
            if (!array && parts.length === 1 && parts[0] === t.key && samePath(table, t.table)) {
              // A second occurrence (the same key in two pytest tables) is a TOML or pytest error.
              const v = values[t.key] === undefined ? tomlValue(text, vStart) : undefined;
              if (v) {
                values[t.key] = v.value;
                end = v.end;
              } else bad.add(t.key);
            } else if (samePath(full, t.path) || (text[vStart] === "{" && t.path.length > full.length && startsWithPath(t.path, full))) {
              bad.add(t.key);
            }
          }
        }
        if (end > eol) next = end;
      }
    }
    pos = next;
  }
  return { found, values, bad: [...bad] };
}

/** The end of the TOML value starting at s[i] (a string, an array or inline table with nesting, or the rest of the line). */
function tomlSkipValue(s: string, i: number): number {
  const lineEnd = (j: number) => {
    const n = s.indexOf("\n", j);
    return n < 0 ? s.length : n;
  };
  if (s[i] === '"' || s[i] === "'") return tomlStringEnd(s, i) ?? lineEnd(i);
  if (s[i] !== "[" && s[i] !== "{") return lineEnd(i);
  let depth = 0;
  for (let j = i; j < s.length; ) {
    const c = s[j];
    if (c === '"' || c === "'") {
      const end = tomlStringEnd(s, j);
      if (end === undefined) return lineEnd(j);
      j = end;
      continue;
    }
    if (c === "#") {
      j = lineEnd(j);
      continue;
    }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return s.length;
}

/** The end of any TOML string (basic, literal, or their multi-line forms) starting at s[i]; undefined when unterminated. */
function tomlStringEnd(s: string, i: number): number | undefined {
  const q = s[i];
  const q3 = q.repeat(3);
  const multi = s.startsWith(q3, i);
  for (let j = i + (multi ? 3 : 1); j < s.length; j++) {
    const c = s[j];
    if (q === '"' && c === "\\") {
      j++;
      continue;
    }
    if (!multi && (c === "\n" || c === "\r")) return undefined;
    if (!multi && c === q) return j + 1;
    if (multi && s.startsWith(q3, j)) {
      // Up to two more quotes belong to the content ("""a"""" is `a"`).
      let k = j + 3;
      while (k < j + 5 && s[k] === q) k++;
      return k;
    }
  }
  return undefined;
}

const TOML_ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };

/** A TOML string or array of strings at s[i], with the index after it; undefined for anything else. */
function tomlValue(s: string, i: number): { value: string | string[]; end: number } | undefined {
  if (s.startsWith('"""', i) || s.startsWith("'''", i)) {
    const q = s.slice(i, i + 3);
    const end = s.indexOf(q, i + 3);
    if (end < 0) return undefined;
    const raw = s.slice(i + 3, end).replace(/^\r?\n/, "");
    return q === '"""' && raw.includes("\\") ? undefined : { value: raw, end: end + 3 };
  }
  if (s[i] === '"' || s[i] === "'") return tomlString(s, i);
  if (s[i] !== "[") return undefined;
  const out: string[] = [];
  for (let j = i + 1; ; ) {
    TOML_ARRAY_GAP_RE.lastIndex = j;
    j += TOML_ARRAY_GAP_RE.exec(s)?.[0].length ?? 0;
    if (s[j] === "]") return { value: out, end: j + 1 };
    const str = tomlString(s, j);
    if (!str) return undefined;
    out.push(str.value);
    j = str.end;
  }
}

/** A single-line TOML basic ("...") or literal ('...') string starting at s[i]. */
function tomlString(s: string, i: number): { value: string; end: number } | undefined {
  if (s[i] === "'") {
    const end = s.indexOf("'", i + 1);
    if (end < 0 || s.slice(i + 1, end).includes("\n")) return undefined;
    return { value: s.slice(i + 1, end), end: end + 1 };
  }
  if (s[i] !== '"') return undefined;
  let value = "";
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '"') return { value, end: j + 1 };
    if (c === "\n") return undefined;
    if (c !== "\\") {
      value += c;
      continue;
    }
    const n = s[j + 1] ?? "";
    const simple = Object.hasOwn(TOML_ESCAPES, n) ? TOML_ESCAPES[n] : undefined;
    if (simple !== undefined) {
      value += simple;
      j++;
      continue;
    }
    const len = n === "u" ? 4 : n === "U" ? 8 : 0;
    const hex = s.slice(j + 2, j + 2 + len);
    const cp = len > 0 && hex.length === len && /^[0-9a-fA-F]+$/.test(hex) ? Number.parseInt(hex, 16) : -1;
    if (!isXmlCodePoint(cp)) return undefined;
    value += String.fromCodePoint(cp);
    j += 1 + len;
  }
  return undefined;
}

interface PytestConfig extends ConfigValues {
  readonly path: string;
}

/**
 * QA-1.3-43: pytest's determine_setup (_pytest/config/findpaths.py) per release. `line` indexes
 * PYTEST_CONFIG_LINES. `pyproject`: when no file is accepted, the first pyproject.toml seen still
 * becomes the inifile (with no ini values) and sets the rootdir (pytest >= 8.1). Read in pytest
 * 7.0.0, 7.4.4, 8.0.0, 8.1.0 and 9.1.1: every one of them takes the -c file's directory as the
 * rootdir, runs locate_config from the arguments' common ancestor, and skips the setup.py rule and
 * the per-argument fallback when --rootdir is given.
 */
const PYTEST_SETUPS: readonly { readonly line: number; readonly pyproject: boolean }[] = [
  { line: 0, pyproject: true }, // pytest 9
  { line: 1, pyproject: true }, // pytest 8.1 - 8.4
  { line: 1, pyproject: false }, // pytest 8.0, and 7.x with .pytest.ini
  { line: 2, pyproject: false }, // pytest 7.0
];

/** What one pytest release reads for a run (QA-1.3-43). */
interface PytestSetup {
  /** The inifile: an accepted config, or (pytest >= 8.1) a table-less pyproject.toml. */
  readonly inipath?: string;
  /** The ini values, when the inifile is an accepted config. */
  readonly config?: PytestConfig;
  /** The rootdir; undefined when the run gives --rootdir (pytest then takes that value). */
  readonly rootdir?: string;
}

/**
 * One pytest config file by one release's rules (QA-1.3-21): the parse, undefined when that release
 * skips the file, "unreadable" (noted), or S6 for a file over CONFIG_SIZE_LIMIT (QA-1.3-34) or a
 * `bad` key some pytest reads, unless it is in `ignore` (overridden with -o). Files are read and
 * parsed once per call (ctx.cache).
 */
async function loadPytestConfig(
  ctx: Ctx,
  fs: PlannerFs,
  p: string,
  explicit: boolean,
  legacy: boolean,
  notes: string[],
  ignore: ReadonlySet<string>,
): Promise<ConfigParse | "unreadable" | Unverifiable> {
  const t = await readConfigText(ctx, fs, p);
  if (t === "too-large") return tooLarge(p);
  if (t === "unreadable") {
    const n = `unreadable pytest config ignored: ${p}`;
    if (!notes.includes(n)) notes.push(n);
    return "unreadable";
  }
  const pk = `${ctx.key(p)}\0${explicit}\0${legacy}`;
  if (!ctx.cache.parsed.has(pk)) ctx.cache.parsed.set(pk, parsePytestConfig(ctx, p, t.text, explicit, legacy));
  const r = ctx.cache.parsed.get(pk);
  const bad = r?.bad.find((b) => !ignore.has(b));
  return bad === undefined ? r : s6("unsupported-argument", `unsupported pytest argument "${bad}" in ${p}`);
}

/**
 * locate_config for one release: from each of `args` in order up to the filesystem root (above
 * gitRoot too, as pytest does), or up to `stop` exclusive, the first accepted file; failing that,
 * for pytest >= 8.1, the first pyproject.toml seen (no ini values).
 */
async function locateConfig(
  ctx: Ctx,
  fs: PlannerFs,
  setup: (typeof PYTEST_SETUPS)[number],
  args: readonly string[],
  stop: string | undefined,
  notes: string[],
  ignore: ReadonlySet<string>,
): Promise<PytestSetup | Unverifiable> {
  const { names, legacy } = PYTEST_CONFIG_LINES[setup.line];
  let pyproject: string | undefined;
  for (const a of args) {
    for (let d = a; stop === undefined || ctx.key(d) !== ctx.key(stop); ) {
      for (const name of names) {
        const p = ctx.P.join(d, name);
        if (!(await existsCached(ctx, fs, p))) continue;
        const r = await loadPytestConfig(ctx, fs, p, false, legacy, notes, ignore);
        if (r === "unreadable") continue;
        if (r !== undefined && isS6(r)) return r;
        if (r !== undefined) return { inipath: p, config: { path: p, ...r.values }, rootdir: d };
        if (name === "pyproject.toml") pyproject ??= p;
      }
      const up = ctx.P.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return setup.pyproject && pyproject !== undefined ? { inipath: pyproject, rootdir: ctx.P.dirname(pyproject) } : {};
}

/** The deepest directory holding every path in `paths` (pytest's get_common_ancestor over directories). */
function commonPath(ctx: Ctx, paths: readonly string[]): string {
  let dir = paths[0];
  for (const p of paths) {
    while (!isInside(ctx, dir, p)) {
      const up = ctx.P.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return dir;
}

/** The first directory from `from` up to the filesystem root holding a file `name` (stat, when present, must say file). */
async function dirWithFile(ctx: Ctx, fs: PlannerFs, from: string, name: string): Promise<string | undefined> {
  for (let d = from; ; ) {
    const p = ctx.P.join(d, name);
    if ((await existsCached(ctx, fs, p)) && (await statOf(fs, p))?.isFile !== false) return d;
    const up = ctx.P.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

/**
 * QA-1.3-43: determine_setup for every release (PYTEST_SETUPS order): the inifile, its values and
 * the rootdir of a pytest run with the path arguments `args` in `cwd`.
 *   - `explicit` (-c/--config-file): that file for every release, read in its format (always a
 *     config), with its directory as the rootdir.
 *   - Otherwise locate_config from the arguments' common ancestor (cwd without arguments). When it
 *     finds nothing and no --rootdir is given: a setup.py at or above the ancestor is the rootdir;
 *     else, when the argument directories are not just the ancestor, locate_config runs again from
 *     each argument in order (QA-1.3-40), stopping below the ancestor, which the first walk already
 *     covered (QA-1.3-47); else the rootdir is the common ancestor of cwd and the ancestor (the
 *     ancestor itself when that is a filesystem root).
 * A file argument is walked from itself, which finds what its directory finds. pytest skips an
 * argument that does not exist (get_dirs_from_args) and then fails the run with exit 4; the model
 * keeps it.
 */
async function pytestSetups(
  ctx: Ctx,
  fs: PlannerFs,
  explicit: string | undefined,
  args: readonly string[],
  cwd: string,
  rootdirGiven: boolean,
  notes: string[],
  ignore: ReadonlySet<string>,
): Promise<PytestSetup[] | Unverifiable> {
  const out: PytestSetup[] = [];
  const rooted = (s: PytestSetup): PytestSetup =>
    rootdirGiven ? { ...(s.inipath !== undefined ? { inipath: s.inipath } : {}), ...(s.config ? { config: s.config } : {}) } : s;
  if (explicit !== undefined) {
    for (const v of PYTEST_SETUPS) {
      const r = await loadPytestConfig(ctx, fs, explicit, true, PYTEST_CONFIG_LINES[v.line].legacy, notes, ignore);
      if (r !== "unreadable" && r !== undefined && isS6(r)) return r;
      const config = r === "unreadable" || r === undefined ? undefined : { path: explicit, ...r.values };
      out.push(rooted({ inipath: explicit, ...(config ? { config } : {}), rootdir: ctx.P.dirname(explicit) }));
    }
    return out;
  }
  const dirs = args;
  const ancestor = dirs.length === 0 ? cwd : commonPath(ctx, dirs);
  for (const v of PYTEST_SETUPS) {
    let s = await locateConfig(ctx, fs, v, [ancestor], undefined, notes, ignore);
    if (isS6(s)) return s;
    if (s.inipath === undefined && !rootdirGiven) {
      const setupPy = await dirWithFile(ctx, fs, ancestor, "setup.py");
      if (setupPy !== undefined) {
        s = { rootdir: setupPy };
      } else {
        if (!(dirs.length === 1 && ctx.key(dirs[0]) === ctx.key(ancestor))) {
          s = await locateConfig(ctx, fs, v, dirs.length === 0 ? [cwd] : dirs, ancestor, notes, ignore);
          if (isS6(s)) return s;
        }
        if (s.inipath === undefined) {
          const common = commonPath(ctx, [cwd, ancestor]);
          s = { rootdir: ctx.P.parse(common).root === common ? ancestor : common };
        }
      }
    }
    out.push(rooted(s));
  }
  return out;
}

/** QA-1.3-21: the lower of two raw config caps (count n < auto; an invalid value ranks last). */
function lowerCap(raw: string, than: string | undefined): boolean {
  if (than === undefined) return true;
  const rank = (x: string) => {
    const c = parseCap("pytest", x);
    return c === undefined ? Number.POSITIVE_INFINITY : "count" in c ? c.count : Number.MAX_SAFE_INTEGER;
  };
  return rank(raw) < rank(than);
}

interface PytestEvidence {
  readonly xdist: boolean;
  readonly covInConfig: boolean;
  readonly userWorkers?: UserWorkerCap;
  /** The union of the python_files patterns every source can apply (QA-1.3-33). */
  readonly pythonFiles: readonly string[];
  /** The -c/--config-file pytest reads, from the command or PYTEST_ADDOPTS (QA-1.3-39); a config trigger. */
  readonly configFile?: string;
  /** QA-1.3-43: the -c and --rootdir the spec adds so the spawn reads what the user's run reads. */
  readonly pin?: readonly string[];
}

/** pytestEvidence's result: the evidence and what each release reads for the run. */
interface PytestRun {
  readonly evidence: PytestEvidence;
  readonly setups: readonly PytestSetup[];
  /** The config comes from -c/--config-file (the command or PYTEST_ADDOPTS), which the spawn also sees. */
  readonly explicit: boolean;
  /** A non-empty --rootdir (the command or PYTEST_ADDOPTS), which the spawn also sees. */
  readonly rootdirGiven: boolean;
  readonly ignore: ReadonlySet<string>;
  /** QA-1.3-48: the existing plugin option values in the PYTEST_ADDOPTS the spawn sees: free arguments of its lookup too. */
  readonly envArgs: readonly string[];
  /** G.8b: what a run with no path arguments collects, when testpaths decide it (DetectedRunner.collectScopes). */
  readonly collect?: readonly string[];
}

/**
 * G.8b (E2E-1): pytest's Config._decide_args. With no path arguments, a run started from its
 * rootdir collects `testpaths` (each globbed relative to the rootdir; missing ones are skipped, and
 * when none is left it collects the invocation directory). Anything else collects runnerCwd. The
 * scopes are returned only when every release line agrees that testpaths apply: its config sets
 * them, its rootdir is `cwd`, no source overrides them (-o testpaths=, --pyargs), no --rootdir is
 * given, and every entry is a plain path (no glob characters). Otherwise undefined, which keeps
 * every input under runnerCwd: an extra test input can only fail, never hide a failure.
 */
async function testpathScopes(
  ctx: Ctx,
  fs: PlannerFs,
  setups: readonly PytestSetup[],
  cwd: string,
  overridden: boolean,
): Promise<string[] | undefined> {
  if (overridden) return undefined;
  const out = new Map<string, string>();
  for (const s of setups) {
    const tp = s.config?.testpaths;
    if (s.rootdir === undefined || ctx.key(s.rootdir) !== ctx.key(cwd) || tp === undefined || tp.length === 0) return undefined;
    let found = 0;
    for (const t of tp) {
      if (/[*?[]/.test(t)) return undefined;
      const abs = ctx.P.resolve(s.rootdir, t);
      if (await existsCached(ctx, fs, abs)) {
        const real = await realOf(ctx, fs, abs);
        out.set(ctx.key(real), real);
        found++;
      }
    }
    if (found === 0) return undefined;
  }
  return [...out.values()];
}

/**
 * D.4: xdist, cov and the user cap from every source pytest reads, in pytest's order (config
 * addopts, then PYTEST_ADDOPTS, then the command; the last cap wins). Both the cross-env and the
 * host PYTEST_ADDOPTS are scanned for xdist/cov evidence; the cap, "-p no:xdist" and the options
 * that choose the config come from the one the spawn will see (QA-1.3-39). The configs are the
 * ones each release reads for a run with the path arguments `args` in `cwd` (QA-1.3-43).
 */
async function pytestEvidence(
  ctx: Ctx,
  fs: PlannerFs,
  facts: PytestFacts,
  env: Readonly<Record<string, string>>,
  args: readonly string[],
  cwd: string,
  gitRoot: string,
  notes: string[],
): Promise<PytestRun | Unverifiable> {
  const runnerCwd = cwd;
  const exists = (p: string) => fs.fileExists(p);
  const parse = (tokens: readonly string[] | undefined, where: string): Promise<ArgResult | Unverifiable> =>
    tokens ? processArgs(ctx, "pytest", tokens, where, runnerCwd, gitRoot, { addopts: { exists } }) : Promise.resolve(s6("unterminated-quote", `unterminated quote in ${where}`));
  // QA-1.3-39: pytest prepends PYTEST_ADDOPTS to the command line BEFORE it picks its config, so a
  // -c/--config-file, --rootdir or -o there counts like one on the command line (which comes
  // later and wins). The spawn sees the cross-env value when there is one, else the host's.
  const crossEnv = Object.hasOwn(env, "PYTEST_ADDOPTS");
  const envs: { readonly r: ArgResult; readonly seen: boolean }[] = [];
  for (const [text, seen] of [[ctx.host.pytestAddopts, !crossEnv], [crossEnv ? env.PYTEST_ADDOPTS : "", true]] as const) {
    if (text === "") continue;
    const r = await parse(tokenize(text), "PYTEST_ADDOPTS");
    if (isS6(r)) return r;
    envs.push({ r, seen });
  }
  const seenEnv = envs.find((x) => x.seen)?.r;
  const envConfig = seenEnv?.configs.at(-1);
  const configFile = facts.configFile ?? (envConfig === undefined ? undefined : await realOf(ctx, fs, ctx.P.resolve(runnerCwd, stripWinPrefix(ctx, envConfig))));
  const overrideAddopts = facts.overrideAddopts ?? seenEnv?.overrideAddopts;
  const rootdir = facts.rootdir ?? seenEnv?.rootdir;
  // The config is always looked up: python_files comes from it even when -o addopts replaces its
  // addopts. A key the command line overrides with -o is not S6 when the file spells it oddly.
  const ignore = new Set<string>();
  if (overrideAddopts !== undefined) ignore.add("addopts");
  if (facts.pythonFiles !== undefined || (seenEnv?.overridePythonFiles.length ?? 0) > 0) ignore.add("python_files");
  // pytest's `ns.rootdir or None`: an empty --rootdir is none (QA-1.3-40).
  const rootdirGiven = rootdir !== undefined && rootdir !== "";
  // QA-1.3-48: PYTEST_ADDOPTS comes first on the line pytest parses, and the spawn sees it as well.
  const envArgs: string[] = [];
  for (const x of seenEnv?.early ?? []) if (await existsCached(ctx, fs, x.path)) envArgs.push(await realOf(ctx, fs, x.path));
  const setups = await pytestSetups(ctx, fs, configFile, [...envArgs, ...args], cwd, rootdirGiven, notes, ignore);
  if (isS6(setups)) return setups;
  const found = { configs: [] as PytestConfig[], everyLine: setups.every((s) => s.config !== undefined) };
  for (const { config: c } of setups) {
    if (c && !found.configs.some((o) => o.path === c.path && JSON.stringify(o) === JSON.stringify(c))) found.configs.push(c);
  }
  // QA-1.3-33: every line's config applies its python_files, or pytest's default when it sets none
  // or the line found no config. The union only ever classifies more files as tests.
  const pythonFiles = new Set<string>(found.everyLine ? [] : DEFAULT_PYTHON_FILES);
  for (const cfg of found.configs) for (const p of cfg.pythonFiles ?? DEFAULT_PYTHON_FILES) pythonFiles.add(p);
  for (const p of facts.pythonFiles ?? []) pythonFiles.add(p);
  // cap: "config" sources are alternatives (one per pytest line, QA-1.3-21): the lowest cap wins.
  // Later sources override in pytest's order: "wins" always; "none" (a host PYTEST_ADDOPTS that
  // cross-env replaces) is evidence for xdist and cov only.
  const sources: { readonly where: string; readonly r: ArgResult; readonly cap: "config" | "wins" | "none" }[] = [];
  // "-p no:xdist" in a config disables xdist only when every pytest line reads a config that says
  // so: a line whose config does not block xdist would still honour an -n (QA-1.3-21).
  let configsBlock: boolean;
  if (overrideAddopts !== undefined) {
    const r = await parse(tokenize(overrideAddopts), "-o addopts");
    if (isS6(r)) return r;
    sources.push({ where: "-o addopts", r, cap: "config" });
    configsBlock = true;
  } else {
    configsBlock = found.everyLine && found.configs.every((c) => c.addopts !== undefined);
    for (const cfg of found.configs) {
      if (!cfg.addopts) continue;
      const where = `addopts of ${cfg.path}`;
      const r = await parse(cfg.addopts, where);
      if (isS6(r)) return r;
      sources.push({ where, r, cap: "config" });
    }
  }
  for (const x of envs) sources.push({ where: "PYTEST_ADDOPTS", r: x.r, cap: x.seen ? "wins" : "none" });

  let capRaw: string | undefined;
  let xdist = facts.xdist;
  let noXdist = facts.noXdist;
  let cov = false;
  for (const { where, r, cap } of sources) {
    xdist ||= r.xdistArg;
    if (cap === "config") configsBlock &&= r.noXdist;
    else if (cap === "wins") noXdist ||= r.noXdist;
    cov ||= r.cov;
    if (r.capRaw !== undefined && (cap === "wins" || (cap === "config" && lowerCap(r.capRaw, capRaw)))) capRaw = r.capRaw;
    for (const n of r.notes) if (n.startsWith("invalid worker cap") && !notes.includes(n)) notes.push(n);
    const pf = pythonFilesOverride(r.overridePythonFiles, where);
    if (isS6(pf)) return pf;
    for (const p of pf) pythonFiles.add(p);
  }
  if (facts.cap !== undefined) capRaw = facts.cap;
  const userWorkers = capRaw === undefined ? undefined : parseCap("pytest", capRaw);
  const evidence: PytestEvidence = {
    xdist: xdist && !noXdist && !configsBlock,
    covInConfig: cov,
    ...(userWorkers ? { userWorkers } : {}),
    pythonFiles: [...pythonFiles],
    ...(configFile !== undefined ? { configFile } : {}),
  };
  // G.8b: the command's own -o testpaths=/--pyargs is the caller's to check (detectImpl).
  const overridden = args.length > 0 || rootdirGiven || sources.some((s) => s.r.collectOverride);
  const collect = await testpathScopes(ctx, fs, setups, cwd, overridden);
  return { evidence, setups, explicit: configFile !== undefined, rootdirGiven, ignore, envArgs, ...(collect ? { collect } : {}) };
}

/**
 * QA-1.3-43: the options that make the spawn read what the user's run reads. The spec passes the
 * inputs as file arguments, so without them pytest would look for its config from the inputs'
 * common ancestor, where a nearer pytest.ini or package pyproject.toml wins over the user's config
 * (its addopts -m/-k/--deselect and collection keys then apply to the spawn only).
 *   - A -c/--config-file from the command or PYTEST_ADDOPTS: the spawn has it too; nothing to add.
 *   - --rootdir: added as the user's rootdir unless the run gives one. Every release must agree on
 *     it, else S6. With a rootdir given, pytest skips the setup.py rule and the per-argument
 *     fallback, so the spawn's lookup is locate_config from the inputs' ancestor only.
 *   - -c <file>: added when every release reads the same accepted config (the rootdir, the ini
 *     values and the conftest cutoff, inifile's directory or rootdir, then match). Otherwise, when
 *     the releases differ or read no config, that locate_config must give every release the
 *     inifile the user's run has (none included).
 *   - QA-1.3-49, before any S6: (a) nothing at all, when the spawn's own determine_setup (its free
 *     arguments `extra` and F in `cwd`, nothing pinned) gives every release the user's inifile and
 *     rootdir; (b) -c <a table-less pyproject.toml> with the --rootdir, when that file is the
 *     inifile of pytest >= 8.1 in the user's run and the older releases read none (bareProject).
 * The spawn's free arguments include `extra`, the existing values of the plugin options it keeps
 * and of its PYTEST_ADDOPTS (QA-1.3-48).
 * pytest applies os.path.expandvars to --rootdir, so a rootdir with "$" (or "%" on win32) is S6.
 */
async function pytestPin(
  ctx: Ctx,
  fs: PlannerFs,
  run: PytestRun,
  F: readonly string[],
  cwd: string,
  extra: readonly string[],
  notes: string[],
): Promise<string[] | Unverifiable> {
  if (run.explicit) return [];
  const same = (a: string | undefined, b: string | undefined) => ctx.key(a ?? "") === ctx.key(b ?? "");
  // QA-1.3-49 (a): the spawn's own lookup, tried only where a pin cannot work.
  const unpinned = async (why: Unverifiable): Promise<string[] | Unverifiable> => {
    const own = await pytestSetups(ctx, fs, undefined, [...extra, ...F], cwd, run.rootdirGiven, [], run.ignore);
    if (isS6(own)) return why;
    return own.every((s, i) => same(s.inipath, run.setups[i].inipath) && same(s.rootdir, run.setups[i].rootdir)) ? [] : why;
  };
  const pin: string[] = [];
  let root: string | undefined;
  if (!run.rootdirGiven) {
    const roots = [...new Map(run.setups.map((s) => [ctx.key(s.rootdir ?? ""), s.rootdir ?? ""])).values()];
    if (roots.length > 1) return unpinned(s6("unsupported-argument", `unsupported pytest rootdir: the pytest releases pick ${roots.join(" or ")}`));
    root = roots[0];
    if (/\$/.test(root) || (ctx.win && root.includes("%"))) {
      return unpinned(s6("unsupported-argument", `unsupported pytest rootdir: pytest expands variables in ${root}`));
    }
    pin.push(`--rootdir=${root}`);
  }
  const inis = new Set(run.setups.map((s) => (s.config ? ctx.key(s.config.path) : "")));
  const first = run.setups[0].config;
  if (inis.size === 1 && first) return ["-c", first.path, ...pin];
  const at = extra.length > 0 ? commonPath(ctx, [commonDir(ctx, F), ...extra]) : commonDir(ctx, F);
  for (const [i, v] of PYTEST_SETUPS.entries()) {
    const got = await locateConfig(ctx, fs, v, [at], undefined, notes, run.ignore);
    if (isS6(got)) return got;
    const want = run.setups[i].inipath;
    if (!same(got.inipath, want)) {
      const why = s6("unsupported-argument", `unsupported pytest config for the scoped inputs: ${got.inipath ?? "none"} instead of ${want ?? "none"}`);
      const own = await unpinned(why);
      if (!isS6(own)) return own;
      const bare = await bareProject(ctx, fs, run.setups, root);
      return bare === undefined ? why : ["-c", bare, ...pin];
    }
  }
  return pin;
}

/**
 * QA-1.3-49 (b): the table-less pyproject.toml to pin with -c, or undefined. It must be the inifile
 * of every release that has one (pytest >= 8.1 takes it with no ini values, and its directory as
 * the rootdir, which every release agrees on: `root`), and no release may read an accepted config.
 * With -c, every release reads no ini values from it, as the user's run does, and cuts conftests at
 * its directory: pytest >= 8.1 does so in the user's run too (inifile's directory), but pytest < 8.1
 * with no inifile cuts none, so a conftest.py above the rootdir makes it undefined.
 */
async function bareProject(ctx: Ctx, fs: PlannerFs, setups: readonly PytestSetup[], root: string | undefined): Promise<string | undefined> {
  const p = setups.find((s) => s.inipath !== undefined)?.inipath;
  if (root === undefined || p === undefined) return undefined;
  if (!setups.every((s) => s.config === undefined && (s.inipath === undefined || ctx.key(s.inipath) === ctx.key(p)))) return undefined;
  for (let d = root; ctx.P.dirname(d) !== d; ) {
    d = ctx.P.dirname(d);
    if (await existsCached(ctx, fs, ctx.P.join(d, "conftest.py"))) return undefined;
  }
  return p;
}

/**
 * QA-1.3-48: the free arguments of the user's run for its config lookup (`user`: the path
 * arguments and the existing plugin option values, in order) and those the spawn keeps (`kept`).
 * `move` maps a detection-time path into the run's tree (a rerun). Without freeArgs: pathScopes.
 */
async function pytestLookupArgs(
  ctx: Ctx,
  fs: PlannerFs,
  facts: PytestFacts | undefined,
  pathScopes: readonly string[],
  move: (p: string) => string,
): Promise<{ user: string[]; kept: string[] }> {
  if (!facts?.freeArgs) return { user: pathScopes.map(move), kept: [] };
  const user: string[] = [];
  const kept: string[] = [];
  for (const a of facts.freeArgs) {
    const p = move(a.path);
    if (!a.plugin) user.push(p);
    else if (await existsCached(ctx, fs, p)) {
      user.push(p);
      if (a.kept) kept.push(p);
    }
  }
  return { user, kept };
}

/** The patterns of `-o python_files=<v>` values, split like pytest's shlex (QA-1.3-33). */
function pythonFilesOverride(values: readonly string[], where: string): string[] | Unverifiable {
  const out: string[] = [];
  for (const v of values) {
    const tokens = tokenize(v);
    if (!tokens) return s6("unsupported-argument", `unsupported pytest argument "python_files" in ${where}`);
    out.push(...tokens);
  }
  return out;
}

/** The directory pytest starts its inifile search from: the common ancestor of the file arguments. */
function commonDir(ctx: Ctx, files: readonly string[]): string {
  let dir = ctx.P.dirname(files[0]);
  for (const f of files) {
    while (!isInside(ctx, dir, f)) {
      const up = ctx.P.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return dir;
}

/**
 * D.4 at spec time (QA-1.3-3c, QA-1.3-43): the config the user's run reads, from runnerCwd (the
 * rerun's cwd in a reference tree, where the user's path arguments move with it), and the options
 * that pin the spawn to it (pytestPin).
 */
async function pytestAtInputs(
  ctx: Ctx,
  fs: PlannerFs,
  det: DetectedRunner,
  F: readonly string[],
  runnerCwd: string,
  notes: string[],
): Promise<PytestEvidence | Unverifiable | undefined> {
  if (det.kind !== "pytest") return undefined;
  const facts = det.pytestFacts ?? (await keptPytestFacts(ctx, fs, det, runnerCwd));
  if (isS6(facts)) return facts;
  const own: string[] = [];
  const move = (s: string) => ctx.P.resolve(runnerCwd, ctx.P.relative(det.runnerCwd, s));
  const args = await pytestLookupArgs(ctx, fs, det.pytestFacts, det.pathScopes, move);
  const run = await pytestEvidence(ctx, fs, facts, det.env, args.user, runnerCwd, det.gitRoot, own);
  if (isS6(run)) return run;
  const pin = await pytestPin(ctx, fs, run, F, runnerCwd, [...run.envArgs, ...args.kept], own);
  if (isS6(pin)) return pin;
  for (const n of own) if (!notes.includes(n)) notes.push(n);
  const ev = { ...run.evidence, pin };
  if (det.pytestFacts) return ev;
  // A DetectedRunner built elsewhere: never lose what it already knew.
  const userWorkers = ev.userWorkers ?? det.userWorkers;
  return { xdist: ev.xdist || det.xdist, covInConfig: ev.covInConfig || det.covInConfig, ...(userWorkers ? { userWorkers } : {}), pythonFiles: ev.pythonFiles, pin };
}

/**
 * A DetectedRunner built without pytestFacts: its kept arguments still hold the -c/--config-file
 * and --rootdir the spawn will see, so pytestPin never adds a second one (QA-1.3-43).
 */
async function keptPytestFacts(ctx: Ctx, fs: PlannerFs, det: DetectedRunner, runnerCwd: string): Promise<PytestFacts | Unverifiable> {
  const a = await processArgs(ctx, "pytest", det.keptArgs, "command", runnerCwd, det.gitRoot);
  if (isS6(a)) return a;
  const cf = a.configs.at(-1);
  const configFile = cf === undefined ? undefined : await realOf(ctx, fs, ctx.P.resolve(runnerCwd, stripWinPrefix(ctx, cf)));
  return { xdist: det.xdist, noXdist: false, ...(configFile !== undefined ? { configFile } : {}), ...(a.rootdir !== undefined ? { rootdir: a.rootdir } : {}) };
}

/**
 * QA-1.3-47: the pytest argv without the tokens only the config lookup adds (-n N, --no-cov, -c,
 * --rootdir) is a lower bound of the spec's; over MAX_ARGV_CHARS it is S6 before that lookup runs.
 */
function pytestArgvFloor(ctx: Ctx, det: DetectedRunner, entry: ResolvedEntry, F: readonly string[]): Unverifiable | undefined {
  if (det.kind !== "pytest") return undefined;
  const R = ctx.P.join(ctx.P.resolve(ctx.host.tmpdir), `omr-verify-${"0".repeat(36)}.xml`);
  const args = [...entry.prefix, ...det.keptArgs, "-q", "-p", "no:cacheprovider", `--junitxml=${R}`, "--maxfail=0", "--", ...F];
  return commandLineLength(ctx, entry.file, args) > MAX_ARGV_CHARS ? argvTooLong(F.length) : undefined;
}

function argvTooLong(n: number): Unverifiable {
  return s6("argv-too-long", `too many inputs for one command line: ${n} files`);
}

// ---------------------------------------------------------------------------------------------
// B. Detection
// ---------------------------------------------------------------------------------------------

/** A detection result for any tool kind; Detected<RunnerKind> is a DetectedRunner. */
type Detected<K extends ToolKind> = Omit<DetectedRunner, "kind"> & { readonly kind: K };

async function detectImpl<K extends ToolKind>(
  ctx: Ctx,
  command: string,
  cwd: string,
  fs: PlannerFs,
  heads: Heads<K>,
): Promise<Detected<K> | Unverifiable> {
  const P = ctx.P;
  const absCwd = await canonicalCwd(ctx, fs, cwd);
  const gitRoot = await findGitRoot(ctx, absCwd, fs);
  if (gitRoot === undefined) return s6("no-git-root", `no git repository at or above ${cwd}`);

  const composite = findComposite(command);
  if (composite !== undefined) return s6("composite", `composite command: "${composite}"`);
  const tokens = tokenize(command);
  if (!tokens) return s6("unterminated-quote", "unterminated quote in command");
  const inv = parseInvocation(tokens, "command", true, heads);
  if (isS6(inv)) return inv;

  if (inv.type === "direct") {
    return finishDetection(ctx, fs, inv.kind, inv.launcher, { type: "command" }, gitRoot, absCwd, inv.env, inv.args, "command", []);
  }
  if (inv.manager === "npm") {
    const redirect = await npmWorkspaceConfig(ctx, fs, absCwd, gitRoot, inv.env);
    if (redirect) return redirect;
  }

  let pkgPath: string | undefined;
  for (const d of ancestors(ctx, absCwd, gitRoot)) {
    const p = P.join(d, "package.json");
    if (await fs.fileExists(p)) {
      pkgPath = p;
      break;
    }
  }
  if (pkgPath === undefined) return s6("no-package-json", `no package.json between ${cwd} and the git root`);
  const parsed = await readJson(fs, pkgPath);
  if (!parsed.ok || !isRecord(parsed.value)) return s6("bad-package-json", `unreadable package.json: ${pkgPath}`);
  const scripts = parsed.value.scripts;
  const text = isRecord(scripts) ? scripts[inv.name] : undefined;
  if (typeof text !== "string") return s6("no-script", `package.json has no string scripts.${inv.name}: ${pkgPath}`);

  const where = `scripts.${inv.name}`;
  const sc = findComposite(text);
  if (sc !== undefined) return s6("composite", `composite ${where}: "${sc}"`);
  const st = tokenize(text);
  if (!st) return s6("unterminated-quote", `unterminated quote in ${where}`);
  const inner = parseInvocation(st, where, false, heads);
  if (isS6(inner)) return inner;
  if (inner.type !== "direct") return unsupported(inv.manager, where);

  const notes = [...inv.notes];
  for (const hook of [`pre${inv.name}`, `post${inv.name}`]) {
    if (isRecord(scripts) && scripts[hook] !== undefined) notes.push(`scripts.${hook} is not run by the scoped command`);
  }
  const source: CommandSource = { type: "script", manager: inv.manager, name: inv.name, packageJson: pkgPath };
  return finishDetection(
    ctx,
    fs,
    inner.kind,
    inner.launcher,
    source,
    gitRoot,
    P.dirname(pkgPath),
    { ...inv.env, ...inner.env },
    [...inner.args, ...inv.extra],
    where,
    notes,
  );
}

const NPM_WORKSPACE_ENV_RE = /^npm_config_workspaces?$/i;

/**
 * QA-1.3-32: the keys of an .npmrc as npm's `ini` parser reads them: lines split on CR/LF, comment
 * (; #) and blank lines skipped, a line without "=" is a key set to true, and the key text goes
 * through ini's unsafe(): trimmed (JS trim also drops a BOM), a quoted key ('...' or "...") is
 * unquoted and JSON-decoded when it parses ("work\u0073pace" is workspace), an unquoted key stops
 * at the first unescaped ; or #. A trailing [] (array key) is dropped. Keys under a [section]
 * are kept too (a superset). Lower-cased.
 */
function npmrcKeys(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/[\r\n]+/)) {
    if (/^\s*(?:[;#]|$)/.test(line) || /^\[[^\]]*\]\s*$/.test(line)) continue;
    const eq = line.indexOf("=");
    if (eq === 0) continue;
    let key = npmUnsafe(eq < 0 ? line : line.slice(0, eq));
    if (key.length > 2 && key.endsWith("[]")) key = key.slice(0, -2);
    out.push(key.toLowerCase());
  }
  return out;
}

/** ini's unsafe() for a key (see npmrcKeys). */
function npmUnsafe(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.startsWith("'") ? v.slice(1, -1) : v;
    try {
      return String(JSON.parse(inner));
    } catch {
      return inner; // ini keeps the text when JSON.parse fails.
    }
  }
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === ";" || c === "#") break;
    if (c !== "\\") out += c;
    else if (i + 1 < v.length) out += ";#\\".includes(v[i + 1]) ? v[++i] : `\\${v[++i]}`;
    else out += "\\";
  }
  return out.trim();
}

/**
 * B (QA-1.3-24): npm reads `workspace` / `workspaces` from a project .npmrc and from
 * npm_config_* variables (any case), and then `npm test` runs the workspace's script, not the
 * root one the adapter resolved (npm 12.0.2). Checked: every .npmrc from cwd up to gitRoot, the
 * host env and the cross-env assignments. `prefix` is NOT checked: from .npmrc or the env it only
 * moves the global prefix (npm 12.0.2 still ran the root script), and npm_config_prefix is a
 * common global setting. The user and global npmrc are a P residual.
 */
async function npmWorkspaceConfig(
  ctx: Ctx,
  fs: PlannerFs,
  cwd: string,
  gitRoot: string,
  crossEnv: Readonly<Record<string, string>>,
): Promise<Unverifiable | undefined> {
  for (const [where, env] of [["cross-env", crossEnv], ["the environment", ctx.host.env ?? {}]] as const) {
    const key = Object.keys(env).find((k) => NPM_WORKSPACE_ENV_RE.test(k) && (env[k] ?? "") !== "");
    if (key !== undefined) return unsupported(`npm ${key}`, where);
  }
  for (const d of ancestors(ctx, cwd, gitRoot)) {
    const p = ctx.P.join(d, ".npmrc");
    if (!(await existsCached(ctx, fs, p))) continue;
    const t = await readConfigText(ctx, fs, p);
    if (t === "too-large") return tooLarge(p);
    if (t === "unreadable") return unsupported("npm", `${p} (unreadable)`);
    const key = npmrcKeys(t.text).find((k) => k === "workspace" || k === "workspaces");
    if (key !== undefined) return unsupported(`npm ${key}`, p);
  }
  return undefined;
}

async function finishDetection<K extends ToolKind>(
  ctx: Ctx,
  fs: PlannerFs,
  kind: K,
  launcher: Launcher,
  source: CommandSource,
  gitRoot: string,
  runnerCwd: string,
  env: Record<string, string>,
  args: readonly string[],
  where: string,
  notes: string[],
): Promise<Detected<K> | Unverifiable> {
  // QA-1.3-32: npx (npm exec) reads the same workspace config as npm and then runs in the
  // workspace's directory, so `npx vitest run` would test another package than the planned one.
  if (launcher === "npx") {
    const redirect = await npmWorkspaceConfig(ctx, fs, runnerCwd, gitRoot, env);
    if (redirect) return redirect;
  }
  const a = await processArgs(ctx, kind, args, where, runnerCwd, gitRoot);
  if (isS6(a)) return a;
  const allNotes = [...notes, ...a.notes];
  const pathScopes = await Promise.all(a.pathScopes.map((p) => realOf(ctx, fs, p)));
  // QA-1.3-41: jest reads a `--config` value that starts with "{" and ends with "}" as the config
  // itself (jest-config isJSONString + JSON.parse), not as a path. One that does not parse is S6.
  const inlineConfigs = kind === "jest" ? a.configs.filter(isInlineJson) : [];
  const badInline = inlineConfigs.find((c) => parseJson(c) === undefined);
  if (badInline !== undefined) return s6("unsupported-argument", `unsupported jest argument "${badInline}" in ${where}`);
  const configPaths = a.configs.filter((c) => !inlineConfigs.includes(c));
  const configFiles = await Promise.all(configPaths.map((c) => realOf(ctx, fs, ctx.P.resolve(runnerCwd, stripWinPrefix(ctx, c)))));
  let userWorkers = a.userWorkers;
  let xdist = false;
  let covInConfig = false;
  let pytestFacts: PytestFacts | undefined;
  let pythonFiles: readonly string[] | undefined;
  let collectScopes: readonly string[] | undefined;
  if (kind === "pytest") {
    const configFile = configFiles.at(-1);
    const pf = pythonFilesOverride(a.overridePythonFiles, where);
    if (isS6(pf)) return pf;
    const freeArgs = a.early.some((x) => x.plugin) ? await Promise.all(a.early.map(async (x) => ({ ...x, path: await realOf(ctx, fs, x.path) }))) : undefined;
    pytestFacts = {
      xdist: a.xdistArg,
      noXdist: a.noXdist,
      ...(a.capRaw !== undefined ? { cap: a.capRaw } : {}),
      ...(configFile !== undefined ? { configFile } : {}),
      ...(a.overrideAddopts !== undefined ? { overrideAddopts: a.overrideAddopts } : {}),
      ...(a.overridePythonFiles.length > 0 ? { pythonFiles: pf } : {}),
      ...(a.rootdir !== undefined ? { rootdir: a.rootdir } : {}),
      ...(freeArgs ? { freeArgs } : {}),
    };
    // Detection starts where pytest would with no file arguments.
    const run = await pytestEvidence(ctx, fs, pytestFacts, env, [], runnerCwd, gitRoot, allNotes);
    if (isS6(run)) return run;
    const ev = run.evidence;
    ({ xdist, covInConfig, userWorkers } = ev);
    // G.8b (E2E-1): testpaths decide the user's collection only without path arguments.
    if (pathScopes.length === 0 && !a.collectOverride) collectScopes = run.collect;
    // QA-1.3-39: a -c/--config-file from PYTEST_ADDOPTS is a config trigger like the command's.
    const envConfig = ev.configFile;
    if (envConfig !== undefined && !configFiles.some((c) => ctx.key(c) === ctx.key(envConfig))) configFiles.push(envConfig);
    // QA-1.3-33: with path arguments the user's pytest reads the config above their common
    // ancestor, so its python_files count as well, and (QA-1.3-40) the per-argument fallback
    // looks from each path argument in the user's order.
    const patterns = new Set(ev.pythonFiles);
    const lookupArgs = (await pytestLookupArgs(ctx, fs, pytestFacts, pathScopes, (p) => p)).user;
    if (lookupArgs.length > 0) {
      const scoped = await pytestEvidence(ctx, fs, pytestFacts, env, lookupArgs, runnerCwd, gitRoot, allNotes);
      if (isS6(scoped)) return scoped;
      for (const p of scoped.evidence.pythonFiles) patterns.add(p);
    }
    pythonFiles = [...patterns];
  }
  return {
    kind,
    launcher,
    source,
    gitRoot,
    runnerCwd,
    env,
    keptArgs: a.kept,
    ...(userWorkers ? { userWorkers } : {}),
    pathScopes,
    xdist,
    covInConfig,
    notes: allNotes,
    configFiles,
    ...(inlineConfigs.length > 0 ? { inlineConfigs } : {}),
    ...(pytestFacts ? { pytestFacts } : {}),
    ...(pythonFiles ? { pythonFiles } : {}),
    ...(collectScopes ? { collectScopes } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// F. Entry resolution
// ---------------------------------------------------------------------------------------------

async function resolveEntryImpl(
  ctx: Ctx,
  req: EntryRequest,
  cwd: string,
  fs: PlannerFs,
): Promise<{ entry: ResolvedEntry; notes: string[] } | Unverifiable> {
  const P = ctx.P;
  const exe = (name: string) => (ctx.win ? `${name}.exe` : name);
  const onPath = async (name: string): Promise<string | undefined> => {
    for (const dir of ctx.host.pathEnv.split(P.delimiter)) {
      if (!dir || !isFullPath(ctx, dir)) continue;
      const f = P.join(dir, exe(name));
      if ((await fs.fileExists(f)) && (await statOf(fs, f))?.isFile !== false) return f;
    }
    return undefined;
  };

  if (req.launcher === "uv-run") {
    const uv = await onPath("uv");
    if (!uv) return s6("runner-not-installed", "runner not installed: uv");
    return { entry: { file: uv, prefix: ["run", "pytest"], entry: uv }, notes: [] };
  }
  if (req.kind === "pytest") {
    const found = await onPath("pytest");
    if (found) return { entry: { file: found, prefix: [], entry: found }, notes: [] };
    const venvRel = ctx.win ? P.join(".venv", "Scripts", "pytest.exe") : P.join(".venv", "bin", "pytest");
    for (const d of ancestors(ctx, cwd, req.gitRoot)) {
      const f = P.join(d, venvRel);
      if ((await fs.fileExists(f)) && (await statOf(fs, f))?.isFile !== false) return { entry: { file: f, prefix: [], entry: f }, notes: [`pytest resolved from ${f}`] };
    }
    return s6("runner-not-installed", "runner not installed: pytest");
  }

  const pkg = req.kind;
  let pj: string | undefined;
  for (const d of ancestors(ctx, cwd, req.gitRoot)) {
    const p = P.join(d, "node_modules", pkg, "package.json");
    if (await fs.fileExists(p)) {
      pj = p;
      break;
    }
  }
  if (pj === undefined) {
    if (await fs.fileExists(P.join(req.gitRoot, ".pnp.cjs"))) {
      return s6("yarn-pnp", `yarn Plug'n'Play has no node_modules to resolve ${pkg} from`);
    }
    return s6("runner-not-installed", `runner not installed: ${pkg}`);
  }
  const badBin = (detail: string) => s6("bad-bin", `invalid bin for ${pkg}: ${detail}`);
  const parsed = await readJson(fs, pj);
  if (!parsed.ok || !isRecord(parsed.value)) return badBin(`unreadable package.json ${pj}`);
  const meta = parsed.value;
  if (meta.name !== pkg) return badBin(`package name is not "${pkg}"`);
  const bin = typeof meta.bin === "string" ? meta.bin : isRecord(meta.bin) ? meta.bin[pkg] : undefined;
  if (typeof bin !== "string") return badBin("no bin entry");
  const pkgDir = P.dirname(pj);
  const entry = P.resolve(pkgDir, bin);
  const rel = P.relative(pkgDir, entry);
  if (rel === "" || P.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return badBin("bin escapes the package directory");
  if (!/\.(?:js|mjs|cjs)$/.test(entry)) return badBin("bin is not a .js, .mjs or .cjs file");
  if (!(await fs.fileExists(entry))) return badBin(`bin entry missing: ${entry}`);
  const version = typeof meta.version === "string" ? meta.version : undefined;
  const node = await resolveNode(ctx, fs);
  if (typeof node !== "string") return node;
  return { entry: { file: node, prefix: [entry], entry, ...(version !== undefined ? { version } : {}) }, notes: [] };
}

/**
 * F.1 (QA-1.3-18): the node executable that runs a JS tool. Never Bun or a compiled binary:
 * jest fails every suite under bun.exe. Order: host.nodePath, host.execPath when it is node, then
 * the first node on an absolute PATH entry. On win32 each PATHEXT extension is tried in order, as
 * the shell does; a hit that is not a .exe (a .cmd/.bat shim) needs a shell -> S6. Bun's temporary
 * node is skipped by its bun-node-<hex> directory, a realpath to bun (symlink), or the same dev/ino
 * as host.execPath (the win32 hard link, QA-1.3-30); a directory named node is skipped and a
 * root-relative win32 PATH entry is unusable (QA-1.3-36). fileExists, realpath and stat only,
 * nothing is spawned.
 */
async function resolveNode(ctx: Ctx, fs: PlannerFs): Promise<string | Unverifiable> {
  const { P, host } = ctx;
  if (host.nodePath !== undefined) {
    if (!isFullPath(ctx, host.nodePath)) return s6("node-not-found", `node path is not absolute: ${host.nodePath}`);
    // QA-1.3-36: with the stat seam, a configured node must be an existing file.
    const bad = fs.stat !== undefined && (await statOf(fs, host.nodePath))?.isFile !== true;
    return bad ? s6("node-not-found", `node path is not a file: ${host.nodePath}`) : host.nodePath;
  }
  if (ctx.execIsNode && (fs.stat === undefined || (await statOf(fs, host.execPath))?.isFile === true)) return host.execPath;
  const exts = ctx.win ? (host.pathExt ?? "").split(";").map((x) => x.trim().toLowerCase()).filter((x) => x.startsWith(".")) : [""];
  // QA-1.3-30: the running runtime is not node here (Bun, or a compiled binary). A PATH node that
  // is the same file (Bun's temporary node on win32 is a HARD link to bun.exe) is not node either.
  let self: FileStat | undefined | null = null;
  for (const dir of host.pathEnv.split(P.delimiter)) {
    if (!dir || !isFullPath(ctx, dir) || BUN_NODE_DIR_RE.test(P.basename(dir))) continue;
    for (const ext of exts) {
      const f = P.join(dir, `node${ext}`);
      if (!(await fs.fileExists(f))) continue;
      const st = await statOf(fs, f);
      if (st && !st.isFile) continue; // QA-1.3-36: a directory named node.exe.
      if (ctx.win && ext !== ".exe") return s6("node-not-found", `node on PATH is not an executable file: ${f}`);
      if (await isBunLink(ctx, fs, f)) break;
      if (st && self === null) self = await statOf(fs, host.execPath);
      if (st && self && sameFile(st, self)) break;
      return f;
    }
  }
  return s6("node-not-found", "node not found: no absolute PATH entry has a node executable");
}

/** QA-1.3-30: the directory `bun run` puts first on PATH with its temporary node (%TEMP%\bun-node-<hash>, /tmp/bun-node-<hash>). */
const BUN_NODE_DIR_RE = /^bun-node-[0-9a-f]+$/i;

/**
 * N.1/N.7 (QA-1.3-36): a PATH entry or configured executable path the planner may use: absolute,
 * and on win32 with a drive letter or a UNC host. A root-relative "\dir" is absolute to
 * path.win32 but resolves against whichever drive is current (the plugin's for fileExists,
 * spec.cwd's for the spawn), so it names no one file.
 */
function isFullPath(ctx: Ctx, p: string): boolean {
  return ctx.P.isAbsolute(p) && (!ctx.win || /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/][^\\/]/.test(p));
}

/** PlannerFs.stat when the seam has it and the call succeeds; undefined otherwise. */
async function statOf(fs: PlannerFs, p: string): Promise<FileStat | undefined> {
  if (!fs.stat) return undefined;
  return fs.stat(p).then(
    (s) => s,
    () => undefined,
  );
}

/** The same file (hard links included): equal dev and ino. An ino of 0 (a file system without ids) proves nothing. */
function sameFile(a: FileStat, b: FileStat): boolean {
  return String(a.ino) !== "0" && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
}

/** A PATH node that is really Bun: `bun run` links a temporary `node` to itself when node is missing. */
async function isBunLink(ctx: Ctx, fs: PlannerFs, f: string): Promise<boolean> {
  if (!fs.realpath) return false;
  const real = await fs.realpath(f).then(
    (x) => stripWinPrefix(ctx, x),
    () => f,
  );
  return /^bun(?:\.exe)?$/i.test(ctx.P.basename(real));
}

// ---------------------------------------------------------------------------------------------
// G + H. Changed files and argv construction
// ---------------------------------------------------------------------------------------------

const JS_TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Python's fnmatch.fnmatch (the matcher behind pytest's python_files), in linear-time form: `*`
 * matches any run of characters (separators included), `?` one character, `[...]` / `[!...]` a set
 * with ranges, and an unclosed `[` is literal. `fold` compares case-insensitively (win32 normcase).
 * A greedy two-pointer match, so a hostile pattern cannot backtrack exponentially.
 */
function fnmatch(pattern: string, name: string, fold: boolean): boolean {
  const pat = fold ? pattern.toLowerCase() : pattern;
  const s = fold ? name.toLowerCase() : name;
  type Tok = { readonly star: true } | { readonly star: false; readonly test: (c: string) => boolean };
  const toks: Tok[] = [];
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") {
      if (!toks.at(-1)?.star) toks.push({ star: true });
      continue;
    }
    if (c === "?") {
      toks.push({ star: false, test: () => true });
      continue;
    }
    let close = -1;
    if (c === "[") {
      let j = i + 1;
      if (pat[j] === "!") j++;
      if (pat[j] === "]") j++;
      close = pat.indexOf("]", j);
    }
    if (close < 0) {
      toks.push({ star: false, test: (x) => x === c });
      continue;
    }
    const neg = pat[i + 1] === "!";
    const body = pat.slice(i + (neg ? 2 : 1), close);
    toks.push({ star: false, test: (x) => fnmatchSet(body, x) !== neg });
    i = close;
  }
  let p = 0;
  let k = 0;
  let starP = -1;
  let starK = 0;
  while (k < s.length) {
    const t = toks[p];
    if (t && t.star) {
      starP = p++;
      starK = k;
    } else if (t && t.test(s[k])) {
      p++;
      k++;
    } else if (starP >= 0) {
      p = starP + 1;
      k = ++starK;
    } else {
      return false;
    }
  }
  while (toks[p]?.star) p++;
  return p === toks.length;
}

/** One fnmatch set body: single characters and a-z ranges. */
function fnmatchSet(body: string, c: string): boolean {
  for (let i = 0; i < body.length; i++) {
    if (body[i + 1] === "-" && i + 2 < body.length) {
      if (c >= body[i] && c <= body[i + 2]) return true;
      i += 2;
    } else if (body[i] === c) {
      return true;
    }
  }
  return false;
}

/**
 * G.8 (QA-1.3-33): pytest's python_files rule (_pytest/pathlib.py fnmatch_ex). A pattern without a
 * separator matches the basename; one with a separator matches the whole path, with "*" and a
 * separator put in front of a relative pattern. win32 compares case-insensitively with either
 * separator.
 */
function isPyTestFile(ctx: Ctx, patterns: readonly string[], abs: string): boolean {
  const norm = (s: string) => (ctx.win ? s.replace(/\\/g, "/") : s);
  const base = ctx.P.basename(abs);
  return patterns.some((raw) => {
    const pat = norm(raw);
    if (!pat.includes("/")) return fnmatch(pat, base, ctx.win);
    return fnmatch(ctx.P.isAbsolute(raw) ? pat : `*/${pat}`, norm(abs), ctx.win);
  });
}

/**
 * G.8: the test basenames for a module stem, from each basename pattern with exactly one `*` and no
 * other wildcard ("test_*.py" -> "test_<stem>.py"). A literal name (pytest-django's "tests.py")
 * or a path pattern names no file for a stem.
 */
function pyTestNames(patterns: readonly string[], stem: string): string[] {
  const out = new Set<string>();
  for (const p of patterns) {
    const i = p.indexOf("*");
    if (i < 0 || p.indexOf("*", i + 1) >= 0 || /[\\/?[]/.test(p)) continue;
    out.add(p.slice(0, i) + stem + p.slice(i + 1));
  }
  return [...out];
}

/** G.9: git pathspecs covering the test files of `patterns`; a path pattern widens to every .py file (hits are re-checked). */
function pyTestGlobs(patterns: readonly string[]): string[] {
  return [...new Set(patterns.map((p) => (/[\\/]/.test(p) ? ":(glob)**/*.py" : `:(glob)**/${p}`)))];
}
const NON_INPUT_EXT_RE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const NON_INPUT_NAMES = new Set(["LICENSE", "LICENCE", ".gitignore", ".gitattributes", ".editorconfig", ".npmignore", ".prettierignore"]);
/** JS dependency and workspace files (G.7, QA-1.3-8): a lockfile-only change can upgrade a dependency. */
const JS_DEPS = String.raw`package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pnpm-workspace\.yaml|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs`;
const TRIGGERS: Record<RunnerKind, RegExp> = {
  vitest: new RegExp(String.raw`^(?:package\.json|vitest\.config\..+|vite\.config\..+|vitest\.workspace\..+|vitest\.projects\..+|tsconfig.*\.json|${JS_DEPS})$`),
  jest: new RegExp(String.raw`^(?:package\.json|jest\.config\..+|babel\.config\..+|\.babelrc|\.babelrc\..+|tsconfig.*\.json|${JS_DEPS})$`),
  pytest:
    /^(?:conftest\.py|pyproject\.toml|\.?pytest\.ini|\.?pytest\.toml|setup\.cfg|setup\.py|tox\.ini|uv\.lock|poetry\.lock|pdm\.lock|[Pp]ipfile(?:\.lock)?|requirements[\w.-]*\.(?:txt|in)|constraints[\w.-]*\.txt)$/,
};
/** G.7 (QA-1.3-23): pip requirement files kept in a `requirements/` directory (requirements/base.txt, dev.in). */
const PY_REQ_DIR_FILE_RE = /\.(?:txt|in)$/i;
const JS_EXT = String.raw`\.[cm]?[jt]sx?$`;
const JS_EXT_RE = new RegExp(JS_EXT, "i");
/**
 * G.7 (QA-1.3-15, QA-1.3-28, QA-1.3-29): vitest/jest setup files by name. A SUPERSET of the rule
 * 1.6 risk.ts uses (QA-1.6-21: `*.setup.<js/ts>` and its basenames), plus the names with a test
 * marker that round 2 caught: jest-setup.js, jest.setupAfterEnv.js, testSetup.ts, setupVitest.ts,
 * setupFilesAfterEnv.ts, globalTeardown.ts, ... vitest reruns every test for a setupFiles change
 * and jest's related-test graph never reaches one (QA-1.3-29: `--findRelatedTests <setup>` ran 0
 * tests, exit 0), so both fail closed. A bare `setup.ts` or `SetupWizard.tsx` is application code
 * unless it lies in a test directory (SETUP_DIR_RE). All alternatives are anchored and linear.
 */
const SETUP_FILE_RE = new RegExp(
  [
    String.raw`\.setup${JS_EXT}`,
    String.raw`^(?:setupTests|setup-tests|test-setup|global-setup|globalSetup|vitest\.setup|jest\.setup|setup-jest|jest-setup|vitest-setup|global-teardown)${JS_EXT}`,
    String.raw`^(?:jest|vitest|tests?)[._-]?(?:setup|teardown)[\w.-]*${JS_EXT}`,
    String.raw`^setup[._-]?(?:tests?|jest|vitest|env|after[._-]?env|files?(?:[._-]?after[._-]?env)?)${JS_EXT}`,
    String.raw`^global[._-]?(?:setup|teardown)[\w.-]*${JS_EXT}`,
  ].join("|"),
  "i",
);
/** G.7 (QA-1.3-29): a bare setup/teardown file counts when a directory above it is a test directory (test/setup.js). */
const SETUP_BARE_RE = new RegExp(String.raw`^(?:setup|teardown)${JS_EXT}`, "i");
const SETUP_DIR_RE = /^(?:tests?|specs?|testing|jest|vitest|__tests__)$/i;

/** The JS runner config files scanned for static references (G.7a), per directory from runnerCwd up to gitRoot. */
const JS_CONFIG_EXTS = ["js", "ts", "mjs", "cjs", "mts", "cts"];
const JS_CONFIG_NAMES: Readonly<Record<"vitest" | "jest", readonly string[]>> = {
  vitest: ["vitest.config", "vite.config"].flatMap((b) => JS_CONFIG_EXTS.map((x) => `${b}.${x}`)),
  jest: [...JS_CONFIG_EXTS.map((x) => `jest.config.${x}`), "jest.config.json", "package.json"],
};
/** Config keys whose values name setup files (vitest and jest share them). */
const SETUP_KEYS = ["setupFiles", "setupFilesAfterEnv", "globalSetup", "globalTeardown"] as const;
const CONFIG_KEY_RE = /(?<![\w$])["']?(setupFiles|setupFilesAfterEnv|globalSetup|globalTeardown|rootDir|root)["']?[ \t]*:[ \t\r\n]*/g;

/**
 * G.7a: the string literals a JS/TS/JSON config assigns to CONFIG_KEY_RE's keys, statically.
 * QA-1.3-45: the value is the whole expression up to the next "," or ";" at depth 0, or the
 * bracket that closes the enclosing object, so a scalar call counts like an array element:
 * `globalSetup: require.resolve('./x')`, `path.resolve(__dirname, 'x')`, a ternary's branches and
 * the literal elements of `[...defaults, './x']` all yield their literals. A key present with no
 * literal value maps to []. Comments are skipped; a template literal with `${` is not static, and
 * an unterminated string ends the value. One forward pass: the key search resumes after each
 * scanned value, so the cost stays linear.
 * QA-1.3-50: a call's literal arguments are also joined with "/", run by run, so
 * `path.join(__dirname, 'src', 'testing', 'boot.js')` yields "src/testing/boot.js". A run that
 * starts the call or follows a path base (PATH_BASES) resolves like any literal (`lits`); a run
 * after any other argument (a variable, another call) is a path tail (`floating`).
 */
const isQuote = (c: string | undefined): boolean => c === '"' || c === "'" || c === "`";

/** QA-1.3-50: call arguments that stand for a directory the config's references resolve against (the config's, runnerCwd). */
const PATH_BASES: ReadonlySet<string> = new Set(["__dirname", "import.meta.dirname", "process.cwd()"]);

/** One argument of a call, from `start` to `end`: a lone static string (`lit`), or anything else (`other`). */
interface CallArg {
  readonly start: number;
  end?: number;
  lit?: string;
  other: boolean;
}

interface ConfigLits {
  /** Each key's string literals, and the joined runs of literal call arguments that resolve like them. */
  readonly lits: Map<string, string[]>;
  /** QA-1.3-50: each key's joined runs of literal call arguments after an argument the scan cannot resolve. */
  readonly floating: Map<string, string[]>;
}

function configLiterals(text: string): ConfigLits {
  const lits = new Map<string, string[]>();
  const floating = new Map<string, string[]>();
  const re = new RegExp(CONFIG_KEY_RE.source, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const vals = lits.get(m[1]) ?? [];
    lits.set(m[1], vals);
    const floats = floating.get(m[1]) ?? [];
    floating.set(m[1], floats);
    // One entry per open bracket: a call's arguments for "(", undefined for "[" and "{".
    const frames: (CallArg[] | undefined)[] = [];
    const arg = (): CallArg | undefined => frames.at(-1)?.at(-1);
    let i = m.index + m[0].length;
    while (i < text.length) {
      const c = text[i];
      if (isQuote(c)) {
        let v = "";
        let j = i + 1;
        for (; j < text.length && text[j] !== c && !(text[j] === "\n" && c !== "`"); j++) v += text[j] === "\\" ? (text[++j] ?? "") : text[j];
        i = j + 1;
        if (text[j] !== c) break;
        const a = arg();
        const staticText = !(c === "`" && v.includes("${"));
        if (staticText) vals.push(v);
        if (a && staticText && a.lit === undefined && !a.other) a.lit = v;
        else if (a) a.other = true;
      } else if (text.startsWith("//", i)) {
        const nl = text.indexOf("\n", i);
        i = nl < 0 ? text.length : nl;
      } else if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        i = end < 0 ? text.length : end + 2;
      } else if (c === "(" || c === "[" || c === "{") {
        const a = arg();
        if (a) a.other = true;
        frames.push(c === "(" ? [{ start: i + 1, other: false }] : undefined);
        i++;
      } else if (c === ")" || c === "]" || c === "}") {
        if (frames.length === 0) break;
        const args = frames.pop();
        if (args) {
          args[args.length - 1].end = i;
          joinCallArgs(text, args, vals, floats);
        }
        i++;
      } else if ((c === "," || c === ";") && frames.length === 0) {
        break;
      } else {
        const args = frames.at(-1);
        if (c === "," && args) {
          args[args.length - 1].end = i;
          args.push({ start: i + 1, other: false });
        } else if (!/\s/.test(c)) {
          const a = arg();
          if (a) a.other = true;
        }
        i++;
      }
    }
    re.lastIndex = Math.max(re.lastIndex, i);
  }
  return { lits, floating };
}

/** QA-1.3-50: each run of lone literal arguments of one call, "/"-joined, into `vals` (after the call's start or a PATH_BASES argument) or `floats`. */
function joinCallArgs(text: string, args: readonly CallArg[], vals: string[], floats: string[]): void {
  let run: string[] = [];
  let anchored = true;
  const flush = () => {
    if (run.length > (anchored ? 1 : 0)) (anchored ? vals : floats).push(run.join("/"));
    run = [];
  };
  for (const a of args) {
    if (a.lit !== undefined && !a.other) {
      run.push(a.lit);
      continue;
    }
    flush();
    const raw = text.slice(a.start, a.end).replace(/\s+/g, "");
    // An empty argument (`f()`, a trailing comma) changes nothing.
    if (raw !== "") anchored = PATH_BASES.has(raw);
  }
  flush();
}

/**
 * QA-1.3-50: the path tail a floating reference names: its segments after the last "..", "<...>"
 * or drive-like one ("" and "." dropped), "/"-joined; undefined when none is left.
 */
function pathTail(v: string): string | undefined {
  const segs = v.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  let k = segs.length;
  while (k > 0 && segs[k - 1] !== ".." && !/[<:]/.test(segs[k - 1])) k--;
  return k === segs.length ? undefined : segs.slice(k).join("/");
}

/** QA-1.3-50: some tail of `p` ("c", "b/c", "a/b/c" for .../a/b/c), as a key, is in `tails`. */
function hasTail(ctx: Ctx, tails: ReadonlySet<string>, p: string): boolean {
  const segs = ctx.key(p).split(/[\\/]+/);
  for (let k = segs.length - 1; k >= 1; k--) if (tails.has(segs.slice(k).join("/"))) return true;
  return false;
}

/** What the vitest/jest configs say statically (G.7a, QA-1.3-29). */
interface JsConfigFacts {
  /** Keys of the files named as setupFiles/setupFilesAfterEnv/globalSetup/globalTeardown. */
  readonly setupKeys: ReadonlySet<string>;
  /** The same for references without an extension, which jest resolves (compared without the extension, or as a directory index). */
  readonly setupStems: ReadonlySet<string>;
  /** QA-1.3-50: path tails ("testing/boot.js") of references built on an argument the scan cannot resolve; any file ending with one counts. */
  readonly setupTails: ReadonlySet<string>;
}

/**
 * G.7a: read the vitest or jest config files (every directory from runnerCwd up to gitRoot, and the
 * --config file) once, plus jest's inline JSON --config (QA-1.3-41, rooted at runnerCwd). setup
 * references from any of them are triggers: a superset only adds S6. A reference resolves against
 * the config's directory and runnerCwd (vitest) or every literal rootDir (jest; `<rootDir>` is
 * replaced by each base). JSON files are also read with JSON.parse, so escaped keys and paths
 * count. QA-1.3-42: only a reference whose last segment names a changed file (its basename, its
 * stem, or its directory for an index file: `names`) is resolved, each distinct one once, within
 * SETUP_REF_LIMIT resolutions per plan (else S6 config-too-large); a planted config of 262000
 * literals cost 3.6 s of path resolution under Bun. Exclusions are not read (G.8a, QA-1.3-38).
 * QA-1.3-44: a project's own config (jest/vitest `projects`) lies in the project's directory, at
 * or above its setup files, so the configs in every directory from each changed JS/TS module (not
 * a test file) up to gitRoot are read too, with that directory as a base. vitest's literal `root`
 * values (inline projects) are bases, against the config's directory and runnerCwd. QA-1.3-45:
 * jest's `--rootDir` on the command line (jest-config's setFromArgv) is a base and a `<rootDir>`.
 */
async function jsConfigFacts(
  ctx: Ctx,
  fs: PlannerFs,
  det: DetectedRunner,
  names: ReadonlySet<string>,
  changed: readonly FileRef[],
): Promise<JsConfigFacts | Unverifiable> {
  const P = ctx.P;
  const kind = det.kind === "jest" ? "jest" : "vitest";
  const files = new Set<string>(det.configFiles ?? []);
  const dirs = new Map(ancestors(ctx, det.runnerCwd, det.gitRoot).map((d) => [ctx.key(d), d]));
  const top = ctx.key(det.gitRoot);
  for (const f of changed) {
    if (!JS_EXT_RE.test(f.abs) || isJsTestPath(f.rel)) continue;
    // Every directory already listed has its parents listed too, so the walk stops at the first one.
    for (let d = P.dirname(f.abs); !dirs.has(ctx.key(d)); d = P.dirname(d)) {
      dirs.set(ctx.key(d), d);
      if (ctx.key(d) === top || P.dirname(d) === d) break;
    }
  }
  // QA-1.3-51: one listing per directory where the seam can list (hasEntry). The listings are
  // started together; the configs are still taken in directory order.
  await Promise.all([...dirs.values()].map((d) => dirListing(ctx, fs, d)));
  for (const d of dirs.values()) {
    for (const n of JS_CONFIG_NAMES[kind]) {
      if (await hasEntry(ctx, fs, d, n)) files.add(P.join(d, n));
    }
  }
  const cliRoot = kind === "jest" ? jestCliRootDir(det) : undefined;
  const setupKeys = new Set<string>();
  const setupStems = new Set<string>();
  const setupTails = new Set<string>();
  const trailing = ctx.win ? /[\\/]+$/ : /\/+$/;
  // The last segment of a reference; "", ".", "..", "<rootDir>" or a drive only resolve to know.
  const wanted = (v: string): boolean => {
    const t = v.replace(trailing, "");
    const seg = t.slice(Math.max(t.lastIndexOf("/"), ctx.win ? t.lastIndexOf("\\") : -1) + 1);
    return seg === "" || seg === "." || seg === ".." || /[<:]/.test(seg) || names.has(ctx.key(seg));
  };
  // QA-1.3-42: path resolution is the cost (about 12 us a call under Bun on win32), so it is
  // bounded per plan: distinct wanted references times bases, plus the rootDir literals.
  let budget = SETUP_REF_LIMIT;
  const usable = (v: string) => v.trim() !== "" && !/[*?{}]/.test(v) && wanted(v);
  const addRefs = (lits: ReadonlyMap<string, readonly string[]>, dir: string, where: string, floating?: ReadonlyMap<string, readonly string[]>): Unverifiable | undefined => {
    const refs = new Set<string>();
    const tails = new Set<string>();
    for (const key of SETUP_KEYS) {
      for (const v of lits.get(key) ?? []) if (usable(v)) refs.add(v);
      for (const v of floating?.get(key) ?? []) {
        const t = pathTail(v);
        if (t !== undefined && usable(t)) tails.add(ctx.key(t));
      }
    }
    // QA-1.3-50: a tail costs one set entry, and a suffix check per changed file.
    budget -= tails.size;
    if (budget < 0) return s6("config-too-large", `too many setup references in ${where} (limit ${SETUP_REF_LIMIT})`);
    for (const t of tails) setupTails.add(t);
    if (refs.size === 0) return undefined;
    const rootLits = [...new Set(lits.get(kind === "jest" ? "rootDir" : "root"))];
    const fixed = kind === "jest" ? (cliRoot === undefined ? [] : [P.resolve(det.runnerCwd, cliRoot)]) : [det.runnerCwd];
    const perLit = kind === "jest" ? 1 : 2;
    // Counted before any root literal is resolved, so a planted config cannot buy the cost back.
    budget -= refs.size * (1 + fixed.length + rootLits.length * perLit) + rootLits.length * perLit;
    if (budget < 0) return s6("config-too-large", `too many setup references in ${where} (limit ${SETUP_REF_LIMIT})`);
    const roots = rootLits.flatMap((r) => (kind === "jest" ? [P.resolve(dir, r)] : [P.resolve(dir, r), P.resolve(det.runnerCwd, r)]));
    const bases = [...new Map([dir, ...fixed, ...roots].map((b) => [ctx.key(b), b])).values()];
    for (const v of refs) {
      for (const b of bases) {
        const abs = P.resolve(b, v.replace(/<rootDir>/g, b));
        (JS_EXT_RE.test(v) ? setupKeys : setupStems).add(ctx.key(abs));
      }
    }
    return undefined;
  };
  for (const file of files) {
    const t = await readConfigText(ctx, fs, file);
    if (t === "too-large") return tooLarge(file);
    if (t === "unreadable") continue;
    const { lits, floating } = configLiterals(t.text);
    if (P.extname(file) === ".json") {
      // QA-1.3-46: jest-config reads a JSON config as parseJson(stripJsonComments(text)). One that
      // still does not parse fails the user's run; package.json is the exception, because jest's
      // lookup skips a package.json that JSON.parse rejects.
      const parsed = parseJson(stripJsonComments(t.text));
      if (parsed === undefined && P.basename(file) !== "package.json") {
        return s6("unsupported-argument", `unsupported ${det.kind} config: ${file} does not parse as JSON`);
      }
      for (const [k, vs] of jsonLiterals(parsed)) lits.set(k, [...(lits.get(k) ?? []), ...vs]);
    }
    const bad = addRefs(lits, P.dirname(file), file, floating);
    if (bad) return bad;
  }
  for (const c of det.inlineConfigs ?? []) {
    const bad = addRefs(jsonLiterals(parseJson(c)), det.runnerCwd, "the inline jest --config");
    if (bad) return bad;
  }
  return { setupKeys, setupStems, setupTails };
}

/** QA-1.3-45: the last jest `--rootDir` in the kept arguments; jest-config's setFromArgv puts it over every config's rootDir. */
function jestCliRootDir(det: DetectedRunner): string | undefined {
  const K = det.keptArgs;
  let v: string | undefined;
  for (let i = 0; i < K.length; i++) {
    const t = camelOption(K[i]);
    if (t === "--rootDir") v = K[++i];
    else if (t.startsWith("--rootDir=")) v = t.slice("--rootDir=".length);
  }
  return v;
}

/** The keys configLiterals and jsonLiterals collect. */
const CONFIG_KEYS: readonly string[] = [...SETUP_KEYS, "rootDir"];

/**
 * G.7a (QA-1.3-41): configLiterals for parsed JSON, so JSON escapes in keys and paths are decoded:
 * the string (or the string elements of an array) of every CONFIG_KEYS key at any depth. The walk
 * uses its own stack, so a deeply nested value cannot overflow the call stack.
 */
function jsonLiterals(value: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (isRecord(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (CONFIG_KEYS.includes(k)) {
          const vals = out.get(k) ?? [];
          out.set(k, vals);
          for (const y of Array.isArray(x) ? x : [x]) if (typeof y === "string") vals.push(y);
        }
        stack.push(x);
      }
    }
  }
  return out;
}

/** G.7a: `abs` is a setup file a config names (with its extension, or without it / as a directory index). */
function isReferencedSetup(ctx: Ctx, facts: JsConfigFacts, abs: string): boolean {
  if (facts.setupKeys.has(ctx.key(abs))) return true;
  const ext = ctx.P.extname(abs);
  const stem = ext === "" ? abs : abs.slice(0, -ext.length);
  const index = ctx.P.basename(stem) === "index";
  if (facts.setupStems.has(ctx.key(stem)) || (index && facts.setupStems.has(ctx.key(ctx.P.dirname(abs))))) return true;
  // QA-1.3-50: a tail names the file with its extension, without it, or as a directory index.
  const T = facts.setupTails;
  return T.size > 0 && (hasTail(ctx, T, abs) || hasTail(ctx, T, stem) || (index && hasTail(ctx, T, ctx.P.dirname(abs))));
}


const NOTE_NO_CHANGES = "no changed files, no affected tests";
const NOTE_NO_INPUT = "no affected tests: no changed file is a test input";
/** G.8 (E2E-1): conftest.py files are searched with the test files: a module one references is S6. */
const CONFTEST_GLOB = ":(glob)**/conftest.py";
const NOTE_NO_LINT = "no changed lintable files";
const NOTE_NO_RERUN = "no rerun: none of the test files exist in this tree";

interface FileRef {
  /** G.4b: a file of the cross-link repository W; abs is its real path and rel is relative to W's real top. */
  readonly external?: true;
  readonly abs: string;
  readonly rel: string;
  /** The basename as the producer spelled it, before realpath (a trigger reached through a symlink). */
  readonly lexBase?: string;
}

function stemOf(ctx: Ctx, abs: string): string {
  const base = ctx.P.basename(abs);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem === "index" || stem === "__init__" ? ctx.P.basename(ctx.P.dirname(abs)) : stem;
}

/** git grep -w's word characters (ASCII letters, digits, "_"; a non-ASCII character is a boundary). */
const WORD_CHAR_RE = /[A-Za-z0-9_]/;

/** The whole-word occurrences of `name` in `text`, as git grep -w finds them (overlaps included). */
function countWords(text: string, name: string): number {
  let n = 0;
  for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
    if (!WORD_CHAR_RE.test(text.charAt(i - 1)) && !WORD_CHAR_RE.test(text.charAt(i + name.length))) n++;
  }
  return n;
}

/** `from [dots]<dotted path> import`: the path (group 2) is a module path. */
const PY_FROM_PATH_RE = /^([ \t]*from[ \t]+\.*)([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)(?=[ \t]+import(?![A-Za-z0-9_]))/;
/** `import <items>[# comment]`. */
const PY_IMPORT_LINE_RE = /^([ \t]*import[ \t]+)([^#]*)(.*)$/;
/** One `<dotted path>[ as <name>]` item of an import statement. */
const PY_IMPORT_ITEM_RE = /^([ \t]*)([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)((?:[ \t]+as[ \t]+[A-Za-z0-9_]+)?[ \t]*)$/;

/** A dotted module path without its first segment when that is `name` and more segments follow. */
function dropPackageHead(dotted: string, name: string): string {
  const dot = dotted.indexOf(".");
  return dot > 0 && dotted.slice(0, dot) === name ? dotted.slice(dot) : dotted;
}

/**
 * One line with `name` blanked where it heads a longer module path of an import statement
 * (`from app.mod01 import x`, `from ..app.mod01 import x`, `import app.mod01, os as o`). A line
 * that is not a plain one-line `from … import` or `import a.b[ as c], …` statement is returned
 * unchanged, so every occurrence in it still counts.
 */
function withoutPackageHeads(line: string, name: string): string {
  const from = PY_FROM_PATH_RE.exec(line);
  if (from) return from[1] + dropPackageHead(from[2], name) + line.slice(from[0].length);
  const imp = PY_IMPORT_LINE_RE.exec(line);
  if (!imp) return line;
  const items: string[] = [];
  for (const it of imp[2].split(",")) {
    const m = PY_IMPORT_ITEM_RE.exec(it);
    if (!m) return line;
    items.push(m[1] + dropPackageHead(m[2], name) + m[3]);
  }
  return imp[1] + items.join(",") + imp[3];
}

/**
 * QA-G-10 (G.8): of the whole-word hits of `name`, for a module named like the regular package
 * that holds it (app/app.py beside app/__init__.py), the files that may import it. A file is
 * dropped only when it provably does not: every whole-word occurrence of `name` heads a longer
 * module path in an import statement (`from app.mod01 import x`), where `name` is that package
 * (the QA-G-2 over-match). Any doubt keeps the file: a stat or read that fails, a file over
 * CONFIG_SIZE_LIMIT (checked with fs.stat before the read, as config reads are, and after it), or a
 * read that finds no occurrence at all (git saw one). Lines split at CRLF, LF and CR, as Python
 * reads them. Keeping a file only ever adds a test.
 */
async function keepImporters(fs: PlannerFs, hits: readonly string[], name: string): Promise<string[]> {
  const out: string[] = [];
  for (const h of hits) {
    const text = await readBounded(fs, h);
    if (text === undefined || countWords(text, name) === 0) out.push(h);
    else if (countWords(text.split(/\r\n|\r|\n/).map((l) => withoutPackageHeads(l, name)).join("\n"), name) > 0) out.push(h);
  }
  return out;
}

/**
 * A file's text through the fs seam, or undefined when the stat or the read fails or the file is
 * over CONFIG_SIZE_LIMIT (by fs.stat, checked before the read, or by the read's length).
 */
async function readBounded(fs: PlannerFs, abs: string): Promise<string | undefined> {
  try {
    const st = fs.stat ? await fs.stat(abs) : undefined;
    if (st && Number(st.size) > CONFIG_SIZE_LIMIT) return undefined;
    const text = await fs.readFile(abs);
    return text.length > CONFIG_SIZE_LIMIT ? undefined : text;
  } catch {
    return undefined;
  }
}

/** G.4b (cross-repo P3a): the cross-link repository W as the planner sees it. */
interface CrossLink {
  /** realOf(crossLinkRoot): external FileRefs lie below it and are relative to it. */
  readonly real: string;
  /** W's top as given (crossLinkRoot), then each crossLinkAliases entry, absolute and in order. */
  readonly spellings: readonly string[];
}

/** SD-P3a-4: the vitest major whose `related` run across a link is pinned (the Y5 integration test). */
const CROSS_LINK_VITEST_MAJOR = 5;

/** G.4b: W from the input, or undefined without a usable crossLinkRoot (then nothing of G.4b applies). */
async function crossLinkOf(ctx: Ctx, fs: PlannerFs, cwd: string, input: StaticScopingInput): Promise<CrossLink | undefined> {
  const usable = (p: string | undefined): p is string => p !== undefined && p !== "" && !p.includes("\0");
  if (!usable(input.crossLinkRoot)) return undefined;
  const abs = (p: string) => ctx.P.resolve(cwd, stripWinPrefix(ctx, p));
  const given = abs(input.crossLinkRoot);
  return { real: await realOf(ctx, fs, given), spellings: [given, ...(input.crossLinkAliases ?? []).filter(usable).map(abs)] };
}

/** True when a segment of `p` is node_modules: vitest's related graph skips such ids (X4). */
function hasNodeModulesSegment(ctx: Ctx, p: string): boolean {
  return p.split(/[\\/]/).some((s) => ctx.key(s) === "node_modules");
}

/**
 * SD-P3a-2: every spelling of the external file `f` vitest may hold as a module id: its real path
 * (as realOf produced it), then each of W's spellings + its relative path. Deduplicated by exact
 * string (a case-only variant is another id to vitest); a spelling with a node_modules segment is
 * never passed.
 */
function crossSpellings(ctx: Ctx, cross: CrossLink, f: FileRef): string[] {
  const parts = f.rel.split("/");
  const all = [f.abs, ...cross.spellings.map((d) => ctx.P.join(d, ...parts))];
  return [...new Set(all)].filter((s) => !hasNodeModulesSegment(ctx, s));
}

/** G.4b: a W test file (classify's JS rule). The consumer's related run never runs W's own tests. */
function isCrossTest(ctx: Ctx, f: FileRef): boolean {
  return JS_TEST_RE.test(ctx.P.basename(f.abs)) || f.rel.split("/").includes("__tests__");
}

/**
 * G.4b (SD-P3a-4, SD-P3a-7): the S6s the external files reach without a config read or a search,
 * so planScopedRun and planStaticScoping agree. Non-input external files (G.8) are never looked
 * at here; classify skips them. The vitest major is checked after the entry is resolved (classify).
 */
async function crossLinkChecks(
  ctx: Ctx,
  fs: PlannerFs,
  det: Detected<RunnerKind>,
  sorted: readonly FileRef[],
  cross: CrossLink,
): Promise<Unverifiable | undefined> {
  const ext = sorted.filter((f) => f.external === true && !isNonInput(ctx, f));
  if (ext.length === 0) return undefined;
  if (det.kind !== "vitest") {
    return s6("cross-link-unsupported", `a change in a linked repository needs vitest ${CROSS_LINK_VITEST_MAJOR} to scope: this check runs ${det.kind}`);
  }
  for (const f of ext) {
    if (namesOf(ctx, f).some((b) => TRIGGERS.vitest.test(b))) return s6("config-changed", `config file changed in the linked repository: ${f.rel}`);
  }
  for (const f of ext) {
    if (isCrossTest(ctx, f)) continue;
    if (!(await existsCached(ctx, fs, f.abs))) {
      return s6("cross-link-gone", `changed file gone in the linked repository (deleted or renamed away): ${f.rel}`);
    }
    if (crossSpellings(ctx, cross, f).length === 0) {
      return s6("cross-link-unsupported", `every spelling of ${f.rel} in the linked repository lies under node_modules, which vitest related skips`);
    }
  }
  return undefined;
}

/** SD-P3a-4: the resolved vitest's major must be CROSS_LINK_VITEST_MAJOR. */
function crossLinkVersion(entry: ResolvedEntry): Unverifiable | undefined {
  if (Number.parseInt(entry.version ?? "", 10) === CROSS_LINK_VITEST_MAJOR) return undefined;
  const found = entry.version === undefined ? "of an unknown version" : entry.version;
  return s6("cross-link-unsupported", `a change in a linked repository needs vitest ${CROSS_LINK_VITEST_MAJOR} to scope: the resolved vitest is ${found}`);
}

/** G.3-G.5 for one path: canonical absolute path inside gitRoot, or undefined. */
function canonicalize(ctx: Ctx, cwd: string, gitRoot: string, p: string): FileRef | undefined {
  const abs = ctx.P.resolve(cwd, p);
  const rel = ctx.P.relative(gitRoot, abs);
  if (rel === "" || ctx.P.isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..") return undefined;
  return { abs: ctx.P.join(gitRoot, rel), rel: toSlash(ctx, rel) };
}

async function plan(input: StaticScopingInput, search: TestSearchSeam): Promise<ScopingPlan>;
async function plan(input: StaticScopingInput, search: undefined): Promise<StaticScoping>;
async function plan(input: StaticScopingInput, search: TestSearchSeam | undefined): Promise<ScopingPlan | StaticScoping> {
  const ctx = makeCtx(input.host);
  const P = ctx.P;
  const fs = input.fs;
  if (input.changedFiles === "unavailable") return s6("attribution-unavailable", "change attribution unavailable");
  if (input.changedFiles.length === 0) return noAffected(NOTE_NO_CHANGES);

  const det = await detectImpl(ctx, input.command, input.cwd, fs, TEST_HEADS);
  if (isS6(det)) return det;
  const gitRoot = det.gitRoot;
  const cwd = await canonicalCwd(ctx, fs, input.cwd);
  const notes: string[] = [...det.notes];
  const cross = await crossLinkOf(ctx, fs, cwd, input);
  const sorted = await collectChanged(ctx, fs, cwd, gitRoot, input.changedFiles, notes, cross);
  if (sorted.length === 0) return s6("attribution-unavailable", NO_PATH_KEPT);
  if (cross) {
    const bad = await crossLinkChecks(ctx, fs, det, sorted, cross);
    if (bad) return bad;
  }
  // G.4b: G.7 and G.7a look at the in-repo files only, so no config read walks into W.
  const local = cross ? sorted.filter((f) => f.external !== true) : sorted;

  // G.7: config triggers.
  const sourcePj = det.source.type === "script" ? ctx.key(det.source.packageJson) : undefined;
  const configKeys = new Set((det.configFiles ?? []).map((p) => ctx.key(p)));
  const js = det.kind === "vitest" || det.kind === "jest";
  if (js) {
    const early = await jsCheapChecks(ctx, fs, cross ? sorted.filter((f) => !(f.external === true && isCrossTest(ctx, f))) : sorted);
    if (early) return early;
  }
  const facts = js ? await jsConfigFacts(ctx, fs, det, changedNames(ctx, local), local) : undefined;
  if (facts && isS6(facts)) return facts;
  for (const f of local) {
    const names = namesOf(ctx, f);
    const segs = f.rel.split("/");
    // QA-1.3-29: a setup file by name (not a test file), a bare setup.* in a test directory, or a
    // file the vitest/jest config names as a setup file.
    const setup =
      js &&
      ((!isJsTestPath(f.rel) && (names.some((b) => SETUP_FILE_RE.test(b)) || (names.some((b) => SETUP_BARE_RE.test(b)) && segs.slice(0, -1).some((s) => SETUP_DIR_RE.test(s))))) ||
        (facts !== undefined && isReferencedSetup(ctx, facts, f.abs)));
    const reqDir = det.kind === "pytest" && PY_REQ_DIR_FILE_RE.test(segs[segs.length - 1]) && segs.slice(0, -1).some((s) => ctx.key(s) === "requirements");
    if (setup || reqDir || names.some((b) => TRIGGERS[det.kind].test(b)) || ctx.key(f.abs) === sourcePj || configKeys.has(ctx.key(f.abs))) {
      return s6("config-changed", `config file changed: ${f.rel}`);
    }
  }
  return classify(ctx, input, det, sorted, notes, search, cross);
}

/** G.8: docs, licences and .github files are never inputs. */
function isNonInput(ctx: Ctx, f: FileRef): boolean {
  const base = ctx.P.basename(f.abs);
  return NON_INPUT_EXT_RE.test(base) || NON_INPUT_NAMES.has(base) || f.rel.split("/").includes(".github");
}

/**
 * QA-1.3-44/47 (vitest, jest): the S6s a large change reaches without reading any config come
 * before G.7a's per-directory config reads, which then stay bounded by what one command line and
 * SEARCH_LIMIT allow. Every existing changed file that is not a non-input is a spec input (a
 * trigger among them is S6 anyway), so their quoted lengths are a lower bound of the argv (H);
 * every gone module is a pending search (G.9a).
 */
async function jsCheapChecks(ctx: Ctx, fs: PlannerFs, sorted: readonly FileRef[]): Promise<Unverifiable | undefined> {
  let pending = 0;
  let chars = 0;
  let n = 0;
  for (const f of sorted) {
    if (isNonInput(ctx, f)) continue;
    if (await existsCached(ctx, fs, f.abs)) {
      chars += (ctx.win ? winQuotedLength(f.abs) : f.abs.length) + 1;
      n++;
    } else if (!isJsTestPath(f.rel)) pending++;
  }
  if (pending > SEARCH_LIMIT) return tooManySearches(pending);
  return chars > MAX_ARGV_CHARS ? argvTooLong(n) : undefined;
}

function tooManySearches(n: number): Unverifiable {
  return s6("too-many-searches", `too many changed modules to map: ${n} test searches (limit ${SEARCH_LIMIT})`);
}

/** Change attribution that names only paths the planner cannot use (G.4a). */
const NO_PATH_KEPT = "change attribution unavailable: no changed path lies inside the git root";

/**
 * G.7a (QA-1.3-42): the last segments a config reference to one of `files` can have: each real and
 * lexical basename, its stem (a reference without an extension), and the directory name of an
 * index file (a directory reference). Keys (lower-cased on win32).
 */
function changedNames(ctx: Ctx, files: readonly FileRef[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    for (const b of [ctx.P.basename(f.abs), ...(f.lexBase !== undefined ? [f.lexBase] : [])]) {
      const dot = b.lastIndexOf(".");
      const stem = ctx.key(dot > 0 ? b.slice(0, dot) : b);
      out.add(ctx.key(b)).add(stem);
      if (stem === "index") out.add(ctx.key(ctx.P.basename(ctx.P.dirname(f.abs))));
    }
  }
  return out;
}

/** The basenames a trigger is matched against (G.7): real and lexical, lower-cased on win32. */
function namesOf(ctx: Ctx, f: FileRef): string[] {
  const names = [ctx.P.basename(f.abs), ...(f.lexBase !== undefined ? [f.lexBase] : [])];
  return names.map((b) => (ctx.win ? b.toLowerCase() : b));
}

/** G.2-G.5: candidates, normalization, dedup, sort. Empty when every candidate was dropped (G.4a). */
async function collectChanged(
  ctx: Ctx,
  fs: PlannerFs,
  cwd: string,
  gitRoot: string,
  changed: readonly ChangedPath[],
  notes: string[],
  cross?: CrossLink,
): Promise<FileRef[]> {
  const files = new Map<string, FileRef>();
  for (const c of changed) {
    for (const cand of [c.path, c.previousPath]) {
      if (cand === undefined) continue;
      if (cand.includes("\0")) {
        notes.push("dropped a path containing a NUL byte");
        continue;
      }
      const lexical = ctx.P.resolve(cwd, lexicalSpelling(ctx, cand));
      const real = await realOf(ctx, fs, lexical);
      const inRepo = canonicalize(ctx, gitRoot, gitRoot, real);
      // G.4b: outside the git root but inside the cross-link repository W -> an external file.
      const inW = inRepo || !cross ? undefined : canonicalize(ctx, cross.real, cross.real, real);
      const ref: FileRef | undefined = inRepo ?? (inW ? { ...inW, external: true } : undefined);
      if (!ref) {
        notes.push(`dropped outside the git root: ${cand}`);
        continue;
      }
      if (ref.abs.startsWith("-")) {
        notes.push(`dropped a path starting with "-": ${cand}`);
        continue;
      }
      const lexBase = ctx.P.basename(lexical);
      const full = lexBase === ctx.P.basename(ref.abs) ? ref : { ...ref, lexBase };
      if (!files.has(ctx.key(ref.abs))) files.set(ctx.key(ref.abs), full);
    }
  }
  return [...files.entries()].sort(byKey).map(([, v]) => v);
}

function byKey(a: readonly [string, unknown], b: readonly [string, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

async function classify(
  ctx: Ctx,
  input: StaticScopingInput,
  det: Detected<RunnerKind>,
  sorted: readonly FileRef[],
  notes: string[],
  search: TestSearchSeam | undefined,
  cross?: CrossLink,
): Promise<ScopingPlan | StaticScoping> {
  const P = ctx.P;
  const fs = input.fs;
  const gitRoot = det.gitRoot;
  // G.8: classification. A test file the runner's config excludes stays an input (G.8a, QA-1.3-38).
  const inputs = new Map<string, string>();
  const addInput = (abs: string) => inputs.set(ctx.key(abs), abs);
  // G.4b: the external inputs, every spelling (SD-P3a-2), deduplicated by exact string, not by key.
  const crossInputs = new Set<string>();
  const goneSources: FileRef[] = [];
  const modules: FileRef[] = [];
  const goneModules: FileRef[] = [];
  const goneTests: FileRef[] = [];
  let skipped = 0;
  // G.8b (E2E-1): without path scopes, pytest's testpaths (when they decide collection) bound the
  // test inputs: a test file the user's run never collects is not one of its tests.
  const scopes = det.pathScopes.length > 0 ? det.pathScopes : (det.collectScopes ?? []);
  const inScope = (abs: string) => isInside(ctx, det.runnerCwd, abs) && (scopes.length === 0 || scopes.some((s) => isInside(ctx, s, abs)));
  const pyFiles = det.pythonFiles ?? DEFAULT_PYTHON_FILES;

  for (const f of sorted) {
    const base = P.basename(f.abs);
    if (isNonInput(ctx, f) || (det.kind === "pytest" && !base.endsWith(".py"))) {
      skipped++;
      continue;
    }
    if (f.external === true && cross) {
      // G.4b: crossLinkChecks already returned S6 for a gone or unspellable one, and for any runner but vitest.
      if (isCrossTest(ctx, f)) notes.push(`linked repository test file not run: ${f.rel}`);
      else for (const s of crossSpellings(ctx, cross, f)) crossInputs.add(s);
      continue;
    }
    const exists = await existsCached(ctx, fs, f.abs);
    if (det.kind === "pytest") {
      const isTest = isPyTestFile(ctx, pyFiles, f.abs);
      if (exists && isTest) {
        if (inScope(f.abs)) addInput(f.abs);
      } else if (exists) modules.push(f);
      else if (ctx.key(base) === "__init__.py") {
        // QA-G-22/23: a deleted (or renamed-away) __init__.py changes how pytest's rootdir-based
        // import names every module under its directory and where on sys.path they sit (relative
        // imports fail, test modules become top-level namesakes, its modules shadow same-named
        // ones that tests anywhere import). No static mapping of that is trustworthy: fail closed,
        // before any search, even when python_files match it.
        return s6("unmapped-module", `package structure changed: ${f.rel} deleted; pytest import paths may shift`);
      } else if (isTest) {
        // QA-G-20: other tests may import it; it is searched below.
        notes.push(`deleted test file not run: ${f.rel}`);
        goneTests.push(f);
      } else goneModules.push(f);
    } else {
      const isTest = JS_TEST_RE.test(base) || f.rel.split("/").includes("__tests__");
      if (exists) addInput(f.abs);
      else if (isTest) notes.push(`deleted test file not run: ${f.rel}`);
      else goneSources.push(f);
    }
  }
  if (skipped > 0) notes.push(`non-input files skipped: ${skipped}`);

  const pending = det.kind === "pytest" ? modules.length + goneModules.length + goneTests.length : goneSources.length;
  // G.9a (QA-1.3-26): the searches are sequential processes (a git grep costs ~0.3 s in a large
  // repo), so their number is bounded. Decided before any search, so static scoping agrees.
  if (pending > SEARCH_LIMIT) {
    return tooManySearches(pending);
  }

  if (!search) {
    if (inputs.size === 0 && pending === 0 && crossInputs.size === 0) return noAffected(NOTE_NO_INPUT);
    const pre = await preflight(ctx, det, fs);
    if (isS6(pre)) return pre;
    const old = crossInputs.size > 0 ? crossLinkVersion(pre.entry) : undefined;
    if (old) return old;
    const staticNotes = [...notes, ...pre.notes];
    // QA-1.3-27: the spec-time pytest config lookup needs only the fs. Run it over the test inputs
    // known without a search, so 1.6 sees the S6 planScopedRun would return for them.
    if (inputs.size > 0) {
      const known = [...inputs.entries()].sort(byKey).map(([, v]) => v);
      const long = pytestArgvFloor(ctx, det, pre.entry, known);
      if (long) return long;
      const py = await pytestAtInputs(ctx, fs, det, known, det.runnerCwd, staticNotes);
      if (py !== undefined && isS6(py)) return py;
    }
    return { scopable: true, runner: det.kind, pendingSearches: pending, notes: staticNotes };
  }

  // G.9 and the pytest name mapping.
  const accept = (paths: readonly string[], scoped: boolean): Promise<string[]> =>
    Promise.all(
      paths.map(async (p) => {
        const ref = canonicalize(ctx, gitRoot, gitRoot, p);
        if (!ref || (scoped && !inScope(ref.abs)) || !(await fs.fileExists(ref.abs))) return undefined;
        return ref.abs;
      }),
    ).then((xs) => xs.filter((x): x is string => x !== undefined));
  const searchFailed = (f: FileRef) => s6("search-failed", `test search failed for ${f.rel}`);
  // G.8/G.9 (QA-1.3-33): names and globs follow python_files; content hits are re-checked with it.
  const pyNames = (stem: string) => pyTestNames(pyFiles, stem);
  const pyGlobs = pyTestGlobs(pyFiles);
  const byName = async (stem: string): Promise<readonly string[] | undefined> => {
    const names = pyNames(stem);
    return names.length === 0 ? [] : search.findByName(gitRoot, names);
  };

  for (const f of goneSources) {
    const stem = stemOf(ctx, f.abs);
    const hits = await search.findByContent(gitRoot, stem, JS_TEST_GLOBS);
    if (hits === undefined) return searchFailed(f);
    if (hits.length === 0) return s6("deleted-no-tests", `deleted source ${f.rel}: no test file references "${stem}"`);
    if (hits.length > STEM_MATCH_LIMIT) {
      return s6("stem-too-common", `deleted source ${f.rel}: "${stem}" appears in ${hits.length} test files (limit ${STEM_MATCH_LIMIT})`);
    }
    for (const h of await accept(hits, false)) addInput(h);
  }
  // G.8 (E2E-1, QA-G-10): an existing module maps to every test file that names it as a whole
  // word (any import layout), plus the test files named after it. Only a module named like the
  // regular package that holds it (app/app.py) drops the files that provably name only that
  // package (keepImporters, the QA-G-2 over-match); a package's __init__.py, which every import of
  // the package or of its submodules runs, keeps every hit. It fails closed: a module no in-scope
  // test maps to, or one a conftest.py references (its fixtures reach tests that never name the
  // module), is S6 unmapped-module, and one more than STEM_MATCH_LIMIT test files reference is S6
  // stem-too-common, never NoAffected.
  for (const f of modules) {
    const stem = stemOf(ctx, f.abs);
    const init = P.basename(f.abs) === "__init__.py";
    // The name a direct import spells: index.py is "index" (stemOf gives its directory's name).
    const name = init ? stem : P.basename(f.abs, ".py");
    const hits = await search.findByContent(gitRoot, name, [...pyGlobs, CONFTEST_GLOB], { word: true });
    if (hits === undefined) return searchFailed(f);
    const relevant = hits.filter((h) => P.basename(h) === "conftest.py" || isPyTestFile(ctx, pyFiles, h));
    const dir = P.dirname(f.abs);
    const namedLikePackage = !init && P.basename(dir) === name && (await existsCached(ctx, fs, P.join(dir, "__init__.py")));
    const content = namedLikePackage ? await keepImporters(fs, relevant, name) : relevant;
    // Unscoped: pytest also loads the conftest.py files above the collected tests (up to confcutdir).
    const conftests = await accept(content.filter((h) => P.basename(h) === "conftest.py"), false);
    if (conftests.length > 0) {
      const rel = toSlash(ctx, P.relative(gitRoot, conftests[0]));
      return s6("unmapped-module", `changed module ${f.rel} is referenced by ${rel}: the tests its fixtures reach cannot be mapped`);
    }
    const tests = content.filter((h) => isPyTestFile(ctx, pyFiles, h));
    if (tests.length > STEM_MATCH_LIMIT) {
      return s6("stem-too-common", `changed module ${f.rel}: ${tests.length} test files import it (limit ${STEM_MATCH_LIMIT})`);
    }
    const named = await byName(stem);
    if (named === undefined) return searchFailed(f);
    const ok = await accept([...tests, ...named], true);
    if (ok.length === 0) return s6("unmapped-module", `no test file maps to the changed module ${f.rel}`);
    for (const h of ok) addInput(h);
  }
  /**
   * The test files that name a deleted file's `name` (word: as a whole word), re-checked against
   * python_files. QA-G-19: conftest.py files are searched with them, and a hit is S6
   * unmapped-module, as for an existing module: a nested conftest.py's fixtures reach tests that
   * never name the file. More than STEM_MATCH_LIMIT test files -> S6 stem-too-common.
   */
  const goneImporters = async (f: FileRef, what: string, name: string, word: boolean): Promise<readonly string[] | Unverifiable> => {
    const globs = [...pyGlobs, CONFTEST_GLOB];
    const hits = await (word ? search.findByContent(gitRoot, name, globs, { word: true }) : search.findByContent(gitRoot, name, globs));
    if (hits === undefined) return searchFailed(f);
    // Unscoped: pytest also loads the conftest.py files above the collected tests (up to confcutdir).
    const conftests = await accept(hits.filter((h) => P.basename(h) === "conftest.py"), false);
    if (conftests.length > 0) {
      const rel = toSlash(ctx, P.relative(gitRoot, conftests[0]));
      return s6("unmapped-module", `${what} ${f.rel}: ${rel} references "${name}": the tests its fixtures reach cannot be mapped`);
    }
    const tests = hits.filter((h) => isPyTestFile(ctx, pyFiles, h));
    if (tests.length > STEM_MATCH_LIMIT) {
      return s6("stem-too-common", `${what} ${f.rel}: "${name}" appears in ${tests.length} test files (limit ${STEM_MATCH_LIMIT})`);
    }
    return tests;
  };
  /**
   * QA-G-18: a deleted module that its package's __init__.py still names as a whole word (`from
   * .index import VERSION`) breaks every import of the package, so the package name's importers
   * are inputs too (goneImporters, with the package name as a whole word). An __init__.py that
   * cannot be read, or one over CONFIG_SIZE_LIMIT, is taken to name it.
   */
  const reExporters = async (f: FileRef, name: string): Promise<readonly string[] | Unverifiable> => {
    const dir = P.dirname(f.abs);
    const init = P.join(dir, "__init__.py");
    if (!(await existsCached(ctx, fs, init))) return [];
    const text = await readBounded(fs, init);
    if (text !== undefined && countWords(text, name) === 0) return [];
    return goneImporters(f, "deleted source", P.basename(dir), true);
  };

  // QA-G-17: a deleted module is searched by the name its importers spell, as an existing one is:
  // a deleted app/index.py by "index" (`from app.index import x`, `from .index import x`), not by
  // its directory's name. The name search keeps the stem. (A deleted __init__.py never gets here:
  // it is S6 above, QA-G-22.) QA-G-18: plus its package's importers.
  for (const f of goneModules) {
    const stem = stemOf(ctx, f.abs);
    const name = P.basename(f.abs, ".py");
    const tests = await goneImporters(f, "deleted source", name, false);
    if (isS6(tests)) return tests;
    const named = await byName(stem);
    if (named === undefined) return searchFailed(f);
    const extra = await reExporters(f, name);
    if (isS6(extra)) return extra;
    const ok = await accept([...tests, ...named, ...extra], true);
    if (ok.length === 0) return s6("deleted-no-tests", `deleted source ${f.rel}: no test file references "${name}"`);
    for (const h of ok) addInput(h);
  }
  // QA-G-20: a deleted test file is a module too, and other tests may import it (`from test_base
  // import Base`, `from .test_base import x`): its Python name is searched as a whole word, and its
  // importers are inputs. A conftest.py that names it is S6 unmapped-module. A deleted test file
  // nothing names keeps only its note (a test file is a leaf).
  for (const f of goneTests) {
    const tests = await goneImporters(f, "deleted test file", P.basename(f.abs, ".py"), true);
    if (isS6(tests)) return tests;
    for (const h of await accept(tests, true)) addInput(h);
  }

  // Every pytest module and gone module above added an input or returned S6, so an empty set here
  // means no changed file was a test input or a module (docs, dropped paths, deleted test files
  // nothing imports).
  if (inputs.size === 0 && crossInputs.size === 0) return noAffected(NOTE_NO_INPUT);
  const pre = await preflight(ctx, det, fs);
  if (isS6(pre)) return pre;
  const old = crossInputs.size > 0 ? crossLinkVersion(pre.entry) : undefined;
  if (old) return old;
  const F = crossInputs.size === 0 ? [...inputs.entries()].sort(byKey).map(([, v]) => v) : withCrossInputs(ctx, inputs, crossInputs);
  const allNotes = [...notes, ...pre.notes];
  const long = pytestArgvFloor(ctx, det, pre.entry, F);
  if (long) return long;
  const py = await pytestAtInputs(ctx, fs, det, F, det.runnerCwd, allNotes);
  if (py !== undefined && isS6(py)) return py;
  return buildSpec(ctx, det, pre.entry, F, input.budget, input.cores, allNotes, "related", det.runnerCwd, gitRoot, !fs.realpath, py, crossInputs.size > 0);
}

/**
 * G.4b: the in-repo inputs (deduplicated by key) and the external spellings (deduplicated by exact
 * string, SD-P3a-2) as one sorted list: by key, then by the exact string, so case-only variants of
 * one path stay distinct and the order is deterministic.
 */
function withCrossInputs(ctx: Ctx, inputs: ReadonlyMap<string, string>, crossInputs: ReadonlySet<string>): string[] {
  const all = [...new Set([...inputs.values(), ...crossInputs])];
  return all
    .map((v) => [ctx.key(v), v] as const)
    .sort((a, b) => byKey(a, b) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([, v]) => v);
}

/** H, N.4 (QA-1.3-11): the tmpdir must be absolute and must not be inside gitRoot, lexically or after realpath. */
async function tmpdirCheck(ctx: Ctx, fs: PlannerFs, gitRoot: string): Promise<Unverifiable | undefined> {
  const t = ctx.host.tmpdir;
  if (!ctx.P.isAbsolute(t)) return s6("tmpdir-in-repo", `temp dir is not an absolute path: ${t}`);
  const lexical = ctx.P.resolve(t);
  if (isInside(ctx, gitRoot, lexical) || isInside(ctx, gitRoot, await realOf(ctx, fs, lexical))) {
    return s6("tmpdir-in-repo", `temp dir is inside the repository: ${t}`);
  }
  return undefined;
}

/** Checks that need no search: entry resolution and the tmpdir location (F, H, N.4). */
async function preflight(ctx: Ctx, det: DetectedRunner, fs: PlannerFs): Promise<{ entry: ResolvedEntry; notes: string[] } | Unverifiable> {
  const bad = await tmpdirCheck(ctx, fs, det.gitRoot);
  if (bad) return bad;
  return resolveEntryImpl(ctx, det, det.runnerCwd, fs);
}

/** N.9 (QA-1.3-14): the command line CreateProcess receives, quoted as libuv quotes it on win32. */
function commandLineLength(ctx: Ctx, file: string, args: readonly string[]): number {
  return [file, ...args].reduce((n, a) => n + (ctx.win ? winQuotedLength(a) : a.length) + 1, 0);
}

/** The length of one argument after libuv's quote_cmd_arg (CommandLineToArgvW rules). */
function winQuotedLength(a: string): number {
  if (a === "") return 2;
  if (!/[ \t"]/.test(a)) return a.length;
  let n = 2;
  let slashes = 0;
  for (const ch of a) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    n += ch === '"' ? 2 * slashes + 2 : slashes + ch.length;
    slashes = 0;
  }
  return n + 2 * slashes;
}

function buildSpec(
  ctx: Ctx,
  det: DetectedRunner,
  entry: ResolvedEntry,
  F: readonly string[],
  budget: RunnerBudget,
  inputCores: number | undefined,
  notes: string[],
  mode: "related" | "rerun",
  cwd: string,
  gitRoot: string,
  lexical: boolean,
  py: PytestEvidence | undefined,
  crossLink = false,
): ScopedSpec | Unverifiable {
  const C = inputCores ?? ctx.host.cores;
  const xdist = py ? py.xdist : det.xdist;
  const covInConfig = py ? py.covInConfig : det.covInConfig;
  const N = effectiveWorkers(py ? py.userWorkers : det.userWorkers, budget, C);
  const E = entry.prefix;
  const K = det.keptArgs;
  const R = ctx.P.join(ctx.P.resolve(ctx.host.tmpdir), `omr-verify-${ctx.host.randomId()}.${det.kind === "pytest" ? "xml" : "json"}`);
  const env: Record<string, string> = { ...det.env };
  let args: string[];
  let workers: number | null = N;
  const tail = [`--maxWorkers=${N}`];
  if (det.kind === "vitest") {
    const head = mode === "related" ? ["related", ...F, ...K, "--run"] : ["run", ...F, ...K];
    args = [...E, ...head, "--passWithNoTests", ...tail, "--coverage.enabled=false", "--reporter=json", `--outputFile=${R}`];
  } else if (det.kind === "jest") {
    args = [...E, ...K, mode === "related" ? "--findRelatedTests" : "--runTestsByPath", "--passWithNoTests", `--maxWorkers=${N}`, "--coverage=false", "--json", `--outputFile=${R}`, "--", ...F];
  } else {
    args = [
      ...E, ...K, "-q", "-p", "no:cacheprovider", `--junitxml=${R}`, "--maxfail=0",
      ...(py?.pin ?? []),
      ...(xdist ? ["-n", String(N)] : []),
      ...(covInConfig ? ["--no-cov"] : []),
      "--", ...F,
    ];
    env.PYTEST_XDIST_AUTO_NUM_WORKERS = String(N >= 1 ? N : effectiveWorkers({ auto: true }, budget, C));
    workers = xdist ? N : null;
  }
  if (commandLineLength(ctx, entry.file, args) > MAX_ARGV_CHARS) return argvTooLong(F.length);
  return {
    runner: det.kind,
    mode,
    file: entry.file,
    args,
    cwd,
    env,
    reportPath: R,
    gitRoot,
    entry: entry.entry,
    inputs: F,
    inputsAreTests: mode === "rerun" || det.kind === "pytest",
    workers,
    notes,
    ...(lexical ? { lexicalPaths: true as const } : {}),
    ...(crossLink ? { crossLink: true as const } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Functions (Task 1.3.2 implements them; the signatures are the contract)
// ---------------------------------------------------------------------------------------------

/** 1.3.2.a: classify the check command, or the package script behind it (B, C, D). Reads fs only. */
export async function detectRunner(
  command: string,
  cwd: string,
  fs: PlannerFs,
  host?: Partial<RunnerHost>,
): Promise<DetectedRunner | Unverifiable> {
  return detectImpl(makeCtx(host), command, cwd, fs, TEST_HEADS);
}

/**
 * 1.3.2.b: locate the JS bin entry or the native executable (F), walking from cwd up to runner.gitRoot.
 * E2E-2: cwd and gitRoot are canonicalised first (G.3a), as every internal caller does. detectRunner
 * returns a realpath'd gitRoot, so a caller's cwd spelled differently (a win32 8.3 short name such as
 * C:\Users\ABCDEF~1\..., a junction) was never inside it: the walk found nothing and every reference
 * recheck reported "runner not installed".
 */
export async function resolveEntry(
  runner: EntryRequest,
  cwd: string,
  fs: PlannerFs,
  host?: Partial<RunnerHost>,
): Promise<ResolvedEntry | Unverifiable> {
  const ctx = makeCtx(host);
  const req: EntryRequest = { kind: runner.kind, launcher: runner.launcher, gitRoot: await canonicalCwd(ctx, fs, runner.gitRoot) };
  const r = await resolveEntryImpl(ctx, req, await canonicalCwd(ctx, fs, cwd), fs);
  return isS6(r) ? r : r.entry;
}

/** 1.3.2.c: the full planner (B through H), including the section 1.5-5 and pytest searches. */
export async function planScopedRun(input: PlanScopedRunInput): Promise<ScopingPlan> {
  return plan(input, input.search);
}

/** 1.3.2.c: the process-free subset of planScopedRun, for the section 1.5-17 risk signal (O.4). */
export async function planStaticScoping(input: StaticScopingInput): Promise<StaticScoping> {
  return plan(input, undefined);
}

/**
 * 1.3.2.e: run exactly `testFiles` (absolute paths in the tree at `cwd`) with the same runner
 * options and caps (H, rerun rows). Used by S2 rechecks in the reference worktree. 2.2's mode B
 * uses a per-request planScopedRun instead (J). Missing, relative or outside-root files are
 * dropped; when none remain -> NoAffected (M.2).
 */
export async function planRerun(
  runner: DetectedRunner,
  testFiles: readonly string[],
  cwd: string,
  budget: RunnerBudget,
  deps: RerunDeps,
): Promise<ScopedSpec | NoAffected | Unverifiable> {
  const ctx = makeCtx(deps.host);
  const P = ctx.P;
  const absCwd = await canonicalCwd(ctx, deps.fs, cwd);
  const gitRoot = await findGitRoot(ctx, absCwd, deps.fs);
  if (gitRoot === undefined) return s6("no-git-root", `no git repository at or above ${cwd}`);
  const notes: string[] = [];
  const inputs = new Map<string, string>();
  for (const f of testFiles) {
    const lexical = lexicalSpelling(ctx, f);
    const usable = P.isAbsolute(lexical) && !f.includes("\0");
    const ref = usable ? canonicalize(ctx, gitRoot, gitRoot, await realOf(ctx, deps.fs, P.resolve(lexical))) : undefined;
    if (!ref) {
      notes.push(`rerun file dropped (relative or outside the git root): ${f}`);
    } else if (!(await deps.fs.fileExists(ref.abs))) {
      notes.push(`rerun file missing in this tree: ${ref.rel}`);
    } else {
      inputs.set(ctx.key(ref.abs), ref.abs);
    }
  }
  if (inputs.size === 0) return noAffected(NOTE_NO_RERUN);
  const badTmp = await tmpdirCheck(ctx, deps.fs, gitRoot);
  if (badTmp) return badTmp;
  let entry = deps.entry;
  if (!entry) {
    const r = await resolveEntryImpl(ctx, { kind: runner.kind, launcher: runner.launcher, gitRoot }, absCwd, deps.fs);
    if (isS6(r)) return r;
    entry = r.entry;
    notes.push(...r.notes);
  }
  const F = [...inputs.entries()].sort(byKey).map(([, v]) => v);
  const long = pytestArgvFloor(ctx, runner, entry, F);
  if (long) return long;
  const py = await pytestAtInputs(ctx, deps.fs, runner, F, absCwd, notes);
  if (py !== undefined && isS6(py)) return py;
  return buildSpec(ctx, runner, entry, F, budget, deps.cores, notes, "rerun", absCwd, gitRoot, !deps.fs.realpath, py);
}

/** 1.3.2.f: parse the report (or fall back to observeTests) and always delete the report file (I, N.4). */
export async function readResult(
  spec: ScopedSpec,
  execResult: ExecResult,
  fs: RunnerFs,
  host?: Partial<RunnerHost>,
): Promise<RunResult> {
  const ctx = makeCtx(host);
  const P = ctx.P;
  const allowed =
    P.isAbsolute(ctx.host.tmpdir) &&
    P.isAbsolute(spec.reportPath) &&
    ctx.key(P.dirname(P.resolve(spec.reportPath))) === ctx.key(P.resolve(ctx.host.tmpdir)) &&
    REPORT_NAME_RE.test(P.basename(spec.reportPath));
  try {
    if (!allowed) return textResult(ctx, spec, execResult, `report path rejected: ${spec.reportPath}`);
    let text: string | undefined;
    try {
      text = await fs.readFile(spec.reportPath);
    } catch {
      text = undefined; // Missing or unreadable: step 4.
    }
    if (text === undefined) return textResult(ctx, spec, execResult, undefined);
    let parsed: RunResult | undefined;
    try {
      parsed = spec.runner === "pytest" ? parseJunit(ctx, spec, text, execResult.code) : parseJestJson(ctx, spec, text, execResult.code);
    } catch (err) {
      // I step 1 (QA-1.3-12): a parser failure is an unusable report, never a rejection.
      return textResult(ctx, spec, execResult, `report could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parsed ? zeroTestsGuard(spec, parsed) : textResult(ctx, spec, execResult, undefined);
  } finally {
    if (allowed) {
      try {
        await fs.unlink(spec.reportPath);
      } catch {
        // I: unlink errors are ignored; the seam already resolves for a missing file.
      }
    }
  }
}

/** 1.3.2.g: scope a plain eslint invocation to the changed lintable files (K, section 1.5-10). */
export async function planScopedLint(input: PlanScopedLintInput): Promise<LintSpec | NoAffected | Unscoped> {
  const ctx = makeCtx(input.host);
  const P = ctx.P;
  const fs = input.fs;
  if (input.changedFiles === "unavailable") return unscoped("change attribution unavailable");
  if (input.changedFiles.length === 0) return noAffected(NOTE_NO_LINT);
  const det = await detectImpl(ctx, input.command, input.cwd, fs, LINT_HEADS);
  if (isS6(det)) return unscoped(det.reason);
  const notes = [...det.notes];
  const sorted = await collectChanged(ctx, fs, await canonicalCwd(ctx, fs, input.cwd), det.gitRoot, input.changedFiles, notes);
  if (sorted.length === 0) return unscoped(NO_PATH_KEPT);
  const configKeys = new Set((det.configFiles ?? []).map((p) => ctx.key(p)));
  for (const f of sorted) {
    if (namesOf(ctx, f).some((b) => ESLINT_TRIGGER_RE.test(b)) || configKeys.has(ctx.key(f.abs))) return unscoped(`eslint config changed: ${f.rel}`);
  }
  const candidates: string[] = [];
  for (const f of sorted) {
    const inScope = isInside(ctx, det.runnerCwd, f.abs) && (det.pathScopes.length === 0 || det.pathScopes.some((s) => isInside(ctx, s, f.abs)));
    if (inScope && (await fs.fileExists(f.abs))) candidates.push(f.abs);
  }
  if (candidates.length === 0) return noAffected(NOTE_NO_LINT);
  const r = await resolveEntryImpl(ctx, det, det.runnerCwd, fs);
  if (isS6(r)) return unscoped(r.reason);
  const v9 = Number.parseInt(r.entry.version ?? "", 10) >= 9;
  // K (QA-1.3-9): eslint >= 9 decides from its flat config which files it lints, and
  // --no-warn-ignored silences the rest; only older versions need the extension filter.
  const exts = lintExtensions(det.keptArgs);
  const F = v9 ? candidates : candidates.filter((f) => exts.has(P.extname(f).toLowerCase()));
  if (F.length === 0) return noAffected(NOTE_NO_LINT);
  if (!v9 && det.keptArgs.some((a) => a === "--max-warnings" || a.startsWith("--max-warnings="))) {
    return unscoped("eslint <9 cannot scope ignored files under --max-warnings");
  }
  const workers = det.userWorkers ? effectiveWorkers(det.userWorkers, input.budget, input.cores ?? ctx.host.cores) : null;
  const args = [
    ...r.entry.prefix,
    ...det.keptArgs,
    ...(workers !== null ? [`--concurrency=${workers}`] : []),
    ...(v9 ? ["--no-warn-ignored"] : []),
    ...F,
  ];
  if (commandLineLength(ctx, r.entry.file, args) > MAX_ARGV_CHARS) return unscoped(`too many inputs for one command line: ${F.length} files`);
  return {
    runner: "eslint",
    file: r.entry.file,
    args,
    cwd: det.runnerCwd,
    env: det.env,
    gitRoot: det.gitRoot,
    entry: r.entry.entry,
    inputs: F,
    workers,
    notes: [...notes, ...r.notes],
  };
}

// ---------------------------------------------------------------------------------------------
// I. Result parsing and K. lint helpers
// ---------------------------------------------------------------------------------------------

function unscoped(reason: string): Unscoped {
  return { unscoped: true, reason };
}

const ESLINT_TRIGGER_RE = new RegExp(String.raw`^(?:eslint\.config\..+|\.eslintrc|\.eslintrc\..+|\.eslintignore|package\.json|tsconfig.*\.json|${JS_DEPS})$`);
const DEFAULT_LINT_EXTS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"];

/** K: the --ext values (comma-separated, leading dots optional), or the defaults. */
function lintExtensions(kept: readonly string[]): Set<string> {
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const t = kept[i];
    const v = t === "--ext" ? kept[++i] : t.startsWith("--ext=") ? t.slice(6) : undefined;
    for (const x of (v ?? "").split(",")) if (x) out.push(`.${x.replace(/^\./, "")}`.toLowerCase());
  }
  return new Set(out.length > 0 ? out : DEFAULT_LINT_EXTS);
}

/** Dedup, sort and apply the I "exit code but no failure" rule. */
function finishResult(
  ids: Set<string>,
  files: Set<string>,
  collectionError: boolean,
  total: number | undefined,
  code: number,
  forced: string | undefined,
  exitOk: boolean,
  testsByFile: Readonly<Record<string, number>>,
): RunResult {
  const silent = !exitOk && ids.size === 0 && !collectionError;
  const note = forced ?? (silent ? `runner exited ${code} but its report lists no failure` : undefined);
  return {
    failingIds: [...ids].sort(),
    failingFiles: [...files].sort(),
    collectionError,
    total,
    complete: forced === undefined && !silent,
    source: "report",
    ...(note !== undefined ? { note } : {}),
    testsByFile,
  };
}

/** P1: add `n` tests to a file key (a null-prototype record, so a key like "__proto__" is safe). */
function addCount(counts: Record<string, number>, key: string, n: number): void {
  counts[key] = (counts[key] ?? 0) + n;
}

/** I step 2: the jest-compatible JSON of vitest and jest. undefined = unusable. */
function parseJestJson(ctx: Ctx, spec: ScopedSpec, text: string, code: number): RunResult | undefined {
  const P = ctx.P;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(v) || !Array.isArray(v.testResults)) return undefined;
  const ids = new Set<string>();
  const files = new Set<string>();
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  let collectionError = typeof v.numRuntimeErrorTestSuites === "number" && v.numRuntimeErrorTestSuites > 0;
  for (const s of v.testResults.filter(isRecord)) {
    if (typeof s.name !== "string") continue;
    const rel = relSlash(ctx, spec.cwd, s.name);
    const results = Array.isArray(s.assertionResults) ? s.assertionResults.filter(isRecord) : [];
    addCount(counts, rel, results.length);
    const failed = results.filter((a) => a.status === "failed");
    for (const a of failed) {
      const titles = Array.isArray(a.ancestorTitles) ? a.ancestorTitles.map(String) : [];
      ids.add(`${rel} > ${[...titles, String(a.title)].join(" > ")}`);
    }
    if (s.status === "failed" && failed.length === 0) {
      ids.add(rel);
      collectionError = true;
    }
    if (s.status === "failed" || failed.length > 0) files.add(P.normalize(s.name));
  }
  const total = typeof v.numTotalTests === "number" ? v.numTotalTests : undefined;
  return finishResult(ids, files, collectionError, total, code, undefined, code === 0, counts);
}

/**
 * QA-1.3-35: `P.relative(base, p)` with "/" separators, as readResult ids need it, without calling
 * P.relative when `p` lies plainly below `base`: the same prefix (either separator; case-insensitive
 * on win32) followed by a tail with no empty, "." or ".." segment. That tail is exactly what
 * P.relative returns there, and it avoids Bun's path.win32.relative (about 13 times slower than
 * node's: 20000 calls took 953 ms). Anything else goes through P.relative.
 */
function relSlash(ctx: Ctx, base: string, p: string): string {
  const norm = (s: string) => (ctx.win ? s.replace(/\//g, "\\") : s);
  const b = norm(base);
  const q = norm(p);
  const sep = ctx.win ? "\\" : "/";
  const head = b.endsWith(sep) ? b : b + sep;
  if (q.length > head.length && ctx.key(q.slice(0, head.length)) === ctx.key(head)) {
    const tail = q.slice(head.length);
    if (tail.split(sep).every((s) => s !== "" && s !== "." && s !== "..")) return tail.replace(/\\/g, "/");
  }
  return ctx.P.relative(base, p).replace(/\\/g, "/");
}

/** A test path by the G.8 JS rule: a .test/.spec file or a file under __tests__. */
function isJsTestPath(p: string): boolean {
  return JS_TEST_RE.test(p.split(/[\\/]/).pop() ?? "") || p.split(/[\\/]/).includes("__tests__");
}

/**
 * I step 2a (QA-1.3-1, QA-1.3-19): a report that lists no test at all is not trusted when the
 * inputs say tests must have run, for every runner: a rerun, inputs that are test files (pytest,
 * or a JS test file given to related), and any spec planned without realpath (jest and vitest
 * both match nothing through a junction cwd).
 */
function zeroTestsGuard(spec: ScopedSpec, r: RunResult): RunResult {
  if (r.total !== 0 || !r.complete || r.failingIds.length > 0 || r.collectionError || spec.inputs.length === 0) return r;
  const note =
    spec.mode === "rerun"
      ? "rerun ran no tests although every input is a test file"
      : spec.inputsAreTests || spec.inputs.some(isJsTestPath)
        ? `${spec.runner} ran no tests although a test file was passed`
        : spec.lexicalPaths === true
          ? `${spec.runner} ran no tests and the paths were not canonicalized (no realpath seam)`
          : undefined;
  return note === undefined ? r : { ...r, complete: false, note };
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** A code point String.fromCodePoint accepts and XML allows to be a character reference. */
function isXmlCodePoint(n: number): boolean {
  return Number.isSafeInteger(n) && ((n >= 0 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0x10ffff));
}

/** I step 3 (QA-1.3-12): out-of-range numeric references stay literal text instead of throwing. */
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, g: string) => {
    if (!g.startsWith("#")) return XML_ENTITIES[g];
    const n = g.startsWith("#x") ? Number.parseInt(g.slice(2), 16) : Number(g.slice(1));
    return isXmlCodePoint(n) ? String.fromCodePoint(n) : m;
  });
}

/**
 * I step 3 (QA-2.2-1): the rootdir pytest's classnames are relative to, when spec.args names it:
 * the last `--rootdir=<v>` or `--rootdir <v>`, resolved against spec.cwd as pytest resolves it.
 * undefined when the argv gives none or an empty one, or a value pytest would expand.
 */
function junitRootdir(ctx: Ctx, spec: ScopedSpec): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < spec.args.length; i++) {
    const a = spec.args[i];
    if (a === "--") break;
    if (a === "--rootdir") value = spec.args[++i];
    else if (a.startsWith("--rootdir=")) value = a.slice("--rootdir=".length);
  }
  if (value === undefined || value === "" || value.includes("$") || (ctx.win && value.includes("%"))) return undefined;
  return ctx.P.resolve(spec.cwd, value);
}

/** A junit classname's resolution: one input, none, or more than one (QA-2.2-1: never charged). */
type JunitHit = { readonly file: string; readonly rest: string[] } | "ambiguous" | undefined;

/**
 * I step 3: pytest junit XML, parsed without an XML library. undefined = unusable (truncated or
 * malformed). QA-1.3-25: linear in the report and the inputs. Each input's keys are put in a map
 * once (a key two inputs share is marked ambiguous), a classname walks its own dot prefixes once
 * (memoized per classname), and testcases are found with indexOf, never a backtracking regex.
 */
function parseJunit(ctx: Ctx, spec: ScopedSpec, text: string, code: number): RunResult | undefined {
  if (!text.includes("</testsuites>")) return undefined;
  // QA-2.2-1: key -> the one input it names, or null when two inputs share it.
  const keys = new Map<string, string | null>();
  const addKey = (d: string, f: string) => {
    const had = keys.get(d);
    if (had === undefined) keys.set(d, f);
    else if (had !== f) keys.set(d, null);
  };
  const rootdir = junitRootdir(ctx, spec);
  for (const f of spec.inputs) {
    if (rootdir !== undefined) {
      const rel = relSlash(ctx, rootdir, f);
      // An input outside the rootdir has no classname pytest would write for it.
      if (rel === "" || rel === ".." || rel.startsWith("../") || ctx.P.isAbsolute(rel)) continue;
      addKey(rel.replace(/\.py$/, "").split("/").join("."), f);
      continue;
    }
    const segs = relSlash(ctx, spec.gitRoot, f).replace(/\.py$/, "").split("/");
    for (let i = 0; i < segs.length; i++) addKey(segs.slice(i).join("."), f);
  }
  const hits = new Map<string, JunitHit>();
  const map = (dotted: string): JunitHit => {
    if (hits.has(dotted)) return hits.get(dotted);
    let hit: JunitHit;
    for (let d = dotted; ; ) {
      const file = keys.get(d);
      if (file === null || (file !== undefined && hit !== undefined)) {
        hit = "ambiguous";
        break;
      }
      if (file !== undefined) hit = { file, rest: dotted.slice(d.length + 1).split(".").filter(Boolean) };
      const dot = d.lastIndexOf(".");
      if (dot < 0) break;
      d = d.slice(0, dot);
    }
    hits.set(dotted, hit);
    return hit;
  };
  // QA-1.3-35: at most one relativisation per input file, however many cases fail in it.
  const rels = new Map<string, string>();
  const relOf = (f: string) => {
    let r = rels.get(f);
    if (r === undefined) {
      r = relSlash(ctx, spec.cwd, f);
      rels.set(f, r);
    }
    return r;
  };
  const ids = new Set<string>();
  const files = new Set<string>();
  let collectionError = false;
  let total = 0;
  let unmapped: string | undefined;
  let ambiguous: string | undefined;
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  // P1: raw classname attribute -> the file key it maps to (null when unmapped or ambiguous), decoded once each.
  const classKeys = new Map<string, string | null>();
  const countCase = (attrs: string) => {
    let raw = "";
    for (const a of attrs.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      if (a[1] === "classname") {
        raw = a[2];
        break;
      }
    }
    let key = classKeys.get(raw);
    if (key === undefined) {
      const classname = decodeXml(raw);
      const hit = map(classname);
      // QA-2.2-1: a passing case two inputs answer is charged to neither, and the run is not trusted.
      if (hit === "ambiguous") ambiguous ??= classname;
      key = hit !== undefined && hit !== "ambiguous" ? relOf(hit.file) : null;
      classKeys.set(raw, key);
    }
    if (key !== null) addCount(counts, key, 1);
  };
  const cases = junitCases(text);
  if (!cases) return undefined;
  for (const c of cases) {
    const body = c.body;
    // QA-1.3-22: only the collection-failure <error> marks a collection case. pytest also writes
    // classname="" for a test outside its rootdir (-c elsewhere, --rootdir), which is a real test.
    const collection = /<error\b[^>]*\bmessage="collection failure"/.test(body);
    // QA-1.3-35: a passing case only counts; its attributes are never decoded (only its classname,
    // once per distinct value, for the per-file counts).
    if (!collection) {
      total++;
      countCase(c.attrs);
      if (!/<(?:failure|error)\b/.test(body)) continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of c.attrs.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = decodeXml(a[2]);
    const classname = attrs.classname ?? "";
    const name = attrs.name ?? "";
    if (collection) {
      collectionError = true;
      const target = classname || name;
      const hit = map(target);
      if (hit !== undefined && hit !== "ambiguous") {
        ids.add(relOf(hit.file));
        files.add(hit.file);
      } else {
        ids.add(target);
        if (hit === "ambiguous") ambiguous ??= target;
        else unmapped ??= target;
      }
      continue;
    }
    const hit = map(classname);
    if (hit !== undefined && hit !== "ambiguous") {
      ids.add(`${relOf(hit.file)}::${[...hit.rest, name].join("::")}`);
      files.add(hit.file);
    } else {
      ids.add(`${classname}::${name}`);
      if (hit === "ambiguous") ambiguous ??= classname;
      else unmapped ??= classname === "" ? `"" (${name})` : classname;
    }
  }
  const forced =
    code === 4
      ? "pytest usage error (exit 4)"
      : code === 3
        ? "pytest internal error (exit 3)"
        : unmapped !== undefined
          ? `pytest classname not mapped to a test file: ${unmapped}`
          : ambiguous !== undefined
            ? `pytest classname maps to more than one test file: ${ambiguous}`
            : undefined;
  return finishResult(ids, files, collectionError, total, code, forced, code === 0 || code === 5, counts);
}

/**
 * QA-1.3-25: the <testcase> elements of a junit report, in one forward pass. A non-self-closing
 * testcase whose `</testcase>` is missing, or that contains another `<testcase`, makes the report
 * malformed (undefined), never a silently skipped case: pytest writes neither, a test that
 * rewrites its own report can. Attributes are assumed to hold no literal ">" (pytest escapes it).
 */
function junitCases(text: string): { attrs: string; body: string }[] | undefined {
  const out: { attrs: string; body: string }[] = [];
  let pos = 0;
  for (;;) {
    const start = text.indexOf("<testcase", pos);
    if (start < 0) return out;
    pos = start + 9;
    if (!/^[\s/>]/.test(text.slice(pos, pos + 1))) continue;
    const tagEnd = text.indexOf(">", pos);
    if (tagEnd < 0) return undefined;
    if (text[tagEnd - 1] === "/") {
      out.push({ attrs: text.slice(pos, tagEnd - 1), body: "" });
      pos = tagEnd + 1;
      continue;
    }
    // Each search starts after the previous case's end tag, so the whole pass stays linear.
    const close = text.indexOf("</testcase>", tagEnd);
    if (close < 0) return undefined;
    const body = text.slice(tagEnd + 1, close);
    if (body.includes("<testcase")) return undefined;
    out.push({ attrs: text.slice(pos, tagEnd), body });
    pos = close + 11;
  }
}

/** I step 4: no usable report; the text observation is never a complete inventory. */
function textResult(ctx: Ctx, spec: ScopedSpec, execResult: ExecResult, why: string | undefined): RunResult {
  const obs = observeTests(execResult);
  const files = new Set<string>();
  for (const id of obs.failures) {
    const m = /^(.*?)(?: > |::)/.exec(id);
    if (m) files.add(ctx.P.resolve(spec.cwd, m[1]));
  }
  const note =
    why ?? (execResult.code === 0 ? "runner exited 0 without writing its report" : `runner exited ${execResult.code} without a usable report`);
  return {
    failingIds: [...new Set(obs.failures)].sort(),
    failingFiles: [...files].sort(),
    collectionError: execResult.code !== 0,
    total: undefined,
    complete: false,
    source: "text",
    note,
  };
}

/** Section E: the single worker-cap rule shared by every runner. It never exceeds the budget. */
export function effectiveWorkers(user: UserWorkerCap | undefined, budget: RunnerBudget, cores: number): number {
  const B = Number.isSafeInteger(budget.maxWorkers) && budget.maxWorkers >= 1 ? budget.maxWorkers : 1;
  const C = Number.isSafeInteger(cores) && cores >= 1 ? cores : 1;
  if (!user) return B;
  if ("count" in user) return Number.isSafeInteger(user.count) && user.count >= 0 ? Math.min(user.count, B) : B;
  if ("percent" in user) {
    if (!(user.percent >= 1 && user.percent <= 100)) return B;
    return Math.min(Math.max(1, Math.ceil((user.percent * C) / 100)), B);
  }
  return Math.min(C, B);
}
